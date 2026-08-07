/**
 * TUI 主题/横幅/样式层单测（Neural Awakening；零依赖 ANSI）。
 *
 * 字节直通契约是核心：mode="off" 时 decorate/box/panel/rule/segments/banner
 * 的输出与升级前逐字节一致（非 TTY 回归的根基）。
 */
import { describe, expect, it } from "vitest";
import { KIWI_ART, gradientText, kiwiBanner, rowGradient } from "../src/tui/banner.js";
import { createTheme } from "../src/tui/styles.js";
import {
  detectColorMode,
  hexToRgb,
  isWide,
  paint,
  rgb,
  sgr,
  visibleWidth,
} from "../src/tui/theme.js";

const ESC = "\u001b";

/** 24bit 主题（显式 override，不依赖 env）。 */
function theme24(): ReturnType<typeof createTheme> {
  return createTheme({ isTTY: true }, { color: "24bit" });
}

describe("theme 原语", () => {
  it("rgb 产出 24-bit 前景 SGR", () => {
    expect(rgb("#4FC3F7")).toBe(`${ESC}[38;2;79;195;247m`);
    expect(hexToRgb("#00BCD4")).toEqual([0, 188, 212]);
    expect(() => hexToRgb("nope")).toThrow();
  });

  it("paint：off 直通原文，24bit 包裹 SGR，basic 用 16 色表", () => {
    expect(paint("hi", "off", "primary")).toBe("hi");
    expect(paint("hi", "24bit", "primary")).toBe(`${ESC}[38;2;79;195;247mhi${ESC}[0m`);
    expect(paint("hi", "24bit", "warn", { bold: true })).toBe(
      `${ESC}[1m${ESC}[38;2;255;213;79mhi${ESC}[0m`,
    );
    expect(paint("hi", "basic", "accent")).toBe(`${ESC}[36mhi${ESC}[0m`);
    expect(sgr("off", "primary")).toBe("");
  });

  it("visibleWidth 剥离 ANSI 并计 CJK 双宽", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth(`${ESC}[38;2;79;195;247mabc${ESC}[0m`)).toBe(3);
    expect(visibleWidth("中文")).toBe(4);
    expect(visibleWidth(`${ESC}[2m中${ESC}[0m文`)).toBe(4);
  });

  it("isWide 覆盖 CJK 主区间", () => {
    expect(isWide("中")).toBe(true);
    expect(isWide("─")).toBe(false); // box 绘制字符按单宽计（对齐依据）
    expect(isWide("a")).toBe(false);
    expect(isWide(" ")).toBe(false);
  });
});

describe("detectColorMode", () => {
  it("非 TTY / NO_COLOR / TERM=dumb → off", () => {
    expect(detectColorMode({ TERM: "xterm-256color" }, false)).toBe("off");
    expect(detectColorMode({ TERM: "xterm-256color", NO_COLOR: "1" }, true)).toBe("off");
    expect(detectColorMode({ TERM: "dumb" }, true)).toBe("off");
  });

  it("COLORTERM=truecolor 或现代 TERM → 24bit", () => {
    expect(detectColorMode({ COLORTERM: "truecolor" }, true)).toBe("24bit");
    expect(detectColorMode({ TERM: "kitty" }, true)).toBe("24bit");
    expect(detectColorMode({ TERM: "tmux-256color" }, true)).toBe("24bit");
  });

  it("xterm-256color 无 COLORTERM → basic 退化", () => {
    expect(detectColorMode({ TERM: "xterm-256color" }, true)).toBe("basic");
    expect(detectColorMode({ TERM: "xterm" }, true)).toBe("24bit"); // 无 256color 后缀的现代 xterm
  });
});

