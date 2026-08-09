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

  it("release lock-match step requires the publish ref to equal portfolio.lock.json repositories.kiwi.commit", () => {
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
    const lockMatch = steps.find((s) => s.name?.includes("Verify central ref matches portfolio lock"));
    expect(lockMatch).toBeDefined();

    // ref, publish, and the lock output all flow through env, never shell-interpolated.
    expect(lockMatch!.env).toEqual(
      expect.objectContaining({
        REF_INPUT: "${{ inputs.ref }}",
        PUBLISH_INPUT: "${{ inputs.publish }}",
        LOCKED_KIWI_SHA: "${{ steps.lock.outputs.kiwi_sha }}",
      }),
    );

    const run = lockMatch!.run ?? "";
    expect(run).not.toMatch(/\$\{\{\s*(inputs|steps)\.[^}]*\}\}/);

    // Execute the exact lock-match shell block against the ref/publish/lock matrix.
    const runWith = (ref: string, publish: string, locked: string): void => {
      execFileSync("/bin/bash", ["-c", run], {
        env: { ...process.env, REF_INPUT: ref, PUBLISH_INPUT: publish, LOCKED_KIWI_SHA: locked },
        stdio: "pipe",
      });
    };

    const LOCKED_SHA = "0123456789abcdef0123456789abcdef01234567";
    const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

    // publish=true accepts the ref only when it exactly matches the locked kiwi commit.
    expect(() => runWith(LOCKED_SHA, "true", LOCKED_SHA)).not.toThrow();

    // publish=true with a central ref different from the lock fails closed.
    expect(() => runWith(OTHER_SHA, "true", LOCKED_SHA)).toThrow(/does not match portfolio\.lock\.json/);

    // publish=true with no repositories.kiwi.commit in the lock fails closed.
    expect(() => runWith(OTHER_SHA, "true", "")).toThrow(/no repositories\.kiwi\.commit/);

    // Dry-run keeps named refs allowed and does not require a lock match, even
    // when the lock SHA is absent.
    expect(() => runWith("main", "false", LOCKED_SHA)).not.toThrow();
    expect(() => runWith("main", "false", "")).not.toThrow();
  });
});
