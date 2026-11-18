/**
 * Copyright 2026 harrylabsj
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
 */
/** 显式启用的本机候选记忆通道；目录必须仅由当前用户访问。 */
import { chmodSync, lstatSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type { CustomerRecallContext, CustomerMemoryToolProvider } from "../../a2a/reception/customer-memory-tools.js";

type Proposal = Parameters<CustomerMemoryToolProvider["propose"]>[1];
type Result = { memory_id: string; state: string };
const LIMIT = 16_384;
const TIMEOUT = 3000;

function validatePath(socketPath: string): void {
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error("invalid private socket path");
  const directory = lstatSync(dirname(socketPath));
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) {
    throw new Error("private socket directory must be owned by the current user and mode 0700");
  }
}

export function requestMemoryProposal(socketPath: string, context: CustomerRecallContext, input: Proposal): Promise<Result> {
  validatePath(socketPath);
  const request = JSON.stringify({ context, input });
  if (Buffer.byteLength(request) > LIMIT) return Promise.reject(new Error("request too large"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.setTimeout(TIMEOUT, () => socket.destroy(new Error("private socket timeout")));
    socket.on("connect", () => socket.end(`${request}\n`));
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > LIMIT) { socket.destroy(new Error("response too large")); return; }
      chunks.push(chunk);
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof result !== "object" || result === null || !("memory_id" in result) || typeof result.memory_id !== "string" || !("state" in result) || typeof result.state !== "string") throw new Error("proposal rejected");
        resolve({ memory_id: result.memory_id, state: result.state });
      } catch { reject(new Error("proposal rejected")); }
    });
  });
}

export async function startMemoryProposalServer(socketPath: string, propose: (context: CustomerRecallContext, input: Proposal) => Result): Promise<Server> {
  validatePath(socketPath);
  try { lstatSync(socketPath); throw new Error("private socket path already exists"); } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    socket.setTimeout(TIMEOUT, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > LIMIT) { rejected = true; socket.destroy(); return; }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      if (rejected) return;
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { context: CustomerRecallContext; input: Proposal };
        const result = propose(request.context, request.input);
        socket.end(JSON.stringify(result));
      } catch { socket.end(JSON.stringify({ error: "proposal_rejected" })); }
    });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); server.off("error", reject); resolve(); }
      catch (error) { server.close(() => reject(error)); }
    });
  });
  return server;
}