describe("banner", () => {
  it("KIWI_ART 六行等宽（30 列 box 字符）", () => {
    expect(KIWI_ART).toHaveLength(6);
    for (const line of KIWI_ART) {
      expect(visibleWidth(line)).toBe(30);
    }
  });

  it("gradientText 逐字符上色、空格直通", () => {
    const painted = gradientText("A B");
    expect(painted.startsWith(`${ESC}[38;2;`)).toBe(true);
    // 空格未涂色：reset 与下一段着色之间是裸空格
    expect(painted).toContain(`${ESC}[0m ${ESC}[38;2;`);
  });

  it("kiwiBanner：24bit 含逐行渐变 art，off 为空串", () => {
    expect(kiwiBanner("24bit")).toContain(`${ESC}[38;2;`);
    expect(kiwiBanner("24bit")).toContain("██"); // box 字符 art
    expect(kiwiBanner("off")).toBe("");
  });

  it("rowGradient：每行一个颜色（垂直渐变，hermes logo 风格）", () => {
    const painted = rowGradient(["AA", "BB"]);
    // 两行颜色不同（首行蓝、末行近白）
    expect(painted).toContain(`${ESC}[38;2;79;195;247mAA${ESC}[0m`);
    expect(painted).toContain(`${ESC}[38;2;224;247;250mBB${ESC}[0m`);
  });
});

