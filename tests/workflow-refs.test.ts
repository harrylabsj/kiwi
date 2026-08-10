import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const WORKFLOWS_DIR = join(process.cwd(), ".github", "workflows");
const USES_RE = /^\s*(?:-\s+)?uses:\s*([^\s]+)/gm;
const FULL_SHA = /^[0-9a-f]{40}$/;

describe("GitHub workflow action refs", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml"));

  it("every workflow has at least one job", () => {
    for (const file of files) {
      const src = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      expect(src).toMatch(/jobs:/);
    }
  });

  it("all uses refs are full 40-character SHAs (no mutable tags)", () => {
    for (const file of files) {
      const src = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      const matches = [...src.matchAll(USES_RE)];
      expect(matches.length).toBeGreaterThan(0);
      for (const match of matches) {
        const ref = match[1];
        expect(ref, `${file}: missing uses ref`).toBeTruthy();
        const sha = ref!.slice(ref!.indexOf("@") + 1);
        expect(FULL_SHA.test(sha), `${file}: mutable/non-SHA ref ${ref}`).toBe(true);
      }
    }
  });

  it("public sibling checkouts do not persist credentials", () => {
    const portfolioWorkflowFiles = [
      "portfolio-integration.yml",
      "portfolio-contracts.yml",
      "release-rehearsal.yml",
      "supply-chain-rehearsal.yml",
      "portfolio-release.yml",
    ];
    for (const file of portfolioWorkflowFiles) {
      const src = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      const doc = YAML.parse(src) as {
        jobs?: Record<string, {
          steps?: Array<{
            name?: string;
            run?: string;
            env?: Record<string, string>;
            with?: Record<string, string>;
          }>;
        }>;
      };
      const steps = Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);
      const siblingCheckouts = steps.filter((step) =>
        /^(?:harrylabsj\/kiwi-catalog|harrylabsj\/shopping-cli)$/.test(step.with?.repository ?? ""),
      );
      expect(siblingCheckouts, `${file} must checkout both public sibling repositories`).toHaveLength(2);
      for (const checkout of siblingCheckouts) {
        expect(checkout.with?.token, `${file} sibling checkout must not use a static token`).toBeUndefined();
        expect(checkout.with?.["persist-credentials"], `${file} sibling checkout must not persist credentials`).toBe(false);
      }
    }
  });

  it("the protected release workflow is dispatch-only and defaults publish=false", () => {
    const src = readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8");
    expect(src).toMatch(/workflow_dispatch/);
    // No push / pull_request / schedule triggers.
    expect(src).not.toMatch(/^\s*push:/m);
    expect(src).not.toMatch(/^\s*pull_request:/m);
    expect(src).not.toMatch(/^\s*schedule:/m);
    expect(src).toMatch(/default:\s*false/);
    expect(src).toMatch(/inputs\.publish == true/);
    expect(src).toMatch(/environment:\s*kiwi-release/);
  });

  it("release workflow never shell-interpolates dispatch inputs or step outputs in run blocks", () => {
    const src = readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8");
    const doc = YAML.parse(src) as {
      jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const steps = Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      if (typeof step.run !== "string") continue;
      expect(
        step.run,
        `run block in '${step.name ?? "<unnamed>"}' must pass inputs/step outputs through env, not interpolate them into the shell`,
      ).not.toMatch(/\$\{\{\s*(inputs|steps)\.[^}]*\}\}/);
    }
  });

  it("release validation step requires a full 40-char lowercase commit SHA when publish=true", () => {
    const src = readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8");
    const doc = YAML.parse(src) as {
      jobs?: Record<
        string,
        {
          steps?: Array<{
            name?: string;
            run?: string;
            env?: Record<string, string>;
          }>;
        }
      >;
    };
    const steps = Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const validate = steps.find((s) => s.name?.includes("Validate central ref"));
    expect(validate).toBeDefined();

    // publish is passed through env, never shell-interpolated.
    expect(validate!.env).toEqual(
      expect.objectContaining({
        REF_INPUT: "${{ inputs.ref }}",
        PUBLISH_INPUT: "${{ inputs.publish }}",
      }),
    );

    const run = validate!.run ?? "";
    expect(run).not.toMatch(/\$\{\{\s*(inputs|steps)\.[^}]*\}\}/);

    // Execute the exact validation shell block against the ref/publish matrix.
    const runWith = (ref: string, publish: string): void => {
      execFileSync("/bin/bash", ["-c", run], {
        env: { ...process.env, REF_INPUT: ref, PUBLISH_INPUT: publish },
        stdio: "pipe",
      });
    };

    const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";
    const SHORT_SHA = "0123456";
    const UPPER_SHA = "0123456789ABCDEF0123456789ABCDEF01234567";

    // Full lowercase SHA is accepted for both dry-run and publish.
    expect(() => runWith(FULL_SHA, "false")).not.toThrow();
    expect(() => runWith(FULL_SHA, "true")).not.toThrow();

    // Named refs are allowed for dry-run (publish=false) only.
    expect(() => runWith("main", "false")).not.toThrow();
    expect(() => runWith("main", "true")).toThrow(/publish=true requires ref/);

    // Short SHAs are always rejected regardless of publish mode.
    expect(() => runWith(SHORT_SHA, "false")).toThrow(/short SHA/);
    expect(() => runWith(SHORT_SHA, "true")).toThrow(/short SHA/);

    // Uppercase 40-char hex is not a lowercase commit SHA; publish=true rejects it.
    expect(() => runWith(UPPER_SHA, "true")).toThrow(/publish=true requires ref/);
  });

  it("release workflow has no 'Verify central ref matches portfolio lock' self-match step", () => {
    const src = readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8");
    const doc = YAML.parse(src) as {
      jobs?: Record<string, { steps?: Array<{ name?: string }> }>;
    };
    const steps = Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const selfMatch = steps.find((s) => s.name?.includes("Verify central ref matches portfolio lock"));
    expect(selfMatch).toBeUndefined();
  });

  const LOCK_CONSUMING_WORKFLOWS = [
    "portfolio-integration.yml",
    "portfolio-release.yml",
    "release-rehearsal.yml",
    "supply-chain-rehearsal.yml",
    "portfolio-contracts.yml",
  ];

  it("every portfolio-lock-consuming workflow fails closed on non-40-char SHAs before checkout", () => {
    for (const file of LOCK_CONSUMING_WORKFLOWS) {
      const src = readFileSync(join(WORKFLOWS_DIR, file), "utf8");
      expect(src, `${file} must reject non-40-char SHAs from portfolio.lock.json`).toMatch(
        /not a full 40-char SHA/,
      );
    }
  });

  it("portfolio-contracts verify step checks both consumer source_commit and bundle_sha256", () => {
    const src = readFileSync(join(WORKFLOWS_DIR, "portfolio-contracts.yml"), "utf8");
    expect(src).toMatch(/lock\.source_commit !== portfolio\.contract_source_commit/);
    expect(src).toMatch(/lock\.bundle_sha256 !== portfolio\.contract_bundle_sha256/);
  });
});
