/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  addTrustedBuyerKey,
  readTrustedKeys,
  TrustedKeysError,
  trustedKeysPath,
} from "../src/tools/trusted-buyer-keys.js";

function pem(): string {
  return generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "kiwi-trusted-keys-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("trusted buyer keys", () => {
  it("adds an Ed25519 key with a profile and re-reads it", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = trustedKeysPath(dir);
      const result = addTrustedBuyerKey(file, {
        keyid: "buyer.example",
        publicKeyPem: pem(),
        profile: { identity: "buyer-1", role: "buyer", trustLevel: "T1" },
      });
      expect(result.added).toBe(true);
      const keys = readTrustedKeys(file);
      expect(keys).toHaveLength(1);
      expect(keys[0]?.keyid).toBe("buyer.example");
      expect(keys[0]?.profile?.trustLevel).toBe("T1");
    } finally {
      cleanup();
    }
  });

  it("refuses a duplicate key id unless replacement is explicit", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = trustedKeysPath(dir);
      addTrustedBuyerKey(file, { keyid: "buyer.example", publicKeyPem: pem() });
      expect(() =>
        addTrustedBuyerKey(file, { keyid: "buyer.example", publicKeyPem: pem() }),
      ).toThrow(expect.objectContaining({ code: "DUPLICATE_KEYID" }));
      const replaced = addTrustedBuyerKey(
        file,
        { keyid: "buyer.example", publicKeyPem: pem(), profile: { trustLevel: "T2" } },
        { replace: true },
      );
      expect(replaced.added).toBe(false);
      expect(readTrustedKeys(file)[0]?.profile?.trustLevel).toBe("T2");
    } finally {
      cleanup();
    }
  });

  it("rejects non-Ed25519 material", () => {
    const { dir, cleanup } = tempDir();
    try {
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .publicKey.export({ type: "spki", format: "pem" })
        .toString();
      expect(() =>
        addTrustedBuyerKey(trustedKeysPath(dir), { keyid: "rsa", publicKeyPem: rsa }),
      ).toThrow(expect.objectContaining({ code: "NOT_ED25519" }));
    } finally {
      cleanup();
    }
  });

  it("rejects garbage PEM and bad key ids", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = trustedKeysPath(dir);
      expect(() =>
        addTrustedBuyerKey(file, { keyid: "buyer", publicKeyPem: "not a key" }),
      ).toThrow(expect.objectContaining({ code: "INVALID_PEM" }));
      expect(() =>
        addTrustedBuyerKey(file, { keyid: "bad key id", publicKeyPem: pem() }),
      ).toThrow(expect.objectContaining({ code: "INVALID_KEYID" }));
    } finally {
      cleanup();
    }
  });

  it("never rewrites a malformed existing file", () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = trustedKeysPath(dir);
      writeFileSync(file, "{not json");
      expect(() => addTrustedBuyerKey(file, { keyid: "buyer", publicKeyPem: pem() })).toThrow(
        TrustedKeysError,
      );
      expect(readFileSync(file, "utf8")).toBe("{not json");
    } finally {
      cleanup();
    }
  });
});