describe("styles 语义层（24bit）", () => {
  const theme = theme24();

  it("decorate：前缀表全套上色", () => {
    const cases: Array<[string, string]> = [
      ["[通知] 任务已安排", `${ESC}[38;2;255;213;79m`],
      ["[任务] fetch failed", `${ESC}[38;2;239;83;80m`],
      ["[磋商] 回合 1", `${ESC}[38;2;0;188;212m`],
      ["[negotiate] 与 agent 磋商中", `${ESC}[38;2;0;188;212m`],
      ["[a2a] node@http://x", `${ESC}[38;2;79;195;247m`],
      ["[discover] cagt_x", `${ESC}[38;2;79;195;247m`],
      ["[handoff] 候选 1 个", `${ESC}[38;2;0;188;212m`],
      ["[记忆] 已记住", `${ESC}[38;2;79;195;247m`],
      ["[模式] 已切换", `${ESC}[38;2;79;195;247m`],
      ["[审批] 等待批准", `${ESC}[38;2;0;188;212m`],
      ["[注册] 已注册", `${ESC}[38;2;129;199;132m`],
      ["[私有] 决策说明", `${ESC}[2m${ESC}[38;2;143;163;191m`],
      ["[系统记录] 事件", `${ESC}[2m${ESC}[38;2;143;163;191m`],
      ["[已发送] 决策已提交", `${ESC}[38;2;129;199;132m`],
    ];
    for (const [input, sgrExpect] of cases) {
      const out = theme.decorate(input);
      const prefix = input.slice(0, input.indexOf("]") + 1);
      const suffix = input.slice(input.indexOf("]") + 1);
      expect(out.startsWith(sgrExpect + prefix), input).toBe(true);
      expect(out).toContain(suffix); // 前缀后的原文保留
      expect(out).toContain(`${ESC}[0m`);
    }
  });

  it("decorate：长前缀不被短前缀截胡；多行逐行；未知前缀不动", () => {
    const open = theme.decorate("[handoff-open] 已确认打开");
    expect(open.startsWith(`${ESC}[38;2;0;188;212m[handoff-open]`)).toBe(true);
    const multi = theme.decorate("[通知] 第一行\n普通第二行\n[任务] 第三行");
    const lines = multi.split("\n");
    expect(lines[0]).toContain(`${ESC}[38;2;255;213;79m`);
    expect(lines[1]).toBe("普通第二行");
    expect(lines[2]).toContain(`${ESC}[38;2;239;83;80m`);
    expect(theme.decorate("模型回复没有前缀")).toBe("模型回复没有前缀");
    expect(theme.decorate("公开草稿: hello")).toContain(`${ESC}[1m`);
  });

  it("decorate：off 直通原文（逐字节）", () => {
    const off = createTheme({ isTTY: false }, { color: "off" });
    expect(off.decorate("[通知] 任务已安排")).toBe("[通知] 任务已安排");
    expect(off.decorate("模型回复\n[任务] x")).toBe("模型回复\n[任务] x");
  });

  it("box：不等宽行 padding 对齐（含 CJK 与 ANSI 行）", () => {
    const out = theme.box(["abc", "中文", `${ESC}[38;2;0;188;212mxy${ESC}[0m`]);
    const rows = out.split("\n");
    expect(rows[0]).toContain("┌");
    expect(rows[rows.length - 1]).toContain("┘");
    // 内容行宽度一致：│ 与 ─ 边框长度相同
    const widths = rows.map((row) => visibleWidth(row));
    expect(new Set(widths).size).toBe(1);
    expect(out).toContain("中文");
  });

  it("box/panel：off 无边框，panel legacy 复刻现状分隔线", () => {
    const off = createTheme({ isTTY: false }, { color: "off" });
    expect(off.box(["a", "b"])).toBe("a\nb");
    expect(off.panel(["a"], { legacySeparator: true })).toBe(`${"─".repeat(56)}\na`);
    expect(off.panel(["a"])).toBe("a");
    expect(off.rule(10)).toBe("─".repeat(10));
    expect(theme.rule(10)).toContain(`${ESC}[2m`);
  });

  it("segments/statusBar：off 纯文本、statusBar off 零字节", () => {
    const off = createTheme({ isTTY: false }, { color: "off" });
    expect(off.segments(["Kiwi Buyer", "seller-a"])).toBe("Kiwi Buyer · seller-a");
    expect(
      off.segments([{ text: "Kiwi Buyer", color: "primary", bold: true }, "seller-a"]),
    ).toBe("Kiwi Buyer · seller-a");
    expect(off.statusBar(["Kiwi Buyer"])).toBe("");
    expect(theme.segments([{ text: "Kiwi Buyer", color: "primary" }, "seller-a"])).toContain(
      `${ESC}[38;2;79;195;247m`,
    );
  });

  it("banner：off 与现状单行逐字节相同；24bit 含 art 与信息行", () => {
    const off = createTheme({ isTTY: false }, { color: "off" });
    const legacy = "Kiwi Merchant · merchant-agent:merchant-001 · 主对话（/help 查看命令，/quit 退出）";
    expect(
      off.banner({
        roleLabel: "Merchant",
        id: "merchant-agent:merchant-001",
        tagline: "主对话（/help 查看命令，/quit 退出）",
      }),
    ).toBe(legacy);
    const on = theme.banner({
      roleLabel: "Buyer",
      id: "buyer-a",
      tagline: "主对话（/help 查看命令，/quit 退出）",
    });
    expect(on).toContain(`${ESC}[38;2;`);
    expect(on).toContain("Kiwi Buyer");
    expect(on).toContain("buyer-a");
  });

  it("welcome：off 与现状单行逐字节相同；24bit 含 logo + 带标题面板", () => {
    const off = createTheme({ isTTY: false }, { color: "off" });
    const legacy = "Kiwi Merchant · merchant-agent:merchant-001 · 主对话（/help 查看命令，/quit 退出）";
    const input = {
      roleLabel: "Merchant",
      id: "merchant-agent:merchant-001",
      tagline: "主对话（/help 查看命令，/quit 退出）",
      versionLabel: "kiwi 0.6.0",
      commerceUrl: "http://127.0.0.1:8765",
      modelLabel: "deepseek/deepseek-v4-flash",
      modeLabel: "Supervised",
      a2aOn: true,
      catalog: "http://127.0.0.1:8600",
      commands: "/help /profile /handoff /discover /negotiate /a2a /quit",
    };
    expect(off.welcome(input)).toBe(legacy);
    const on = theme.welcome(input);
    expect(on).toContain(`${ESC}[38;2;`); // 渐变 logo
    expect(on).toContain("██"); // box art
    expect(on).toContain("┌─"); // 面板顶边
    expect(on).toContain("└"); // 面板底边
    expect(on).toContain("kiwi 0.6.0"); // 版本标题
    expect(on).toContain("会话:");
    expect(on).toContain("http://127.0.0.1:8765");
    expect(on).toContain("模型:");
    expect(on).toContain("deepseek/deepseek-v4-flash");
    expect(on).toContain("命令:");
    expect(on).toContain("/help /profile /handoff /discover /negotiate /a2a /quit");
    // 面板行等宽（边框对齐）
    const rows = on.split("\n").filter((line) => line.includes("│"));
    const widths = rows.map((line) => visibleWidth(line));
    expect(new Set(widths).size).toBe(1);
  });
});
