/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 回归：临时目录判定的**规范化**（CLOUD-CONFIG-TMPDIR-CANONICALITY）。
 *
 * 缺陷：旧实现用 `path.resolve(tmpdir())` 与 `path.resolve(dataDir)` 做词面前缀比较。
 * macOS 上 `os.tmpdir()` 返回 `/var/folders/...`，而真实路径是 `/private/var/folders/...`；
 * 把 `KIWI_CLOUD_DATA_DIR` 写成别名拼写即可绕过 `DATA_DIR_EPHEMERAL` 拒绝。
 *
 * 本文件证明两类行为：
 *   1. 真实入口 `loadCloudConfig`：别名拼写（含尚未创建的子路径）被拒；持久路径仍被接受；
 *      既有拒绝（等于制品根 / 落在随包目录）不变；
 *   2. 单元：最近存在祖先的规范化、路径分量边界比较、规范化失败 fail-closed。
 *
 * 边界：只证明配置解析器行为，不证明文件系统持久性、部署落位或运行时启动。
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudConfigError,
  __canonicalizePathWithoutCreate,
  __isPathInsideOrEqual,
  loadCloudConfig,
} from "../src/cloud/config.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** 在**非临时**位置建 scratch 父目录（家目录优先；无家目录时退回 cwd 旁），供"持久路径"用例使用。 */
function persistentScratch(prefix: string): string {
  const base = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  const dir = mkdtempSync(path.join(base, `.${prefix}`));
  scratchDirs.push(dir);
  return dir;
}

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PORT: "8080",
    KIWI_CLOUD_PUBLIC_ORIGIN: "https://kiwi-merchant.example.app.workbuddy.host",
    KIWI_CLOUD_DATA_DIR: "/workspace/.kiwi-runtime",
    KIWI_CLOUD_PROFILE: "/workspace/.kiwi-runtime/merchant.yaml",
    KIWI_CLOUD_A2A_AUTH: "signature",
    KIWI_CATALOG_URL: "https://catalog.test",
    ...overrides,
  };
}

function configError(env: Record<string, string | undefined>, artifactRoot = "/workspace"): CloudConfigError {
  try {
    loadCloudConfig(env, { artifactRoot });
  } catch (error) {
    if (error instanceof CloudConfigError) return error;
    throw error;
  }
  throw new Error("expected loadCloudConfig to throw");
}

