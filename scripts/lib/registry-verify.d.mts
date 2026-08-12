// Type declarations for scripts/lib/registry-verify.mjs so strict TS tests can
// import the shared registry verification helpers.

export const MANIFEST_SCHEMA: string;

export function sha256Hex(buffer: Buffer): string;
export function sha512Base64(buffer: Buffer): string;

export interface ReleaseManifestFile {
  path: string;
  sha256: string;
}

export interface ReleaseManifest {
  schema: string;
  contract_source_commit?: string;
  files: ReleaseManifestFile[];
}

export function loadManifest(releaseDir: string): Promise<ReleaseManifest>;

export interface PyPiArtifactIdentity {
  name: string;
  version: string;
  kind: "wheel" | "sdist";
}
export function parsePyPiFilename(filename: string): PyPiArtifactIdentity;

export interface NpmTarballIdentity {
  name: string;
  version: string;
}
export function parseNpmTarballFilename(filename: string): NpmTarballIdentity;

export interface NpmDownloadExpectation {
  identity: NpmTarballIdentity;
  integrity?: string;
  sha256?: string;
}
export function verifyNpmDownload(buffer: Buffer, expected: NpmDownloadExpectation): void;

export interface PyPiDownloadExpectation {
  identity: { name: string; version: string; filename: string };
  pypiSha256?: string;
  manifestSha256?: string;
}
export function verifyPyPiFile(buffer: Buffer, expected: PyPiDownloadExpectation): void;

export function downloadBuffer(url: string, options?: { retries?: number }): Promise<Buffer>;

export interface NpmRegistryMetadata {
  tarball: string;
  integrity: string;
  version: string;
}
export function npmRegistryMetadata(name: string, version: string): Promise<NpmRegistryMetadata>;

export function withPropagationRetry<T>(
  fn: () => Promise<T> | T,
  options: {
    isRetryable: (error: unknown) => boolean;
    delays?: number[];
    label?: string;
  },
): Promise<T>;

export function pypiMetadata(name: string, version: string): Promise<{
  info: { name: string; version: string };
  urls: Array<{ filename: string; url: string; packagetype: string; digests: { sha256: string } }>;
}>;

export function npmTarballPackageJson(tarballPath: string): NpmTarballIdentity;
