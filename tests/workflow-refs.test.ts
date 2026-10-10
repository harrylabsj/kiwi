import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync, renameSync } from "node:fs";
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

describe("merchant-cloud protected portfolio release", () => {
  it("builds and signs the cloud package into its dedicated artifact path", () => {
    const doc = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8")) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const build = doc.jobs["build-once"];
    const runs = (build?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(runs).toContain("node scripts/build-npm-shipping.mjs");
    expect(runs).toContain("node scripts/smoke-cloud-artifact.mjs --json");
    expect(runs).toContain("node scripts/build-cloud-package.mjs");
    expect(runs).toContain("release/npm/kiwi-merchant-cloud");
    expect(runs).toContain("npm run verify:cloud-release-candidate");
  });

  it("keeps the cloud npm publisher protected and includes it in registry verification", () => {
    const doc = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8")) as {
      jobs: Record<string, {
        if?: string;
        environment?: string;
        permissions?: Record<string, string>;
        needs?: string[];
        steps?: Array<{ run?: string }>;
      }>;
    };
    const publish = doc.jobs["publish-kiwi-merchant-cloud"];
    expect(publish?.if).toBe("inputs.publish == true");
    expect(publish?.environment).toBe("kiwi-release");
    expect(publish?.permissions?.["id-token"]).toBe("write");
    expect(publish?.steps?.map((step) => step.run ?? "").join("\n")).toContain("npm publish \"${TARBALL}\" --provenance --access public");
    expect(doc.jobs["verify-registry"]?.needs).toContain("publish-kiwi-merchant-cloud");
    expect(doc.jobs["verify-registry"]?.steps?.map((step) => step.run ?? "").join("\n")).toContain("verify-registry-downloads.mjs");
  });
});


describe("default release npm 12 toolchain contract", () => {
  it("keeps all five protected publishers and the registry dependency set", () => {
    const doc = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8"));
    const publishers = ["publish-npm", "publish-dsh-plugin", "publish-kiwi-merchant-cloud", "publish-kiwi-catalog", "publish-shopping-cli"];
    expect(doc.on.workflow_dispatch.inputs.publish.default).toBe(false);
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).not.toContain("publication_scope");
    expect(doc.concurrency).toEqual({ group: "portfolio-release", "cancel-in-progress": false });
    for (const name of publishers) {
      expect(doc.jobs[name].if).toBe("inputs.publish == true");
      expect(doc.jobs[name].environment).toBe("kiwi-release");
      expect(doc.jobs[name].permissions["id-token"]).toBe("write");
    }
    expect(doc.jobs["verify-registry"].needs).toEqual(publishers);
  });

  it("uses pinned Node and normal npm 12 before build, publish and registry npm commands", () => {
    const doc = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8"));
    for (const name of ["build-once", "publish-npm", "publish-dsh-plugin", "publish-kiwi-merchant-cloud", "verify-registry", "rollback-verify"]) {
      const steps = doc.jobs[name].steps;
      const node = steps.find((s: { uses?: string }) => s.uses?.startsWith("actions/setup-node@"));
      expect(node.with["node-version"]).toBe("22.22.3");
      const setupIndex = steps.findIndex((s: { name?: string }) => s.name === "Setup npm 12 and verify the install toolchain");
      expect(setupIndex).toBeGreaterThan(-1);
      expect(steps[setupIndex].run).toBe('npm install --global npm@12.0.2\nnode scripts/check-install-toolchain.mjs "$(npm --version)"\n');
      const later = steps.slice(setupIndex + 1).map((s: { run?: string }) => s.run ?? "").join("\n");
      const expectedCommand = name === "build-once" ? "npm ci"
        : name === "verify-registry" ? "node scripts/verify-registry-downloads.mjs"
        : name === "rollback-verify" ? "node scripts/verify-rollback-candidate.mjs"
        : "npm publish";
      expect(later).toContain(expectedCommand);
    }
    const source = readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8");
    expect(source).not.toMatch(/ignore-scripts|npm@11|npm_config_user_agent|publication_scope/);
    const build = doc.jobs["build-once"].steps.map((s: { run?: string }) => s.run ?? "").join("\n");
    expect(build).toContain("npm ci\nnode scripts/verify-npm-shipping-source.mjs");
    expect(build).toContain("node scripts/build-npm-shipping.mjs");
    expect(build).not.toContain("build-cloud-artifact.mjs");
    for (const name of ["publish-npm", "publish-kiwi-merchant-cloud"]) {
      const runs = doc.jobs[name].steps.map((s: { run?: string }) => s.run ?? "").join("\n");
      expect(runs).not.toMatch(/build-npm-shipping|npm run build|npm ci/);
      expect(runs).toContain("--provenance --access public");
    }
  });
});


