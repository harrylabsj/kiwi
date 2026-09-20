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
 * 验收矩阵 meta 测试（设计 v0.1.1 §19.2）：
 *   - fixture 80 项规格完整（编号唯一、G/W/T 齐备、初始 NOT_RUN 不被改写）；
 *   - L1 回填诚实性：每条 PASS 的证据必须真实存在于对应测试文件
 *     （按测试标题子串 grep）——证据失配即失败，禁止「文件存在就算证据」；
 *   - PASS 只允许出现在有自动化测试的阶段；L2/L3 语义的条目不得回填。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVIDENCE_TESTS, loadAcceptanceMatrix } from "./acceptance-matrix.js";

const testsDir = import.meta.dirname;
const repoRoot = path.resolve(testsDir, "..", "..");
const fixturesDir = path.join(testsDir, "fixtures");
const matrix = loadAcceptanceMatrix(fixturesDir);

describe("RFQ 验收矩阵完整性", () => {
  it("80 项规格：编号唯一、G/W/T 齐备、fixture 初始状态 NOT_RUN", () => {
    const raw = JSON.parse(
      readFileSync(path.join(fixturesDir, "acceptance-matrix.json"), "utf8"),
    ) as { cases: Array<{ id: string; status: string; given: string; when: string; then: string }> };
    expect(raw.cases).toHaveLength(80);
    expect(new Set(raw.cases.map((c) => c.id)).size).toBe(80);
    for (const c of raw.cases) {
      expect(c.status, `${c.id} fixture 初始必须 NOT_RUN`).toBe("NOT_RUN");
      expect(c.given.trim(), `${c.id} 缺 given`).not.toBe("");
      expect(c.when.trim(), `${c.id} 缺 when`).not.toBe("");
      expect(c.then.trim(), `${c.id} 缺 then`).not.toBe("");
    }
    expect(matrix.cases).toHaveLength(80);
  });

  it("L1 回填只指向真实存在的测试与真实测试标题", () => {
    const evidenceFiles = Object.values(EVIDENCE_TESTS);
    for (const rel of evidenceFiles) {
      expect(existsSync(path.join(repoRoot, rel)), `证据文件不存在：${rel}`).toBe(true);
    }
    const caches = new Map<string, string>();
    const textOf = (rel: string): string => {
      let text = caches.get(rel);
      if (text === undefined) {
        text = readFileSync(path.join(repoRoot, rel), "utf8");
        caches.set(rel, text);
      }
      return text;
    };
    const passItems = matrix.cases.filter((c) => c.status === "PASS");
    for (const item of passItems) {
      const entry = item.evidence;
      expect(entry.length, `${item.id} PASS 必须有证据`).toBeGreaterThan(0);
      for (const anchor of entry) {
        // 锚点 = 测试标题子串（it.each 模板用 %s 表示）；注记在 evidence_note，不参与匹配。
        const title = anchor.trim();
        if (title.startsWith("pipeline:")) {
          // 流水线证据：只要求显式声明 verify 承载（不冒充单测）。
          expect(title).toContain("npm run verify");
          continue;
        }
        const file = evidenceFiles.find((rel) => textOf(rel).includes(title));
        expect(file, `${item.id} 的证据「${title}」在测试文件中不存在（证据失配或测试被改名）`).toBeDefined();
      }
    }
  });

  it("npm run verify 不是回填豁免：HO-09 之外的『全量回归』类锚点不得存在", () => {
    for (const item of matrix.cases.filter((c) => c.status === "PASS")) {
      for (const anchor of item.evidence) {
        if (anchor.startsWith("pipeline:")) {
          expect(item.id, "流水线证据仅限全量回归条目").toBe("HO-09");
        }
      }
    }
  });

  it("覆盖统计：M1–M3 为主，L2/L3 语义条目保持 NOT_RUN", () => {
    // L2（真实实机）语义的条目必须 NOT_RUN——宿主仿真不替代实机。
    const l2Semantics = new Set(["HO-01", "HO-03", "HO-04", "HO-06", "HO-10"]);
    for (const item of matrix.cases) {
      if (l2Semantics.has(item.id)) {
        expect(item.status, `${item.id} 属实机/试点语义，不得回填 L1`).toBe("NOT_RUN");
      }
    }
    expect(matrix.byPhase.M1?.pass ?? 0).toBeGreaterThan(0);
    expect(matrix.byPhase.M2?.pass ?? 0).toBeGreaterThan(0);
    expect(matrix.byPhase.M3?.pass ?? 0).toBeGreaterThan(0);
    // 明确输出当前覆盖面（供交接阅读；不作为断言阈值——回填只增不减）。
    const summary = Object.entries(matrix.byPhase)
      .map(([phase, c]) => `${phase}: ${c.pass} PASS / ${c.notRun} NOT_RUN`)
      .join("；");
    expect(summary).toMatch(/PASS/);
  });
});
