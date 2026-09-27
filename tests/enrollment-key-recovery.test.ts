/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateA2aSigningIdentity,
  loadA2aSigningIdentityFromFile,
  A2A_SIGNING_KEY_FILE,
} from "../src/a2a/signing-key.js";
import {
  rotateEnrollmentSigningKey,
  EnrollmentKeyRecoveryError,
} from "../src/cloud/binding/enrollment-key-recovery.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function state(): { root: string; keyPath: string; lockPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), "kiwi-key-recovery-"));
  roots.push(root);
  const keyPath = path.join(root, A2A_SIGNING_KEY_FILE);
  const identity = generateA2aSigningIdentity("https://merchant.example");
  writeFileSync(
    keyPath,
    JSON.stringify({
      keyid: identity.keyid,
      algorithm: identity.algorithm,
      privateKeyPem: identity.privateKeyPem,
      publicKeyPem: identity.publicKeyPem,
      publicKeyRaw: identity.publicKeyRaw.toString("base64"),
    }),
    { mode: 0o600 },
  );
  const lockPath = path.join(root, "a2a", "owner.lock");
  mkdirSync(path.dirname(lockPath), { mode: 0o700 });
  return { root, keyPath, lockPath };
}

describe("explicit local enrollment key recovery", () => {
  it("rotates only the stopped Runtime key, keeps unrelated enrollment state, and writes mode 0600", () => {
    const f = state();
    const old = loadA2aSigningIdentityFromFile(f.keyPath);
    writeFileSync(
      path.join(f.root, "merchant-enrollments.json"),
      '{"version":1,"sessions":[{"status":"published","binding_id":"old-binding"}],"consumed":[]}\n',
      { mode: 0o600 },
    );
    const rotated = rotateEnrollmentSigningKey(f.root, old.keyid);
    const current = loadA2aSigningIdentityFromFile(f.keyPath);
    expect(rotated.oldKeyId).toBe(old.keyid);
    expect(current.publicKeyPem).not.toBe(old.publicKeyPem);
    expect(statSync(f.keyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(f.root, "merchant-enrollments.json"), "utf8")).toContain(
      "old-binding",
    );
    expect(current.keyid).toBe(old.keyid);
  });
  it("refuses while the managed A2A PID is alive and leaves the old key untouched", () => {
    const f = state();
    const old = loadA2aSigningIdentityFromFile(f.keyPath).publicKeyPem;
    writeFileSync(f.lockPath, String(process.pid), { mode: 0o600 });
    expect(() => rotateEnrollmentSigningKey(f.root, "https://merchant.example")).toThrow(
      /仍在运行/,
    );
    expect(loadA2aSigningIdentityFromFile(f.keyPath).publicKeyPem).toBe(old);
  });
  it("rejects missing, malformed, over-permissive key files and invalid key IDs", () => {
    const f = state();
    chmodSync(f.keyPath, 0o644);
    expect(() => rotateEnrollmentSigningKey(f.root, "https://merchant.example")).toThrow(/0600/);
    chmodSync(f.keyPath, 0o600);
    expect(() => rotateEnrollmentSigningKey(f.root, "bad\nkey")).toThrow(
      EnrollmentKeyRecoveryError,
    );
    writeFileSync(f.keyPath, "{}", { mode: 0o600 });
    expect(() => rotateEnrollmentSigningKey(f.root, "https://merchant.example")).toThrow(/损坏/);
  });
});