it("ordinary quality CI preserves required checks with npm 12 before ci", () => {
  const doc = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "ci.yml"), "utf8"));
  expect(Object.keys(doc.jobs)).toEqual(["quality"]);
  expect(doc.permissions).toEqual({ contents: "read" });
  const steps = doc.jobs.quality.steps;
  expect(steps.find((s: { uses?: string }) => s.uses?.startsWith("actions/setup-node@")).with["node-version"]).toBe("22.22.3");
  const setup = steps.findIndex((s: { name?: string }) => s.name === "Setup npm 12 and verify the install toolchain");
  const ci = steps.findIndex((s: { run?: string }) => s.run === "npm ci");
  expect(setup).toBeGreaterThan(-1);
  expect(ci).toBeGreaterThan(setup);
  expect(steps[setup].run).toContain('node scripts/check-install-toolchain.mjs "$(npm --version)"');
  expect(steps.filter((s: { run?: string }) => s.run?.startsWith("npm run ")).map((s: { run: string }) => s.run)).toEqual([
    "npm run lint", "npm run typecheck", "npm run build", "npm run test", "npm run verify:contracts", "npm run verify:vectors",
  ]);
});


it("release receipt wrapper and ancestry guard are reached through the default build", () => {
  const release = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8"));
  const buildSteps = release.jobs["build-once"].steps;
  expect(buildSteps.find((s: { name?: string }) => s.name === "Checkout central source").with["fetch-depth"]).toBe(0);
  const quality = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "ci.yml"), "utf8"));
  expect(quality.jobs.quality.steps[0].with["fetch-depth"]).toBe(0);
  const runs = buildSteps.map((s: { run?: string }) => s.run ?? "").join("\n");
  const wrapper = runs.indexOf("node scripts/verify-npm-shipping-source.mjs");
  expect(wrapper).toBeGreaterThan(runs.indexOf("npm ci"));
  expect(runs.indexOf("npm pack --pack-destination release/npm")).toBeGreaterThan(wrapper);
  expect(runs.indexOf("node scripts/build-npm-shipping.mjs")).toBeGreaterThan(wrapper);
  const cold = runs.indexOf("node scripts/verify-npm-shipping-installed.mjs");
  expect(cold).toBeGreaterThan(runs.indexOf("npm run verify:cloud-release-candidate"));
  expect(cold).toBeLessThan(runs.indexOf("cosign sign-blob"));
  const source = readFileSync(join(process.cwd(), "scripts/verify-npm-shipping-source.mjs"), "utf8");
  expect(source).toContain('npm(root, ["run", "verify"], MAX_MS)');
  expect(source).toContain("throw error");
  expect(source.indexOf("publishBuildReceipt(file, receipt)")).toBeGreaterThan(source.indexOf("throw error"));
  // This checks wiring/control structure; it does not claim fullverify ran.
});


it("finishes npm validation before consumer installs and preserves every later portfolio gate", () => {
  const doc = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8"));
  const steps = doc.jobs["build-once"].steps;
  const names = steps.map((s: { name?: string }) => s.name ?? "");
  const full = names.indexOf("Kiwi full verify (lint, typecheck, build, test, contracts, vectors, package smoke)");
  const early = names.indexOf("Build and verify npm candidates before consumer installs");
  const catalog = names.indexOf("Kiwi-catalog locked install, contract lock, and deterministic tests");
  const shopping = names.indexOf("Shopping-cli locked install, contract lock, and deterministic tests");
  const conformance = names.indexOf("Run shared Python service conformance");
  const late = names.indexOf("Build release candidates and evidence once");
  expect(early).toBeGreaterThan(full);
  expect(catalog).toBeGreaterThan(early);
  expect(shopping).toBeGreaterThan(catalog);
  expect(conformance).toBeGreaterThan(shopping);
  expect(late).toBeGreaterThan(conformance);
  const earlyRun = steps[early].run;
  const lateRun = steps[late].run;
  expect(earlyRun).toContain("rm -rf release");
  expect(earlyRun).not.toMatch(/cp portfolio|uv sync|python -m build/);
  expect(lateRun).not.toMatch(/rm -rf release|build-npm-shipping|build-cloud-package|verify-npm-shipping-installed|pack --pack-destination release\/npm/);
  for (const text of ["cp portfolio.lock.json", "cp portfolio-products.json", "kiwi-dsh-plugin", "uv sync --locked", "build-portfolio-release-index", "SHA256SUMS"]) expect(lateRun).toContain(text);
  expect(steps[catalog].run).toContain("pytest -q");
  expect(steps[shopping].run).toContain("pytest -q");
  expect(steps[shopping].run).toContain("node --test tests/shopping_plugin.test.mjs");
});

