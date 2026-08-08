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
 * QR 编码器（零运行时依赖，纯函数）——微信扫码登录的终端二维码渲染。
 *
 * 规格：ISO/IEC 18004，Byte mode，纠错级别 L，版本 1–10。
 * 流水线：版本选择 → 位流（模式/长度/数据/终结/填充）→ Reed-Solomon
 * （GF(2^8) 0x11D，多块交织）→ 矩阵放置（finder/timing/alignment/dark/
 * 数据 zigzag）→ 8 掩码全试（penalty N1–N4 最低胜出）→ format/version 信息。
 * 正确性由测试双重验证：qrcode 库矩阵对照 + jsqr 解码回环。
 */

import { WeixinError } from "./types.js";

/** 版本容量表（字节，纠错 L；索引 = 版本号 1..10）。 */
const CAPACITY_BYTE_L: readonly number[] = [
  17, 32, 53, 78, 106, 134, 154, 192, 230, 271,
];

/** 总码字数（含 ECC；索引 = 版本号 1..10）。 */
const TOTAL_CODEWORDS: readonly number[] = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
];

/** 每块 ECC 码字数（纠错 L；索引 = 版本号 1..10）。 */
const ECC_PER_BLOCK_L: readonly number[] = [
  7, 10, 15, 20, 26, 18, 20, 24, 30, 36,
];

/** 块数（纠错 L；索引 = 版本号 1..10）。 */
const BLOCKS_L: readonly number[] = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2];

/** 对齐图案中心坐标（索引 = 版本号 1..10；v1 无）。 */
const ALIGNMENT_PATTERNS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// ── GF(2^8) 有限域（本原多项式 0x11D）──────────────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Reed-Solomon 生成多项式 g(x) = ∏(x − α^i)，i=0..ecc-1。 */
function rsGeneratorPoly(ecc: number): Uint8Array {
  const g = new Uint8Array(ecc + 1);
  g[0] = 1;
  for (let i = 0; i < ecc; i++) {
    const next = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      if (g[j] !== 0) {
        next[j]! ^= g[j]!;
        next[j + 1]! ^= gfMul(g[j]!, GF_EXP[i]!);
      }
    }
    g.set(next.subarray(0, ecc + 1));
  }
  return g;
}

/**
 * 计算一块数据的 ECC 码字（多项式长除法，复刻 qrcode 库 mod 算法）。
 * 生成多项式 g 高次在前（g[0] = x^ecc 系数）；每步取被除数首项系数
 * 消元 divisor 对齐项，直至被除数次数 < divisor 次数。
 */
function rsComputeEcc(data: Uint8Array, ecc: number): Uint8Array {
  const g = rsGeneratorPoly(ecc);
  // 被除数 = data || 0^ecc（多项式除法余数即 ECC）
  let result = new Uint8Array(data.length + ecc);
  result.set(data);
  let offset = 0;
  while (result.length - offset - g.length >= 0) {
    const coeff = result[offset]!;
    for (let i = 0; i < g.length; i++) {
      result[offset + i] = (result[offset + i]! ^ gfMul(g[i]!, coeff)) as number;
    }
    // 去掉前导零
    while (offset < result.length && result[offset] === 0) offset++;
  }
  // 余数（可能短于 ecc，前补零）
  const rem = result.slice(offset);
  const out = new Uint8Array(ecc);
  out.set(rem, ecc - rem.length);
  return out;
}

// ── 位流（Byte mode）──────────────────────────────────────────────────

function buildBitStream(bytes: Uint8Array, version: number, dataCodewords: number): Uint8Array {
  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // Byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCodewords * 8 - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0); // 字节对齐
  let pad = 0xec; // 填充 0xEC/0x11 交替
  while (bits.length < dataCodewords * 8) {
    push(pad, 8);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  const out = new Uint8Array(dataCodewords);
  for (let i = 0; i < dataCodewords; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b]!;
    out[i] = v as number;
  }
  return out;
}

