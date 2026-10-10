/** Strict single-package npm pack JSON adapter: arrays and npm12 name-keyed records. */
import path from "node:path";
export function packRecord(value, expected) {
  const mapped = !Array.isArray(value);
  if (value === null || typeof value !== "object") throw new Error("NPM_PACK_RECORD_INVALID");
  const records = mapped ? Object.values(value) : value;
  if (records.length !== 1 || !records[0] || typeof records[0] !== "object")
    throw new Error("NPM_PACK_ONE_RECORD_REQUIRED");
  const record = records[0];
  if (
    record.name !== expected.name ||
    record.version !== expected.version ||
    (mapped && Object.keys(value)[0] !== record.name) ||
    typeof record.filename !== "string" ||
    path.basename(record.filename) !== record.filename ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(record.filename) ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    !Number.isSafeInteger(record.size) ||
    record.size < 1 ||
    !Number.isSafeInteger(record.unpackedSize) ||
    record.unpackedSize < 1 ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity ?? "") ||
    Buffer.from(record.integrity.slice(7), "base64").length !== 64 ||
    Buffer.from(record.integrity.slice(7), "base64").toString("base64") !==
      record.integrity.slice(7)
  )
    throw new Error("NPM_PACK_BINDING_OR_PAYLOAD_INVALID");
  const seen = new Set();
  for (const file of record.files) {
    if (
      typeof file?.path !== "string" ||
      !file.path ||
      path.posix.isAbsolute(file.path) ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      file.path.split("/").some((p) => !p || p === "." || p === "..") ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new Error("NPM_PACK_FILE_INVALID");
    seen.add(file.path);
  }
  return record;
}
