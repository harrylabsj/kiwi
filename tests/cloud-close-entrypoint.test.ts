import { describe, expect, it, afterEach } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCloudShutdown, isNodeBelowSupportLine } from "../src/cloud/main.js";
import { renderStartupFailure, CloudStartupError } from "../src/cloud/bootstrap.js";

const dirs: string[] = [];
afterEach(() => { for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "kiwi-main-close-")); dirs.push(root);
  mkdirSync(path.join(root, "cloud")); mkdirSync(path.join(root, "lifecycle"));
  copyFileSync(path.resolve("dist/cloud/main.js"), path.join(root, "cloud/main.js"));
  copyFileSync(path.resolve("dist/lifecycle/close.js"), path.join(root, "lifecycle/close.js"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  return root;
}
function run(root: string, source: string) {
  const entry = path.join(root, "runner.mjs"); writeFileSync(entry, source);
  return spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 3_000, maxBuffer: 16_384 });
}

describe("Cloud Node floor before bootstrap evaluation", () => {
  it.each(["20.19.0", "22.18.9", "v22.13.1", "garbage", "22.19"])("rejects %s", (version) => {
    expect(isNodeBelowSupportLine(version)).toBe(true);
  });
  it.each(["22.19.0", "v22.22.3", "24.0.0"])("accepts supported %s", (version) => {
    expect(isNodeBelowSupportLine(version)).toBe(false);
  });
  it.each(["22.18.9", "22.19.0"])("runs the real compiled main import order for %s", (version) => {
    const root = fixture(), marker = path.join(root, "bootstrap-loaded");
    writeFileSync(path.join(root, "cloud/bootstrap.js"), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'loaded');throw Error('SECRET fixture-import');`);
    const result = run(root, `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});const {runCloudMain}=await import('./cloud/main.js');process.exit(await runCloudMain());`);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stderr).not.toContain("SECRET");
    expect(existsSync(marker)).toBe(version === "22.19.0");
    expect(result.stderr).toContain(version === "22.19.0" ? "BOOTSTRAP_LOAD_FAILED" : "NODE_UNSUPPORTED");
  });
  it("does not reflect unknown error text or a classified error message", () => {
    expect(renderStartupFailure(new Error("SECRET credential=fixture-only"))).not.toContain("SECRET");
    const text = renderStartupFailure(new CloudStartupError("PROFILE_LOAD_FAILED", "SECRET fixture-profile"));
    expect(text).toContain("PROFILE_LOAD_FAILED"); expect(text).not.toContain("SECRET");
  });
});

describe("Cloud shutdown completion and exit status", () => {
  it("shares concurrent shutdown and exits nonzero after a failure with fixed text", async () => {
    const exits: number[] = [], messages: string[] = []; let calls = 0;
    const close = createCloudShutdown(async () => { calls++; throw new Error("SECRET shutdown fixture"); }, (code) => { exits.push(code); }, (text) => { messages.push(text); });
    const first = close(); expect(close()).toBe(first); await first; await close();
    expect(calls).toBe(1); expect(exits).toEqual([1]); expect(messages.join("")).toContain("RESOURCE_CLOSE_FAILED"); expect(messages.join("")).not.toContain("SECRET");
  });
  it("still exits nonzero when the failure log sink also throws", async () => {
    const exits: number[] = [];
    const close = createCloudShutdown(async () => { throw new Error("fixture close"); }, (code) => { exits.push(code); }, () => { throw new Error("fixture log"); });
    await close(); expect(exits).toEqual([1]);
  });
  it.each(["success", "failure", "timeout"])("real compiled shutdown exits truthfully for %s", (mode) => {
    const root = fixture(), marker = path.join(root, "closed");
    const body = mode === "success" ? `async()=>{fs.writeFileSync(${JSON.stringify(marker)},'closed')}`
      : mode === "failure" ? "async()=>{throw Error('SECRET shutdown fixture')}" : "()=>new Promise(()=>{})";
    const result = run(root, `import fs from 'node:fs';const {createCloudShutdown}=await import('./cloud/main.js');await createCloudShutdown(${body},undefined,undefined,15)();`);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(mode === "success" ? 0 : 1);
    expect(existsSync(marker)).toBe(mode === "success"); expect(result.stderr).not.toContain("SECRET");
    if (mode !== "success") expect(result.stderr).toContain("RESOURCE_CLOSE_FAILED");
  });
  it("ordinary SIGTERM and SIGINT share one successful cleanup before exit0", () => {
    const root = fixture(), marker = path.join(root, "calls");
    writeFileSync(path.join(root, "cloud/bootstrap.js"), `import fs from 'node:fs';export function renderStartupFailure(){return 'FIXED';}export async function bootstrapCloudRuntime(){return {close:async()=>{fs.appendFileSync(${JSON.stringify(marker)},'x');await new Promise(r=>setTimeout(r,25));}};}`);
    const result = run(root, "const {runCloudMain}=await import('./cloud/main.js');void runCloudMain();setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);setTimeout(()=>process.kill(process.pid,'SIGINT'),25);");
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(readFileSync(marker, "utf8")).toBe("x");
  });
});
