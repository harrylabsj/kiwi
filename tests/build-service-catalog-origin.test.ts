import { describe, expect, it } from "vitest";

import { stripTrailingSlashes } from "../src/buyer-core/build-service.js";

describe("buyer service catalog origin slash normalization", () => {
  it("strips ordinary trailing slashes without changing the rest of the URL", () => {
    expect(stripTrailingSlashes("https://catalog.example")).toBe("https://catalog.example");
    expect(stripTrailingSlashes("https://catalog.example/")).toBe("https://catalog.example");
    expect(stripTrailingSlashes("https://catalog.example/api///")).toBe(
      "https://catalog.example/api",
    );
    expect(stripTrailingSlashes("https://catalog.example/a//b///")).toBe(
      "https://catalog.example/a//b",
    );
  });

  it("returns an empty string for an all-slash input", () => {
    expect(stripTrailingSlashes("")).toBe("");
    expect(stripTrailingSlashes("/")).toBe("");
    expect(stripTrailingSlashes("//////")).toBe("");
    expect(stripTrailingSlashes("/".repeat(100_000))).toBe("");
  });

  it("does not scan away slashes followed by characters, even on long slash runs", () => {
    expect(stripTrailingSlashes("https://catalog.example/path")).toBe(
      "https://catalog.example/path",
    );
    const longRun = `${"x"}${"/".repeat(100_000)}path////`;
    expect(stripTrailingSlashes(longRun)).toBe(`x${"/".repeat(100_000)}path`);
    const trailingAfterChars = `https://catalog.example/${"/".repeat(100_000)}segment`;
    expect(stripTrailingSlashes(trailingAfterChars)).toBe(trailingAfterChars);
  });
});
