/** Read the actual published bundle with the approved npm12 Arborist; no callback verdicts. */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";
import { assertSource, toolchain, json, sha256 } from "./npm-shipping.mjs";
export async function assertBundledEdges(sourceRoot, bundleRoot) {
  assertSource(sourceRoot);
  const tool = toolchain(sourceRoot);
  const cli = realpathSync(execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
  if (sha256(readFileSync(cli)) !== tool.npm_cli_sha256) throw new Error("SHIPPING_EDGE_TOOL_CHANGED");
  const Arborist = createRequire(cli)("@npmcli/arborist");
  const pkg = json(path.join(bundleRoot, "package.json"));
  if (Object.hasOwn(pkg, "overrides")) throw new Error("SHIPPING_LEAF_OVERRIDES_FORBIDDEN");
  if (JSON.stringify(pkg.bundleDependencies) !== JSON.stringify(Object.keys(pkg.dependencies).sort()) ||
      JSON.stringify(pkg.bundledDependencies) !== JSON.stringify(pkg.bundleDependencies))
    throw new Error("SHIPPING_COMPLETE_BUNDLE_REQUIRED");
  const tree = await new Arborist({ path: bundleRoot }).loadActual({ forceActual: true }); // inspect physical metadata, not hidden-lock cache.
  const invalid = [], checked = [];
  for (const node of tree.inventory.values()) {
    if (node.isRoot || !node.inBundle) continue;
    for (const edge of node.edgesOut.values()) {
      if (edge.type === "dev") continue;
      const row = { from: node.location, name: edge.name, spec: edge.spec, type: edge.type,
        target: edge.to?.location ?? null, version: edge.to?.version ?? null, error: edge.error ?? null };
      checked.push(row);
      if (!edge.valid) invalid.push(row);
    }
  }
  for (const edge of tree.edgesOut.values())
    if (edge.type !== "dev" && !edge.valid) invalid.push({ from: "", name: edge.name, spec: edge.spec, error: edge.error });
  if (invalid.length) throw Object.assign(new Error("SHIPPING_BUNDLED_EDGE_INVALID"), { invalid });
  return { bundled_nodes: [...tree.inventory.values()].filter((node) => !node.isRoot && node.inBundle).length,
    checked_runtime_edges: checked.length, edges: checked };
}
export function assertInstalledLockedVersions(sourceRoot, installed) {
  assertSource(sourceRoot);
  const lock = json(path.join(sourceRoot, "build-inputs/release0124-stage/package-lock.json"));
  const results = [];
  for (const [relative, row] of Object.entries(lock.packages)) {
    if (!relative || row.dev) continue;
    const file = path.join(installed, relative, "package.json");
    if (!existsSync(file)) {
      if (row.optional) continue; // npm's platform-optional packages may be absent.
      throw new Error(`SHIPPING_COLD_PACKAGE_MISSING ${relative}`);
    }
    const pkg = json(file);
    if (pkg.version !== row.version) throw new Error(`SHIPPING_COLD_LOCKED_VERSION_CHANGED ${relative}`);
    results.push({ path: relative, version: pkg.version });
  }
  return results;
}
