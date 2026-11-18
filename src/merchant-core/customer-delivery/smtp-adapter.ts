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
 * SMTP 发送适配器（M6-6；465 隐式 TLS 或 587 STARTTLS）。
 *
 * 零运行时依赖：node:net/node:tls。2xx 最终 DATA 响应视为平台接受；
 * 4xx/5xx 在 DATA 前可证明未发送；超时/连接中断为 UNKNOWN。
 */

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import type { DeliveryChannelAdapter } from "./channel.js";

export interface SmtpChannelAdapterOptions {
  readonly host: string;
  readonly port: number;
  readonly secure?: boolean;
  readonly user?: string;
  readonly password?: string;
  /** 缺省 true；测试/内网明文可显式关闭。 */
  readonly starttls?: boolean;
  readonly from: string;
  /** 仅测试注入；生产必须由调用方按授权绑定传入 recipient。 */
  readonly to?: string;
  readonly timeout_ms?: number;
}

type SmtpSocket = Socket | TLSSocket;

/** 每条命令的响应 deadline（P1-3）：服务器停在任意阶段都会销毁 socket
 * 并归为 UNKNOWN，不让 tick 永久挂起。 */
function readResponse(socket: SmtpSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      fn();
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      // 多行响应以 "250-" 继续，最后一行 "250 "。
      const last = lines.filter((line) => /^\d{3}[ ]/.test(line)).pop();
      if (last !== undefined) finish(() => resolve(buffer));
    };
    const onError = (err: Error): void => finish(() => reject(err));
    const onClose = (): void => finish(() => reject(new Error("smtp_closed")));
    const timer = setTimeout(() => {
      finish(() => reject(new Error("smtp_timeout")));
      socket.destroy();
    }, timeoutMs);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function command(socket: SmtpSocket, line: string, timeoutMs: number): Promise<string> {
  socket.write(`${line}\r\n`);
  return readResponse(socket, timeoutMs);
}

function statusCode(response: string): number {
  const match = /^(\d{3})/m.exec(response.trim());
  return match === null ? 0 : Number(match[1]);
}

function escapeData(text: string): string {
  return text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

async function connectSmtp(options: SmtpChannelAdapterOptions): Promise<SmtpSocket> {
  const timeout = options.timeout_ms ?? 20_000;
  if (options.secure === true || options.port === 465) {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: options.host, port: options.port, servername: options.host, timeout }, () => resolve(socket));
      socket.once("error", reject);
      socket.once("timeout", () => reject(new Error("smtp_timeout")));
    });
  }
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: options.host, port: options.port, timeout }, () => resolve(socket));
    socket.once("error", reject);
    socket.once("timeout", () => reject(new Error("smtp_timeout")));
  });
}

async function upgradeTls(socket: SmtpSocket, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host, timeout: timeoutMs }, () => resolve(secure));
    secure.once("error", reject);
    secure.once("timeout", () => reject(new Error("smtp_timeout")));
  });
}

export function createSmtpChannelAdapter(options: SmtpChannelAdapterOptions): DeliveryChannelAdapter {
  return {
    async send({ delivery, recipient, timeout_ms }) {
      if (delivery.channel !== "email") return { outcome: "not_sent", reason: "channel_mismatch" };
      const to = recipient ?? options.to;
      if (to === undefined || to.trim() === "") {
        return { outcome: "not_sent", reason: "recipient_unresolved" };
      }
      const timeoutMs = Math.max(1, Math.min(timeout_ms, options.timeout_ms ?? timeout_ms));
      const subject = typeof delivery.payload.title === "string" ? delivery.payload.title : "通知";
      const body = typeof delivery.payload.body === "string" ? delivery.payload.body : "";
      if (body.trim() === "") return { outcome: "not_sent", reason: "payload_empty" };
      let socket: SmtpSocket | undefined;
      try {
        socket = await connectSmtp({ ...options, timeout_ms: timeoutMs });
        const greeting = await readResponse(socket, timeoutMs);
        if (statusCode(greeting) !== 220) return { outcome: "not_sent", reason: "smtp_greeting" };
        let ehlo = await command(socket, "EHLO kiwi.local", timeoutMs);
        if (statusCode(ehlo) !== 250) return { outcome: "not_sent", reason: "smtp_ehlo" };
        if (options.starttls !== false && !(options.secure === true || options.port === 465)) {
          const starttls = await command(socket, "STARTTLS", timeoutMs);
          if (statusCode(starttls) !== 220) return { outcome: "not_sent", reason: "smtp_starttls" };
          socket = await upgradeTls(socket, options.host, timeoutMs);
          ehlo = await command(socket, "EHLO kiwi.local", timeoutMs);
          if (statusCode(ehlo) !== 250) return { outcome: "not_sent", reason: "smtp_ehlo_tls" };
        }
        if (options.user !== undefined && options.password !== undefined) {
          const auth = await command(socket, "AUTH LOGIN", timeoutMs);
          if (statusCode(auth) !== 334) return { outcome: "not_sent", reason: "smtp_auth" };
          const user = await command(socket, Buffer.from(options.user).toString("base64"), timeoutMs);
          if (statusCode(user) !== 334) return { outcome: "not_sent", reason: "smtp_auth_user" };
          const pass = await command(socket, Buffer.from(options.password).toString("base64"), timeoutMs);
          if (statusCode(pass) !== 235) return { outcome: "not_sent", reason: "smtp_auth_password" };
        }
        const mailFrom = await command(socket, `MAIL FROM:<${options.from}>`, timeoutMs);
        if (statusCode(mailFrom) !== 250) return { outcome: "not_sent", reason: "smtp_mail_from" };
        const rcpt = await command(socket, `RCPT TO:<${to}>`, timeoutMs);
        if (statusCode(rcpt) !== 250 && statusCode(rcpt) !== 251) {
          return { outcome: "not_sent", reason: "smtp_rcpt" };
        }
        const data = await command(socket, "DATA", timeoutMs);
        if (statusCode(data) !== 354) return { outcome: "not_sent", reason: "smtp_data" };
        // P2-12：同一 delivery_id 必须映射同一 Message-ID，重发才能被下游关联/去重。
        const messageId = `<${delivery.delivery_id}@kiwi.local>`;
        const payload = [
          `From: ${options.from}`,
          `To: ${to}`,
          `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
          `Message-ID: ${messageId}`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="utf-8"',
          "",
          escapeData(body),
          ".",
        ].join("\r\n");
        socket.write(`${payload}\r\n`);
        const accepted = await readResponse(socket, timeoutMs);
        if (statusCode(accepted) !== 250) return { outcome: "unknown", receipt: { status: statusCode(accepted) } };
        await command(socket, "QUIT", timeoutMs).catch(() => undefined);
        return { outcome: "accepted", provider_request_id: messageId, receipt: { accepted: true } };
      } catch {
        return { outcome: "unknown" };
      } finally {
        socket?.destroy();
      }
    },
  };
}
