export const BASE: string, VERSION: string, MAX_PLAIN: number, MAX_TGZ: number;
export function aggregate(rows: Array<{ path: string; sha256: string }>): string;
export function assertBudget(rows: Array<{ size: number }>, max?: number): number;
export function inventory(dir: string): Array<{ path: string; size: number; sha256: string }>;
export function assertFiles(
  dir: string,
  manifest: { files: unknown; artifact_sha256: string; file_count: number; total_bytes: number },
): unknown;
export function assertStageLock(root: string): unknown;
export function stagePackage(root: string): {
  dependencies: Record<string, string>;
  overrides: unknown;
  allowScripts: unknown;
  scripts: { preinstall: string };
};
export function sourceHash(root: string, p: string): string;

export function sourceContract(root: string): unknown;
export function assertSource(root: string): unknown;
export function verifyTarball(
  bytes: Buffer,
  expected: Array<{ path: string; size: number; sha256: string }>,
): unknown;

export function assertOfficialNpmPayload(
  root: string,
  payload: unknown,
): {
  npm_code_sha256: string;
  official_tarball_integrity: string;
  canonical_file_count: number;
  nonpayload: Array<{
    path: string; size: number; sha256: string; classification: string;
    symlink_target?: string; declared_by?: string; target_payload_path?: string;
  }>;
};
export function assertNoState(
  rows: Array<{ path: string; size: number; sha256: string }>,
  options?: {
    artifactRoot?: string;
    compiledApp?: CompiledAppProof;
    vendorCode?: VendorCodeProof;
    stageNpmrc?: { size: number; sha256: string };
    generatedLock?: { path: string; size: number; sha256: string };
  },
): void;

export function publishBuildReceipt(
  file: string,
  value: unknown,
  options?: { beforeRename?: (temp: string) => void },
): void;

export function controlledHiddenNpmLock(stage: string): {
  path: string;
  size: number;
  sha256: string;
};

export function assertForeignCheckouts(root: string): string[];

declare const compiledProofBrand: unique symbol, vendorProofBrand: unique symbol;
export type CompiledAppProof = { readonly [compiledProofBrand]: true };
export type VendorCodeProof = { readonly [vendorProofBrand]: true };
export function createCompiledAppProof(root: string, stage: string): CompiledAppProof;
export function createVendorCodeProof(root: string, stage: string, officialTarball: string): VendorCodeProof;