/** 块拆分 + ECC 计算 + 按块轮转交织。 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const blocks = BLOCKS_L[version - 1]!;
  const totalData = TOTAL_CODEWORDS[version - 1]! - ECC_PER_BLOCK_L[version - 1]! * blocks;
  const eccPerBlock = ECC_PER_BLOCK_L[version - 1]!;
  const perBlock = totalData / blocks;
  const blockData: Uint8Array[] = [];
  for (let b = 0; b < blocks; b++) blockData.push(data.subarray(b * perBlock, (b + 1) * perBlock));
  const eccBlocks = blockData.map((bd) => rsComputeEcc(bd, eccPerBlock));
  const out = new Uint8Array(totalData + blocks * eccPerBlock);
  let i = 0;
  for (let r = 0; r < perBlock; r++) for (let b = 0; b < blocks; b++) out[i++] = blockData[b]![r]!;
  for (let r = 0; r < eccPerBlock; r++) for (let b = 0; b < blocks; b++) out[i++] = eccBlocks[b]![r]!;
  return out;
}

// ── 掩码与惩罚 ─────────────────────────────────────────────────────────

/** 掩码 0–7 判定（x, y 为模块坐标）。 */
export function maskPattern(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

/** 惩罚分（与 qrcode 库 mask-pattern.js 逐位一致：N1/N2/N3 滑动窗口/N4 ceil）。 */
function penaltyScore(m: Uint8Array, size: number): number {
  const get = (y: number, x: number): number => m[y * size + x]!;
  let score = 0;

  // N1: 行/列连续同色 ≥5，每多 1 个 +1（count=5→3, 6→4, ...）
  for (let row = 0; row < size; row++) {
    let sameCol = 0;
    let sameRow = 0;
    let lastCol: number | null = null;
    let lastRow: number | null = null;
    for (let col = 0; col < size; col++) {
      const mc = get(row, col);
      if (mc === lastCol) sameCol++;
      else {
        if (sameCol >= 5) score += 3 + (sameCol - 5);
        lastCol = mc;
        sameCol = 1;
      }
      const mr = get(col, row);
      if (mr === lastRow) sameRow++;
      else {
        if (sameRow >= 5) score += 3 + (sameRow - 5);
        lastRow = mr;
        sameRow = 1;
      }
    }
    if (sameCol >= 5) score += 3 + (sameCol - 5);
    if (sameRow >= 5) score += 3 + (sameRow - 5);
  }

  // N2: 2×2 同色块
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const last =
        get(row, col) + get(row, col + 1) + get(row + 1, col) + get(row + 1, col + 1);
      if (last === 4 || last === 0) score += 3;
    }
  }

  // N3: 11 位滑动窗口匹配 0x5D0（10111010000）或 0x05D（00001011101）
  for (let row = 0; row < size; row++) {
    let bitsCol = 0;
    let bitsRow = 0;
    for (let col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | get(row, col);
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) score += 40;
      bitsRow = ((bitsRow << 1) & 0x7ff) | get(col, row);
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) score += 40;
    }
  }

  // N4: 暗模块比例偏离 50%（ceil 到 5% 步进）
  let dark = 0;
  for (let i = 0; i < size * size; i++) dark += m[i]!;
  const k = Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10);
  score += k * 10;
  return score;
}

// ── 格式/版本信息 ──────────────────────────────────────────────────────

/** 求最高有效位编号（qrcode 库 getBCHDigit 同款）。 */
function bchDigit(value: number): number {
  let digit = 0;
  while (value !== 0) {
    digit++;
    value >>>= 1;
  }
  return digit;
}

/** BCH 除法（从实际最高位开始，避免高位置零导致错位）。 */
function bchRemainder(data: number, gen: number, genDigit: number): number {
  let d = data;
  while (bchDigit(d) - genDigit >= 0) {
    d ^= gen << (bchDigit(d) - genDigit);
  }
  return d;
}

/** BCH(15,5) 格式信息：data=EC(2b)|mask(3b)，纠错后 XOR G15_MASK。 */
function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask;
  const gen = 0b10100110111;
  const mask15 = 0b101010000010010;
  const d = bchRemainder(data << 10, gen, bchDigit(gen));
  return ((data << 10) | d) ^ mask15;
}

/** BCH(18,6) 版本信息（v7+）。 */
function versionBits(version: number): number {
  const gen = 0b1111100100101;
  const d = bchRemainder(version << 12, gen, bchDigit(gen));
  return (version << 12) | d;
}