describe("loadCloudConfig：临时目录的规范化包含判定", () => {
  it("别名拼写的状态目录（真实路径仍在临时目录内）→ DATA_DIR_EPHEMERAL", () => {
    const tmp = tmpdir();
    const canonicalTmp = realpathSync.native(tmp);
    // 仅当本机临时目录存在词面/真实路径差异（如 macOS /var ↔ /private/var）时才有别名可测。
    // 无别名时跳过入口级用例，但下面的单元用例仍覆盖同一段逻辑——不做静默跳过。
    if (canonicalTmp === tmp) {
      expect(canonicalTmp).toBe(tmp);
      return;
    }
    // 用真实路径拼写（`/private/var/...`），并追加一个**尚未创建**的子目录。
    const aliasSpelling = path.join(canonicalTmp, "kiwi-data-alias-not-created");
    const error = configError(baseEnv({ KIWI_CLOUD_DATA_DIR: aliasSpelling }));
    expect(error.code).toBe("DATA_DIR_EPHEMERAL");
  });

  it("持久路径（尚不存在）→ 接受，且校验不创建该目录", () => {
    // 在**非临时**父目录下取一个尚不存在的数据目录：家目录下建 scratch 父目录（测试自身创建，
    // 校验逻辑不得创建数据目录本身）。不依赖 Darwin 路径别名，也不改 TMPDIR。
    const parent = persistentScratch("kiwi-canon-persist-parent-");
    const dataDir = path.join(parent, "not-created-yet-data");
    expect(existsSync(dataDir)).toBe(false);

    const config = loadCloudConfig(baseEnv({ KIWI_CLOUD_DATA_DIR: dataDir }), {
      artifactRoot: path.join(parent, "artifact-root"),
    });

    expect(config.dataDir).toBe(path.resolve(dataDir));
    // 关键断言：校验不得创建目录
    expect(existsSync(dataDir)).toBe(false);
    // 且该目录真实路径确实不在临时目录内（否则本条用例没有意义）
    expect(__isPathInsideOrEqual(realpathSync.native(parent), realpathSync.native(tmpdir()))).toBe(
      false,
    );
  });

  it("符号链接指向临时目录祖先 → 规范化后仍判 DATA_DIR_EPHEMERAL", () => {
    const canonicalTmp = realpathSync.native(tmpdir());
    const parent = persistentScratch("kiwi-canon-link-alias-");
    // 链接目标在临时目录内：词面上 dataDir 位于家目录，规范化后才落入 tmp。
    const link = path.join(parent, "alias-into-tmp");
    const insideTmp = mkdtempSync(path.join(canonicalTmp, "kiwi-alias-target-"));
    scratchDirs.push(insideTmp);
    symlinkSync(insideTmp, link);

    const error = configError(
      baseEnv({ KIWI_CLOUD_DATA_DIR: path.join(link, "child") }),
      path.join(parent, "artifact-root"),
    );
    expect(error.code).toBe("DATA_DIR_EPHEMERAL");
  });

  it("符号链接自环 → 规范化失败 fail-closed，不退回词面比较", () => {
    const parent = persistentScratch("kiwi-canon-loop-");
    const a = path.join(parent, "loop-a");
    const b = path.join(parent, "loop-b");
    symlinkSync(b, a);
    symlinkSync(a, b);

    const error = configError(
      baseEnv({ KIWI_CLOUD_DATA_DIR: path.join(a, "child") }),
      path.join(parent, "artifact-root"),
    );
    expect(error.code).toBe("DATA_DIR_CANONICALIZATION_FAILED");
  });

  it("等于制品根 / 落在随包目录内 → 既有拒绝不变", () => {
    expect(configError(baseEnv({ KIWI_CLOUD_DATA_DIR: "/workspace" })).code).toBe(
      "DATA_DIR_IS_ARTIFACT_ROOT",
    );
    expect(configError(baseEnv({ KIWI_CLOUD_DATA_DIR: "/workspace/dist/data" })).code).toBe(
      "DATA_DIR_INSIDE_SHIPPED_DIR",
    );
  });

  it("规范化失败（祖先不可读）→ DATA_DIR_CANONICALIZATION_FAILED，且不退回词面比较", () => {
    const home = process.env.HOME;
    if (!home) return;
    const parent = mkdtempSync(path.join(home, ".kiwi-canon-fail-"));
    scratchDirs.push(parent);
    const guarded = path.join(parent, "guarded");
    mkdirSync(guarded, { mode: 0o000 });
    const target = path.join(guarded, "child", "deeper");
    let error: CloudConfigError | undefined;
    try {
      loadCloudConfig(baseEnv({ KIWI_CLOUD_DATA_DIR: target }), { artifactRoot: "/workspace" });
    } catch (caught) {
      error = caught as CloudConfigError;
    }
    // root 用户可越过 0o000，此时无法构造失败——如实断言"没有静默通过"。
    if (error) {
      expect(error.code).toBe("DATA_DIR_CANONICALIZATION_FAILED");
    } else {
      expect(process.getuid?.()).toBe(0);
    }
  });
});

describe("__canonicalizePathWithoutCreate", () => {
  it("不存在的后缀被原样接回最近的已存在祖先", () => {
    const root = scratch("kiwi-canon-");
    const real = realpathSync.native(root);
    const nested = path.join(root, "a", "b", "c");
    expect(__canonicalizePathWithoutCreate(nested)).toBe(path.join(real, "a", "b", "c"));
  });

  it("符号链接别名被解析到真实路径", () => {
    const root = scratch("kiwi-canon-link-");
    const target = path.join(root, "target");
    mkdirSync(target);
    const link = path.join(root, "link");
    symlinkSync(target, link);
    expect(__canonicalizePathWithoutCreate(path.join(link, "child"))).toBe(
      path.join(realpathSync.native(target), "child"),
    );
  });
});

describe("__isPathInsideOrEqual", () => {
  it("按路径分量判断，不做字符串前缀", () => {
    expect(__isPathInsideOrEqual("/a/b/c", "/a/b")).toBe(true);
    expect(__isPathInsideOrEqual("/a/b", "/a/b")).toBe(true);
    expect(__isPathInsideOrEqual("/a/bc", "/a/b")).toBe(false);
    expect(__isPathInsideOrEqual("/a", "/a/b")).toBe(false);
  });
});
