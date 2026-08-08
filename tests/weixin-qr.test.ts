/**
 * QR 编码器测试（weixin 通道）——正确性双重验证：
 * (a) qrcode 库矩阵对照（同版本同掩码同模块逐位一致）；
 * (b) jsqr 解码回环（真正证明可扫描）。
 * 覆盖：版本选择、中文/长 URL、超长拒绝、渲染输出。
 */
import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
// jsqr 是 CJS 包（main: dist/jsQR.js，types 为 ESM 风格 default export），
// NodeNext 下 default import 类型不兼容 → 用 createRequire 拿运行时函数，
// 类型手动声明（与 dist/index.d.ts 的 QRCode 接口一致）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const jsqr = require("jsqr") as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
import { encodeQrMatrix, renderQr, renderQrMatrix, maskPattern } from "../src/weixin/qr.js";
import { WeixinError } from "../src/weixin/types.js";

/** 用 qrcode 库生成参考矩阵（L 纠错），返回 {size, mask, get(x,y)}。
 * 注意：库 BitMatrix.get(row, col) 参数序为 (row=y, col=x)。 */
function referenceMatrix(payload: string): { size: number; mask: number; get: (x: number, y: number) => number } {
  const q = QRCode.create(payload, { errorCorrectionLevel: "L" });
  return {
    size: q.modules.size,
    mask: q.maskPattern as number,
    get: (x: number, y: number) => (q.modules.get(y, x) ? 1 : 0),
  };
}

/** 把矩阵渲染成黑白像素（scale≥4 供 jsqr 定位），含静区。 */
function toPixels(matrix: Uint8Array, size: number, quiet = 4, scale = 4): { data: Uint8ClampedArray; width: number } {
  const w = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && matrix[my * size + mx] === 1;
      const v = dark ? 0 : 255;
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: w };
}

const SAMPLE_URLS = [
  "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=857e46914ef38fbf2a734a935ef14aa3&bot_type=3", // iLink 实测
  "https://example.com",
  "https://kiwi.harrylabsj.com",
  "https://catalog.kiwi.harrylabsj.com/v1/agents/search?q=merchant&limit=20&cursor=abc",
  "https://a.b/c", // 超短
  "https://极短.com/中文路径/测试", // 中文（Byte mode）
  "a".repeat(16), // v1 容量内
  "x".repeat(50), // v3
  "y".repeat(100), // v5
  "z".repeat(150), // v7
  "https://very.long.example.com/path?with=query&params=that&push=the&url=over&150=bytes&for=the&qr=encoder&test=coverage&padding=value",
];

describe("encodeQrMatrix（与 qrcode 库矩阵对照）", () => {
  for (const url of SAMPLE_URLS) {
    it(`逐位一致: ${url.length > 50 ? url.slice(0, 50) + "…" : url} (${url.length} 字符)`, () => {
      const ours = encodeQrMatrix(url);
      const ref = referenceMatrix(url);
      const ourSize = Math.sqrt(ours.length);
      expect(ourSize).toBe(ref.size);
      for (let y = 0; y < ref.size; y++) {
        for (let x = 0; x < ref.size; x++) {
          expect(ours[y * ref.size + x], `module(${x},${y})`).toBe(ref.get(x, y));
        }
      }
    });
  }
});

describe("jsqr 解码回环（可扫描性）", () => {
  for (const url of SAMPLE_URLS) {
    it(`解码回原文: ${url.length > 50 ? url.slice(0, 50) + "…" : url}`, () => {
      const matrix = encodeQrMatrix(url);
      const size = Math.sqrt(matrix.length);
      const { data, width } = toPixels(matrix, size);
      const result = jsqr(data, width, width);
      expect(result).not.toBeNull();
      expect(result!.data).toBe(url);
    });
  }
});

describe("版本选择", () => {
  it("短载荷选最小版本", () => {
    const v1 = encodeQrMatrix("https://a.b"); // 10 字节 → v1（容量 17）
    expect(Math.sqrt(v1.length)).toBe(21);
    const v2 = encodeQrMatrix("x".repeat(20)); // v2（容量 32）
    expect(Math.sqrt(v2.length)).toBe(25);
  });

  it("超过 271 字节抛 validation（fail-closed）", () => {
    expect(() => encodeQrMatrix("x".repeat(272))).toThrow(WeixinError);
  });

  it("空载荷抛 validation", () => {
    expect(() => encodeQrMatrix("")).toThrow(WeixinError);
  });
});

describe("renderQr / renderQrMatrix（终端渲染）", () => {
  it("渲染行高 = 静区 + 每 2 模块 1 行", () => {
    const matrix = encodeQrMatrix("https://example.com");
    const size = Math.sqrt(matrix.length);
    const rows = renderQrMatrix(matrix, size);
    expect(rows.length).toBe(Math.ceil(size / 2) + 4); // 静区上下各 2 行
    for (const line of rows) {
      expect(line.length).toBe(size + 8);
    }
  });

  it("渲染后行含半块字符", () => {
    const rows = renderQr("https://example.com");
    expect(rows.join("\n")).toContain("█");
  });

  it("scale=2 时列宽翻倍", () => {
    const rows = renderQr("https://example.com", 2);
    const base = renderQr("https://example.com", 1);
    expect(rows[0]!.length).toBe(base[0]!.length * 2 - 0);
    // 静区 + 模块区都翻倍
    expect(rows[0]!.length).toBeGreaterThan(base[0]!.length);
  });

  it("渲染出的像素图仍可被 jsqr 解码（含静区）", () => {
    const url = "https://liteapp.weixin.qq.com/q/7GiQu1?bot_type=3";
    const matrix = encodeQrMatrix(url);
    const size = Math.sqrt(matrix.length);
    const { data, width } = toPixels(matrix, size);
    const decoded = jsqr(data, width, width);
    expect(decoded?.data).toBe(url);
  });
});

describe("maskPattern（掩码判定 sanity——公式正确性由矩阵对照隐式覆盖）", () => {
  it("8 个掩码都返回布尔", () => {
    for (let mask = 0; mask < 8; mask++) {
      for (const [x, y] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [7, 11],
        [20, 13],
      ] as const) {
        expect(typeof maskPattern(mask, x, y)).toBe("boolean");
      }
    }
  });
  it("同坐标同掩码幂等", () => {
    for (let mask = 0; mask < 8; mask++) {
      expect(maskPattern(mask, 5, 7)).toBe(maskPattern(mask, 5, 7));
    }
  });
});
