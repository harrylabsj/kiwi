// Type declarations for scripts/lib/portfolio-lock-verify.mjs so strict TS tests
// can import the shared portfolio-lock-candidate pre-check helpers.

export const ALLOWED_REPOSITORIES: Readonly<Record<string, string>>;
export const REPOSITORY_KEYS: readonly string[];
export const SHA256_HEX_RE: RegExp;
export const COMMIT_SHA_RE: RegExp;
export const LOCK_FILENAME: string;

export interface PortfolioRepositoryEntry {
  repository: string;
  commit: string;
}

export interface PortfolioLock {
  lock_version: 1;
  contract_bundle_sha256: string;
  contract_source_commit: string;
  repositories: {
    kiwi: PortfolioRepositoryEntry;
    "kiwi-catalog": PortfolioRepositoryEntry;
    "shopping-cli": PortfolioRepositoryEntry;
  };
}

export interface ConsumerContractLock {
  lock_version: 1;
  source_repository: string;
  source_commit: string;
  bundle_sha256: string;
  contracts_manifest: string;
}

export class PortfolioLockError extends Error {
  code: string;
}

export function validateLock(lock: unknown): void;
export function verifyManifestBundle(kiwiRoot: string, lock: PortfolioLock): Promise<void>;
export function gitHeadCommit(repoDir: string): string;
export function verifyConsumerHead(
  consumerDir: string,
  lock: PortfolioLock,
  repoKey: "kiwi-catalog" | "shopping-cli",
): Promise<string>;
export function findConsumerLockFiles(consumerDir: string): Promise<string[]>;
export function readConsumerLockFile(file: string): Promise<ConsumerContractLock>;
export function verifyConsumerLock(
  consumerDir: string,
  lock: PortfolioLock,
): Promise<{ checked: number }>;

export function verifyPortfolioLockCandidate(options: {
  lockPath: string;
  kiwiCatalogDir: string;
  shoppingCliDir: string;
  kiwiRoot: string;
}): Promise<string[]>;
