import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MerchantRuntimeManager, type ManagedServiceSpec } from "../src/merchant-runtime/manager.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function waitFor(assertion: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for managed credential process state");
}

describe("runtime credential handoff", () => {
  it("reconciles an external switch without racing the old supervisor or relaunching stale env", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kiwi-runtime-credential-switch-"));
    dirs.push(dir);
    const credentialFile = path.join(dir, "credentials.env");
    const marker = path.join(dir, "credential-rotation.lock");
    const observedFile = path.join(dir, "observed-token");
    writeFileSync(credentialFile, "SHOPPING_MERCHANT_TOKEN=old-token\n", { mode: 0o600 });
    const script = "const fs=require('node:fs'); fs.writeFileSync(process.env.OBSERVED_TOKEN_FILE, process.env.SHOPPING_MERCHANT_TOKEN || 'missing'); setInterval(()=>{},1000)";
    const spec: ManagedServiceSpec = {
      name: "a2a",
      command: [process.execPath, "-e", script],
      env: { OBSERVED_TOKEN_FILE: observedFile },
      credentialEnvFile: { path: credentialFile, names: ["SHOPPING_MERCHANT_TOKEN"] },
      credentialSwitchMarker: marker,
      cwd: dir,
    };
    const supervisor = new MerchantRuntimeManager({ dir, services: [spec], reconcileIntervalMs: 100 });
    const switcher = new MerchantRuntimeManager({ dir, services: [spec], reconcileIntervalMs: 100 });
    await supervisor.supervise();
    await waitFor(() => existsSync(observedFile));
    expect(readFileSync(observedFile, "utf8")).toBe("old-token");

    writeFileSync(marker, "switch in progress\n", { mode: 0o600 });
    await switcher.stop("a2a");
    writeFileSync(credentialFile, "SHOPPING_MERCHANT_TOKEN=new-token\n", { mode: 0o600 });
    await switcher.start("a2a"); // explicit switch process loads credential file at spawn
    await waitFor(() => readFileSync(observedFile, "utf8") === "new-token");
    const newPid = switcher.status()[0]?.pid;
    expect(newPid).toBeDefined();
    process.kill(newPid as number, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The old supervisor must not spawn its stale process while switching.
    expect(readFileSync(observedFile, "utf8")).toBe("new-token");
    rmSync(marker, { force: true });
    await waitFor(() => supervisor.status()[0]?.running === true && readFileSync(observedFile, "utf8") === "new-token");
    await supervisor.shutdown();
  });
});