describe("default release same-run npm checkpoint", () => {
  const workflow = YAML.parse(readFileSync(join(WORKFLOWS_DIR, "portfolio-release.yml"), "utf8"));
  const steps = workflow.jobs["build-once"].steps;
  const early = steps.find((s: { name?: string }) => s.name === "Build and verify npm candidates before consumer installs").run;
  const late = steps.find((s: { name?: string }) => s.name === "Build release candidates and evidence once").run;
  const block = (run: string) => run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)![1]!;
  const run = (code: string, cwd: string) => execFileSync(process.execPath, [...process.execArgv], { cwd, input: code, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  const rootFile = "harrylabsj-kiwi-0.12.4.tgz";
  const cloudFile = "harrylabsj-kiwi-merchant-cloud-0.12.4.tgz";
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "workflow-npm-checkpoint-"));
    mkdirSync(join(dir, "packages/merchant-cloud"), { recursive: true });
    mkdirSync(join(dir, "release/npm/kiwi-merchant-cloud"), { recursive: true });
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@harrylabsj/kiwi", version: "0.12.4" }));
    writeFileSync(join(dir, "packages/merchant-cloud/package.json"), JSON.stringify({ name: "@harrylabsj/kiwi-merchant-cloud", version: "0.12.4" }));
    // Opaque fixture bytes: tests snapshot integrity, not npm archive validity.
    writeFileSync(join(dir, "release/npm", rootFile), "synthetic-root-tgz");
    writeFileSync(join(dir, "release/npm/kiwi-merchant-cloud", cloudFile), "synthetic-cloud-tgz");
    return dir;
  }
  it("records once after cold validation and verifies unchanged exact bytes before signing", () => {
    const dir = fixture();
    try {
      expect(early.indexOf("npm-shipping-artifact-checkpoint.json")).toBeGreaterThan(early.indexOf("verify-npm-shipping-installed.mjs"));
      expect(late.indexOf("npm checkpoint changed before signing")).toBeLessThan(late.indexOf("build-portfolio-release-index.mjs"));
      run(block(early), dir);
      const before = readFileSync(join(dir, "build/npm-shipping-artifact-checkpoint.json"));
      expect(JSON.parse(before.toString()).files).toHaveLength(2);
      expect(() => run(block(early), dir)).toThrow();
      run(block(late), dir);
      expect(readFileSync(join(dir, "build/npm-shipping-artifact-checkpoint.json"))).toEqual(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["changed", "extra", "missing", "symlink", "directory", "release-parent", "unsafe-metadata"])("refuses %s at the late checkpoint instead of rebuilding", mode => {
    const dir = fixture();
    try {
      run(block(early), dir);
      const file = join(dir, "release/npm", rootFile);
      if (mode === "changed") appendFileSync(file, "changed");
      if (mode === "extra") writeFileSync(join(dir, "release/npm/extra.tgz"), "extra");
      if (mode === "missing") rmSync(file);
      if (mode === "symlink") { renameSync(file, join(dir, "outside-fixture")); symlinkSync(join(dir, "outside-fixture"), file); }
      if (mode === "directory") { renameSync(join(dir, "release/npm/kiwi-merchant-cloud"), join(dir, "outside-cloud")); symlinkSync(join(dir, "outside-cloud"), join(dir, "release/npm/kiwi-merchant-cloud")); }
      if (mode === "release-parent") { renameSync(join(dir, "release"), join(dir, "outside-release")); symlinkSync(join(dir, "outside-release"), join(dir, "release")); }
      if (mode === "unsafe-metadata") writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@harrylabsj/kiwi", version: "../escape" }));
      expect(() => run(block(late), dir)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
