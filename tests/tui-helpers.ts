/**
 * TUI 测试公共 helper：内存流构造（非 .test.ts，vitest 只收集 *.test.ts）。
 *
 * - 默认非 TTY：输出与升级前字节级一致（既有 ~30 个断言零改动 = 非 TTY
 *   回归套件）；
 * - `tty: true`：给 output 挂 isTTY 属性，触发 TUI 的 ANSI 样式路径
 *   （input 不设——createTheme 只读 output，readline 的 terminal 模式按
 *   input.isTTY 保持 false，避免假流 raw-mode 报错）。
 */
import { Readable, Writable } from "node:stream";

export interface TuiStreams {
  input: Readable;
  output: Writable;
  text: () => string;
}

export function streams(lines: string[], opts: { tty?: boolean } = {}): TuiStreams {
  const input = Readable.from([`${lines.join("\n")}\n`]);
  let buffer = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  });
  if (opts.tty === true) {
    Object.defineProperty(output, "isTTY", { value: true, configurable: true });
  }
  return { input, output, text: () => buffer };
}