// ── 矩阵构建 ───────────────────────────────────────────────────────────

interface Matrix {
  size: number;
  m: Uint8Array; // 模块值 0/1
  reserved: Uint8Array; // 1 = 功能图案（不参与掩码）
}

function newMatrix(version: number): Matrix {
  const size = version * 4 + 17;
  return { size, m: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function drawFinder(matrix: Matrix, cx: number, cy: number): void {
  const { size, m, reserved } = matrix;
  // 7×7 图案（±3）+ 分离带（±4）；以 finder 中心 (cx, cy) 定位。
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      reserved[y * size + x] = 1;
      const inPattern = dx >= -3 && dx <= 3 && dy >= -3 && dy <= 3;
      if (inPattern) {
        const border = Math.abs(dx) === 3 || Math.abs(dy) === 3;
        const inner = Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
        m[y * size + x] = border || inner ? 1 : 0;
      } else {
        m[y * size + x] = 0; // 分离带
      }
    }
  }
}

/** 放置功能图案并返回 (matrix, 数据位总长)。 */
function buildBaseMatrix(version: number, codewords: Uint8Array): Matrix {
  const matrix = newMatrix(version);
  const { size, m, reserved } = matrix;

  drawFinder(matrix, 3, 3);
  drawFinder(matrix, size - 4, 3);
  drawFinder(matrix, 3, size - 4);

  // Timing（第 6 行/列）
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    reserved[6 * size + i] = 1;
    m[6 * size + i] = v;
    reserved[i * size + 6] = 1;
    m[i * size + 6] = v;
  }

  // Alignment（跳过与 finder 重叠）
  const centers = ALIGNMENT_PATTERNS[version - 1]!;
  for (const cy of centers) {
    for (const cx of centers) {
      const overlaps =
        (cx <= 6 && cy <= 6) || (cx >= size - 7 && cy <= 6) || (cx <= 6 && cy >= size - 7);
      if (overlaps) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          reserved[y * size + x] = 1;
          m[y * size + x] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0;
        }
      }
    }
  }

  // Dark module (8, 4·version+9)
  reserved[(version * 4 + 9) * size + 8] = 1;
  m[(version * 4 + 9) * size + 8] = 1;

  // Format info 区域（两处复制）先 reserve——数据 zigzag 不得占用
  // （否则消耗数据位导致后续全部错位）。值在 applyMask 末尾写入。
  // 坐标布局与 qrcode 库 setupFormatInfo 逐位一致（库参数序为 (row=y, col=x)）。
  const reserveFormat = (y: number, x: number): void => {
    if (x >= 0 && y >= 0 && x < size && y < size) reserved[y * size + x] = 1;
  };
  for (let i = 0; i < 15; i++) {
    // 垂直段（x=8 列）
    if (i < 6) reserveFormat(i, 8);
    else if (i < 8) reserveFormat(i + 1, 8);
    else reserveFormat(size - 15 + i, 8);
    // 水平段（y=8 行）
    if (i < 8) reserveFormat(8, size - i - 1);
    else if (i < 9) reserveFormat(8, 15 - i - 1 + 1);
    else reserveFormat(8, 15 - i - 1);
  }
  reserveFormat(size - 8, 8); // 固定暗模块

  // Version info 区域（v7+，两处 3×6 对称块；库参数序 (row=y, col=x)）
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const y = Math.floor(i / 3);
      const x = (i % 3) + size - 11;
      reserveFormat(y, x);
      reserveFormat(x, y);
    }
  }

  // 数据 zigzag 放置（与 qrcode 库 setupData 逐位一致）：
  // 从右下角起，每 2 列一组向上蛇行；跳过第 6 列；reserved 位跳过不消耗位；
  // 数据耗尽后余位继续走（值保持 0，bitIndex 继续递减）。
  let row = size - 1;
  let inc = -1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const x = col - c;
        const y = row;
        if (reserved[y * size + x] === 0) {
          if (byteIndex < codewords.length) {
            const byte = codewords[byteIndex]!;
            m[y * size + x] = (byte >> bitIndex) & 1;
          }
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || size <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  return matrix;
}

