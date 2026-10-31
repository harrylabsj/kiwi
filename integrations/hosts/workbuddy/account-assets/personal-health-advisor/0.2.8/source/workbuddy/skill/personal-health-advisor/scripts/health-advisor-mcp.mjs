#!/usr/bin/env node
// Cross-platform MCP bootstrap for WorkBuddy. It never uses sh, rm, mv or a
// platform-specific Python path; the Python process owns the MCP protocol.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wheels = join(skillDir, "wheels");
const lock = join(wheels, "requirements.txt");
// pip normalizes the project name in wheel filenames: healthcare-mcp is
// packaged as healthcare_mcp-<version>-*.whl.
const packageWheel = (await import("node:fs")).readdirSync(wheels).find((name) => /^healthcare[-_]mcp[-_]/.test(name) && name.endsWith(".whl"));
const fail = (message, code = 6) => { process.stderr.write(JSON.stringify({ error: "runtime", message, exit_code: code }) + "\n"); process.exit(code); };
if (!packageWheel || !existsSync(lock)) fail("Skill 包缺少运行 wheel 或 requirements.txt");

const isWindows = platform() === "win32";
const home = homedir();
const dataDir = process.env.HEALTH_ADVISOR_DATA_DIR || (isWindows ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "PersonalHealthAdvisor") : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "PersonalHealthAdvisor"));
const runtimeDir = process.env.HEALTH_ADVISOR_RUNTIME_DIR || (isWindows ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "PersonalHealthAdvisor", "runtime") : join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "PersonalHealthAdvisor"));
const lockText = readFileSync(lock, "utf8");
const lockHash = createHash("sha256").update(lockText).digest("hex").slice(0, 16);

function usablePython(candidate) {
  const result = spawnSync(candidate, ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return null;
  const match = String(result.stdout).trim().match(/^3\.(\d+)$/);
  return match && Number(match[1]) >= 11 ? { command: candidate, minor: match[1] } : null;
}
function findPython() {
  if (process.env.HEALTH_ADVISOR_PYTHON) return usablePython(process.env.HEALTH_ADVISOR_PYTHON);
  const managed = join(home, ".workbuddy", "binaries", "python", "versions");
  let current = "";
  try { current = readFileSync(join(managed, "current"), "utf8").trim(); } catch {}
  const candidates = [];
  if (current) candidates.push(join(managed, current, isWindows ? "python.exe" : "bin", isWindows ? "" : "python3"));
  for (const version of ["3.13.12", "3.13", "3.12", "3.11"]) candidates.push(join(managed, version, isWindows ? "python.exe" : "bin", isWindows ? "" : "python3"));
  candidates.push(...(isWindows ? ["python.exe", "python"] : ["python3.13", "python3.12", "python3.11", "python3"]));
  for (const candidate of candidates) { const found = usablePython(candidate); if (found) return found; }
  return null;
}
const python = findPython();
if (!python) fail("本机没有可用的 Python 3.11+；请安装 Python，或设置 HEALTH_ADVISOR_PYTHON");
const venv = join(runtimeDir, `venv-${python.minor}-${lockHash}`);
const venvPython = isWindows ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
mkdirSync(dataDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
if (!existsSync(venvPython)) {
  const made = spawnSync(python.command, ["-m", "venv", venv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (made.status !== 0) fail(`无法创建 Python 私有环境：${String(made.stderr).slice(-500)}`);
}
const marker = join(venv, "installed-wheel");
const wanted = `${packageWheel} ${lockHash}`;
let installed = "";
try { installed = readFileSync(marker, "utf8").trim(); } catch {}
if (installed !== wanted) {
  const log = join(venv, "install.log");
  const args = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--quiet", "--no-index", "--find-links", wheels, "--require-hashes", "-r", lock];
  let result = spawnSync(venvPython, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let detail = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0 && !process.env.HEALTH_ADVISOR_OFFLINE) {
    const pins = join(venv, "requirements.pins");
    writeFileSync(pins, lockText.replace(/ --hash=sha256:[^\n]+/g, ""));
    result = spawnSync(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--quiet", "--find-links", wheels, "-r", pins], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    detail += `${result.stdout || ""}${result.stderr || ""}`;
  }
  writeFileSync(log, detail);
  if (result.status !== 0) fail(`依赖安装失败，详见 ${log}`);
  writeFileSync(marker, wanted + "\n");
}
const child = spawn(venvPython, ["-m", "healthcare.advisor", "mcp"], { cwd: skillDir, env: { ...process.env, HEALTH_ADVISOR_DATA_DIR: dataDir }, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
