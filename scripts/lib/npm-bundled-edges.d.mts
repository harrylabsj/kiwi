export function assertBundledEdges(sourceRoot: string, bundleRoot: string): Promise<{
  bundled_nodes: number;
  checked_runtime_edges: number;
  edges: unknown[];
}>;
export function assertInstalledLockedVersions(sourceRoot: string, installed: string): Array<{path: string; version: string}>;