/** 对数据位应用掩码并绘制 format/version 信息。 */
function applyMask(matrix: Matrix, version: number, mask: number): void {
  const { size, m, reserved } = matrix;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (reserved[y * size + x] === 0 && maskPattern(mask, x, y)) {
        m[y * size + x] = m[y * size + x] === 0 ? 1 : 0;
      }
    }
  }
  // Format info（两处复制，坐标布局与 qrcode 库 setupFormatInfo 一致，
  // 库参数序为 (row=y, col=x)）
  const bits = formatBits(mask);
  const setFormat = (y: number, x: number, bit: number): void => {
    m[y * size + x] = bit as number;
  };
  for (let i = 0; i < 15; i++) {
    const mod = (bits >> i) & 1;
    // 垂直段（x=8 列）
    if (i < 6) setFormat(i, 8, mod);
    else if (i < 8) setFormat(i + 1, 8, mod);
    else setFormat(size - 15 + i, 8, mod);
    // 水平段（y=8 行）
    if (i < 8) setFormat(8, size - i - 1, mod);
    else if (i < 9) setFormat(8, 15 - i - 1 + 1, mod);
    else setFormat(8, 15 - i - 1, mod);
  }
  setFormat(size - 8, 8, 1); // 固定暗模块
  // Version info（v7+，两处 3×6 对称块）
  if (version >= 7) {
    const vbits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >> i) & 1;
      const y = Math.floor(i / 3);
      const x = (i % 3) + size - 11;
      setFormat(y, x, bit);
      setFormat(x, y, bit);
    }
  }
}

/**
 * 生成 QR 码矩阵（1 = 暗模块）。版本自动选择（1–10，纠错 L），
 * 8 掩码全试 penalty 最低胜出。超长（>271 字节）抛 WeixinError("validation")。
 */
export function encodeQrMatrix(payload: string): Uint8Array {
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length === 0) {
    throw new WeixinError("validation", "QR 载荷为空");
  }
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= CAPACITY_BYTE_L[v - 1]!) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new WeixinError("validation", `QR 载荷过长（${bytes.length} 字节，上限 271）`);
  }
  const dataCodewords = TOTAL_CODEWORDS[version - 1]! - ECC_PER_BLOCK_L[version - 1]! * BLOCKS_L[version - 1]!;
  const bitStream = buildBitStream(bytes, version, dataCodewords);
  const codewords = interleave(bitStream, version);

  // 8 掩码全试：penalty 最低者胜出
  let best: Matrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = buildBaseMatrix(version, codewords);
    applyMask(candidate, version, mask);
    const score = penaltyScore(candidate.m, candidate.size);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best!.m;
}

/** 终端渲染：半块字符（00→" "、01→"▀"、10→"▄"、11→"█"），静区 4。 */
export function renderQrMatrix(matrix: Uint8Array, size: number, scale = 1): string[] {
  const quiet = 4;
  const rows: string[] = [];
  // 顶静区（偶数行对齐：静区行全白）
  for (let r = 0; r < quiet / 2; r++) rows.push(" ".repeat((size + quiet * 2) * scale));
  for (let y = 0; y < size; y += 2) {
    let line = " ".repeat(quiet * scale);
    for (let x = 0; x < size; x++) {
      const top = y < size ? matrix[y * size + x]! : 0;
      const bottom = y + 1 < size ? matrix[(y + 1) * size + x]! : 0;
      const pair = (top << 1) | bottom;
      const ch = pair === 0 ? " " : pair === 1 ? "▀" : pair === 2 ? "▄" : "█";
      line += ch.repeat(scale);
    }
    line += " ".repeat(quiet * scale);
    rows.push(line);
  }
  // 底静区
  for (let r = 0; r < quiet / 2; r++) rows.push(" ".repeat((size + quiet * 2) * scale));
  return rows;
}

/** 便捷入口：payload → 渲染行（静区已含，可直接 stdout）。 */
export function renderQr(payload: string, scale = 1): string[] {
  const m = encodeQrMatrix(payload);
  const size = Math.sqrt(m.length);
  return renderQrMatrix(m, size, scale);
}
