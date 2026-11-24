import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

function workBuddyOrigin(value) {
  if (typeof value !== "string" || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.app\.workbuddy\.host\/?$/.test(value)) {
    return undefined;
  }
  return value.replace(/\/$/, "");
}

function resolveDirectory(directory, errorCode) {
  try {
    if (lstatSync(directory).isDirectory()) return realpathSync(directory);
  } catch {
    // Report only the reason, without exposing an unchecked path.
  }
  throw new Error(errorCode);
}

function readRegularFile(file, errorCode) {
  try {
    if (lstatSync(file).isFile()) return readFileSync(file, "utf8");
  } catch {
    // Report only the reason, without exposing an unchecked path.
  }
  throw new Error(errorCode);
}

function isInside(parent, directory) {
  const relative = path.relative(parent, directory);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

// The caller supplies the app ID and origin verified in the current WorkBuddy
// account. This check matches that app to one local deployment, before any mutation.
export function resolveUpgradeTarget({ workspace, appId, origin }) {
  const expectedOrigin = workBuddyOrigin(origin);
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) ||
      typeof appId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(appId) || !expectedOrigin) {
    throw new Error("WORKSPACE_AND_VERIFIED_APP_ID_AND_ORIGIN_REQUIRED");
  }

  const root = resolveDirectory(workspace, "WORKSPACE_UNAVAILABLE");
  const markerId = appId.startsWith("wbapp_") ? appId : `wbapp_${appId}`;
  const marker = readRegularFile(path.join(root, `.${markerId}.genie`), "TARGET_MARKER_UNAVAILABLE");
  const field = (key) => {
    const matches = [...marker.matchAll(new RegExp(`^${key}:[ \\t]*([^\\r\\n]+)`, "gm"))];
    return matches.length === 1 ? matches[0][1].trim() : undefined;
  };
  const localDir = field("localDir");
  if (field("appId") !== appId || !localDir) throw new Error("TARGET_MARKER_MISMATCH");

  const candidate = path.resolve(workspace, localDir);
  if (!isInside(path.resolve(workspace), candidate) && !isInside(root, candidate)) {
    throw new Error("TARGET_PATH_OUTSIDE_WORKSPACE");
  }
  const deployment = resolveDirectory(candidate, "TARGET_DIRECTORY_UNAVAILABLE");
  if (!isInside(root, deployment)) throw new Error("TARGET_PATH_OUTSIDE_WORKSPACE");
  let config;
  try {
    config = JSON.parse(readRegularFile(path.join(deployment, "cloud.config.json"), "TARGET_CONFIG_UNAVAILABLE"));
  } catch {
    throw new Error("TARGET_CONFIG_UNAVAILABLE");
  }
  if (workBuddyOrigin(config?.public_origin) !== expectedOrigin) throw new Error("TARGET_ORIGIN_MISMATCH");

  let version;
  try {
    version = JSON.parse(readRegularFile(path.join(deployment, "package.json"), "TARGET_VERSION_UNAVAILABLE"))?.version;
  } catch {
    throw new Error("TARGET_VERSION_UNAVAILABLE");
  }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
    throw new Error("TARGET_VERSION_UNAVAILABLE");
  }
  return { app_id: appId, origin: expectedOrigin, local_dir: deployment, version };
}
