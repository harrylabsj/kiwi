/** A236 local lossless stage archive. Hashes establish integrity, not remote origin/authentication. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync, brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

const MAGIC = Buffer.from("KIWISTG1");
const MAX_PLAIN = 256 * 1048576;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function relativeName(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("A236_ARCHIVE_PATH_INVALID");
  return value;
}
export function inventory(root, prefix = "") {
  const rows = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(root, name);
    const stat = lstatSync(file);
    const mode = stat.mode & 0o777;
    if (entry.isDirectory()) {
      rows.push({ path: name, kind: "directory", mode, size: 0 });
      rows.push(...inventory(root, name));
    } else if (entry.isFile()) {
      const bytes = readFileSync(file);
      rows.push({ path: name, kind: "file", mode, size: bytes.length, sha256: sha256(bytes) });
    } else if (entry.isSymbolicLink()) {
      const target = readlinkSync(file);
      const bytes = Buffer.from(target);
      rows.push({ path: name, kind: "symlink", mode, size: bytes.length, sha256: sha256(bytes), symlink_target: target });
    } else throw new Error("A236_ARCHIVE_SPECIAL_FILE_REFUSED");
  }
  return rows.sort(compare);
}
function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 50000) throw new Error("A236_ARCHIVE_ENTRIES_INVALID");
  const byPath = new Map();
  for (const row of entries) {
    relativeName(row.path);
    if (byPath.has(row.path) || !["directory", "file", "symlink"].includes(row.kind) || !Number.isSafeInteger(row.size) || row.size < 0 || !Number.isSafeInteger(row.mode) || row.mode < 0 || row.mode > 0o777) throw new Error("A236_ARCHIVE_ENTRY_INVALID");
    if (row.kind === "directory") {
      if (row.size !== 0) throw new Error("A236_ARCHIVE_DIRECTORY_INVALID");
    } else if (!/^[a-f0-9]{64}$/.test(row.sha256 ?? "")) throw new Error("A236_ARCHIVE_HASH_INVALID");
    if (row.kind === "symlink") {
      const target = row.symlink_target;
      if (typeof target !== "string" || !target || target.includes("\\") || target.includes("\0") || path.posix.isAbsolute(target) || /^[A-Za-z]:/.test(target)) throw new Error("A236_ARCHIVE_LINK_INVALID");
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(row.path), target));
      if (resolved === ".." || resolved.startsWith("../") || resolved === ".") throw new Error("A236_ARCHIVE_LINK_ESCAPE");
      if (Buffer.byteLength(target) !== row.size || sha256(Buffer.from(target)) !== row.sha256) throw new Error("A236_ARCHIVE_LINK_HASH_INVALID");
    }
    byPath.set(row.path, row);
  }
  for (const row of entries) {
    let parent = path.posix.dirname(row.path);
    while (parent !== ".") {
      if (byPath.get(parent)?.kind !== "directory") throw new Error("A236_ARCHIVE_PARENT_NOT_DIRECTORY");
      parent = path.posix.dirname(parent);
    }
  }
}
export function encodeStagePlain(plain, { codec = "gzip-v1", quality = 9 } = {}) {
  if (!["gzip-v1", "brotli-v1"].includes(codec)) throw new Error("A244_ARCHIVE_CODEC_UNKNOWN");
  if (plain.length > MAX_PLAIN) throw new Error("A236_ARCHIVE_EXPANSION_LIMIT");
  if (codec === "brotli-v1" && ![5, 9].includes(quality)) throw new Error("A244_QUALITY_OUTSIDE_BOUNDED_CHOICES");
  return codec === "gzip-v1" ? gzipSync(plain, { level: 9 }) : brotliCompressSync(plain, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } });
}
export function createStageArchive(stage, options = {}) {
  const entries = inventory(stage);
  validateEntries(entries);
  const header = Buffer.from(JSON.stringify({ format: "kiwi-stage-v1", entries }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const body = entries.filter((row) => row.kind === "file").map((row) => {
    const bytes = readFileSync(path.join(stage, row.path));
    if (bytes.length !== row.size || sha256(bytes) !== row.sha256) throw new Error("A236_SOURCE_CHANGED_DURING_PACK");
    return bytes;
  });
  const plain = Buffer.concat([MAGIC, length, header, ...body]);
  if (plain.length > MAX_PLAIN) throw new Error("A236_ARCHIVE_EXPANSION_LIMIT");
  const archive = encodeStagePlain(plain, options);
  return { archive, entries, plain_bytes: plain.length, plain_sha256: sha256(plain), sha256: sha256(archive), bytes: archive.length, ...(options.codec === "brotli-v1" ? { codec: "brotli-v1", quality: options.quality } : {}) };
}
export function decodeStageArchive(bytes, expected) {
  if (!expected || expected.bytes !== bytes.length || expected.sha256 !== sha256(bytes) || !Number.isSafeInteger(expected.plain_bytes) || expected.plain_bytes <= 12 || expected.plain_bytes > MAX_PLAIN) throw new Error("A236_ARCHIVE_HASH_OR_SIZE_MISMATCH");
  const codec = expected.codec ?? "gzip-v1";
  if (!["gzip-v1", "brotli-v1"].includes(codec)) throw new Error("A244_ARCHIVE_CODEC_UNKNOWN");
  const plain = codec === "gzip-v1" ? gunzipSync(bytes, { maxOutputLength: expected.plain_bytes }) : brotliDecompressSync(bytes, { maxOutputLength: expected.plain_bytes });
  if (codec === "brotli-v1" && expected.plain_sha256 !== sha256(plain)) throw new Error("A244_PLAIN_HASH_MISMATCH");
  if (plain.length !== expected.plain_bytes || !plain.subarray(0, 8).equals(MAGIC)) throw new Error("A236_ARCHIVE_FORMAT_INVALID");
  const headerLength = plain.readUInt32BE(8);
  if (headerLength > 16 * 1048576 || headerLength <= 0 || 12 + headerLength > plain.length) throw new Error("A236_ARCHIVE_HEADER_INVALID");
  const header = JSON.parse(plain.subarray(12, 12 + headerLength).toString("utf8"));
  if (header.format !== "kiwi-stage-v1") throw new Error("A236_ARCHIVE_FORMAT_INVALID");
  validateEntries(header.entries);
  let offset = 12 + headerLength;
  const records = header.entries.map((row) => {
    if (row.kind !== "file") return { row };
    const data = plain.subarray(offset, offset + row.size); offset += row.size;
    if (data.length !== row.size || sha256(data) !== row.sha256) throw new Error("A236_ARCHIVE_FILE_HASH_MISMATCH");
    return { row, data };
  });
  if (offset !== plain.length) throw new Error("A236_ARCHIVE_TRAILING_BYTES");
  return { entries: header.entries, records, plain, plain_sha256: sha256(plain) };
}
export function assertSourceStage(entries, sourceFiles) {
  const actual = entries.filter((row) => row.kind !== "directory").map((row) => ({ path: row.path, size: row.size, sha256: row.sha256, ...(row.kind === "symlink" ? { symlink_target: row.symlink_target } : {}) })).sort(compare);
  const expected = sourceFiles.map((row) => ({ path: row.path, size: row.size, sha256: row.sha256, ...(row.symlink_target === undefined ? {} : { symlink_target: row.symlink_target }) })).sort(compare);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("A236_STAGE_SOURCE_MANIFEST_MISMATCH");
}
export function extractStageArchive(archiveFile, destination, expected, sourceFiles) {
  // Always verify archive and source closure before inspecting any cache. Never reuse an old extraction.
  const decoded = decodeStageArchive(readFileSync(archiveFile), expected);
  assertSourceStage(decoded.entries, sourceFiles);
  if (existsSync(destination)) throw new Error("A236_EXTRACTION_DESTINATION_EXISTS");
  let owned = false;
  try {
    mkdirSync(destination); owned = true;
    for (const row of decoded.entries.filter((row) => row.kind === "directory").sort((a, b) => a.path.split("/").length - b.path.split("/").length)) mkdirSync(path.join(destination, row.path));
    for (const { row, data } of decoded.records) {
      if (row.kind === "file") { writeFileSync(path.join(destination, row.path), data, { flag: "wx", mode: row.mode }); chmodSync(path.join(destination, row.path), row.mode); }
      else if (row.kind === "symlink") symlinkSync(row.symlink_target, path.join(destination, row.path));
    }
    for (const row of decoded.entries.filter((row) => row.kind === "directory")) chmodSync(path.join(destination, row.path), row.mode);
    const restored = inventory(destination);
    if (JSON.stringify(restored) !== JSON.stringify([...decoded.entries].sort(compare))) throw new Error("A236_RESTORED_STAGE_MISMATCH");
    return { stage: destination, entries: restored };
  } catch (error) {
    if (owned) rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function assertPackedRawBudget(manifest, actual) {
  const rawBytes = actual.reduce((sum, row) => sum + row.size, 0);
  if (manifest.budget?.raw_total_bytes !== rawBytes || manifest.budget?.raw_total_files !== actual.length || manifest.budget?.max_mib !== 64 || manifest.budget?.within_budget !== (rawBytes <= 64 * 1048576)) throw new Error("A236_RAW_BUDGET_METADATA_MISMATCH");
  if (!manifest.budget.within_budget) throw new Error("A236_RAW_BUDGET_EXCEEDED");
  return rawBytes;
}

export function verifyPackedCandidate(root) {
  const manifestFile = path.join(root, "a236-packed-manifest.json");
  const manifestBytes = readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  const modern = manifest.package_format === "kiwi-packed-main-merchant-v1";
  const codec = manifest.stage_archive?.codec ?? "gzip-v1";
  if (!["gzip-v1", "brotli-v1"].includes(codec) || (!modern && codec !== "gzip-v1")) throw new Error("A244_ARCHIVE_CODEC_NAMESPACE_INVALID");
  const archiveName = codec === "brotli-v1" ? "payloads/merchant-stage.a244.br" : "payloads/merchant-stage.a236.gz";
  if ((!modern && manifest.package_format !== "kiwi-packed-merchant-v1") || !/^[a-f0-9]{40}$/.test(manifest.source_commit ?? "") || manifest.stage_archive?.file !== archiveName || manifest.source_manifest?.file !== (modern ? "source/a243-source-manifest.json" : "source/a232-candidate-manifest.json")) throw new Error("A236_PACKED_MANIFEST_INVALID");
  const actual = inventory(root).filter((row) => row.kind !== "directory");
  if (actual.some((row) => row.kind !== "file")) throw new Error("A236_DISTRIBUTION_LINK_REFUSED");
  const expectedFiles = manifest.distribution_files;
  if (!Array.isArray(expectedFiles) || expectedFiles.some((row) => row.path === "a236-packed-manifest.json")) throw new Error("A236_DISTRIBUTION_MANIFEST_INVALID");
  const comparable = (rows) => rows.map((row) => ({ path: row.path, size: row.size, sha256: row.sha256 })).sort(compare);
  if (JSON.stringify(comparable(actual.filter((row) => row.path !== "a236-packed-manifest.json"))) !== JSON.stringify(comparable(expectedFiles))) throw new Error("A236_DISTRIBUTION_FILE_MISMATCH");
  const rawBytes = assertPackedRawBudget(manifest, actual);
  const sourceBytes = readFileSync(path.join(root, manifest.source_manifest.file));
  if (sha256(sourceBytes) !== manifest.source_manifest.sha256) throw new Error("A236_SOURCE_MANIFEST_HASH_MISMATCH");
  const source = JSON.parse(sourceBytes);
  if (source.source_commit !== manifest.stage_source_commit || !Array.isArray(source.candidate_files) || source.reviewed_runtime?.platform !== "linux" || source.reviewed_runtime?.arch !== "x64" || source.reviewed_runtime?.node_version !== "22.19.0") throw new Error("A236_SOURCE_IDENTITY_MISMATCH");
  if (source.source_commit !== (modern ? "45fbf55622b3bc3d3012d2b8a8a559f389153bfb" : "c8f8b18ede8833f1b96b3301718edbc8ee0a0fe2")) throw new Error("A243_SOURCE_CONTRACT_MISMATCH");
  if (modern && (source.source_format !== "kiwi-main-cloud-source-v1" || source.internal_package_version !== "0.12.0" || source.pi_sdk_version !== "1.0.2" || manifest.internal_package_version !== "0.12.0" || manifest.pi_sdk_version !== "1.0.2" || source.owner_runtime_default !== "dual-off/private" || manifest.owner_runtime_default !== "dual-off/private")) throw new Error("A243_SOURCE_VERSION_CONTRACT_MISMATCH");
  const sourceFiles = source.candidate_files.filter((row) => row.path.startsWith("stage/")).map((row) => ({ ...row, path: row.path.slice(6) }));
  const archiveFile = path.join(root, manifest.stage_archive.file);
  const decoded = decodeStageArchive(readFileSync(archiveFile), manifest.stage_archive);
  assertSourceStage(decoded.entries, sourceFiles);
  if (modern) {
    const packageRecord = decoded.records.find(({ row }) => row.path === "package.json");
    const stagePackage = JSON.parse(packageRecord?.data ?? "null");
    if (stagePackage?.version !== "0.12.0" || stagePackage?.dependencies?.["@earendil-works/pi-coding-agent"] !== undefined) throw new Error("A243_STAGE_PACKAGE_CONTRACT_MISMATCH");
    for (const name of ["pi-ai", "pi-agent-core", "pi-durable"]) {
      const record = decoded.records.find(({ row }) => row.path === `node_modules/@earendil-works/${name}/package.json`);
      if (JSON.parse(record?.data ?? "null")?.version !== "1.0.2") throw new Error("A243_PHYSICAL_PI_VERSION_MISMATCH");
    }
  }
  // Preserve every original non-stage file, including official runtime payloads and the old bridge.
  const sourceNonStage = source.candidate_files.filter((row) => !row.path.startsWith("stage/"));
  for (const row of sourceNonStage) {
    relativeName(row.path);
    const file = path.join(root, row.path);
    if (!lstatSync(file).isFile() || readFileSync(file).length !== row.size || sha256(readFileSync(file)) !== row.sha256) throw new Error("A236_SOURCE_RUNTIME_OR_LAUNCHER_MISMATCH");
  }
  const allOriginal = [...sourceFiles.map((row) => ({ ...row, path: `stage/${row.path}` })), ...sourceNonStage].sort(compare);
  const sourceDigest = sha256(Buffer.from(allOriginal.map((row) => `${row.path}\0${row.size}\0${row.sha256}`).join("\n")));
  if (sourceDigest !== source.artifact_sha256 || allOriginal.length !== source.budget.total_files || allOriginal.reduce((sum, row) => sum + row.size, 0) !== source.budget.total_bytes) throw new Error("A236_SOURCE_CLOSURE_MISMATCH");
  if (manifest.expanded.stage_files !== sourceFiles.length || manifest.expanded.stage_bytes !== sourceFiles.reduce((sum, row) => sum + row.size, 0) || manifest.expanded.original_candidate_bytes !== source.budget.total_bytes) throw new Error("A236_EXPANDED_METADATA_MISMATCH");
  const runtime = JSON.parse(readFileSync(path.join(root, "runtime/runtime-manifest.linux-x64.json")));
  if (manifest.expanded.original_candidate_files !== source.budget.total_files || manifest.expanded.reviewed_node_binary_bytes_declared !== runtime.bin_node_bytes || manifest.expanded.one_install_disk_bytes_declared !== rawBytes + manifest.expanded.stage_bytes + runtime.bin_node_bytes) throw new Error("A236_EXPANDED_DISK_METADATA_MISMATCH");
  return { manifest, source, sourceFiles, archiveFile, decoded, rawBytes };
}
