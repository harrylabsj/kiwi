import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { loadCredentials, loadSyncState, saveCredentials, saveSyncState } from "../weixin/credentials.js";
import { IlinkClient } from "../weixin/ilink-client.js";
import { encodeQrMatrix } from "../weixin/qr.js";
import { WeixinError, type BotCredentials } from "../weixin/types.js";

const QR_TTL_MS = 8 * 60_000;
const POLL_INTERVAL_MS = 1_500;
type Client = Pick<IlinkClient, "getBotQrcode" | "getQrcodeStatus" | "setBaseUrl" | "getUpdates" | "sendMessage">;
type ConnectionState = "disconnected" | "checking" | "connected" | "retrying" | "reconnect_required" | "unavailable";
type ScanState = "waiting" | "scanned" | "verification_required";

export class MerchantWeixinError extends Error {
  constructor(readonly code: "conflict" | "not_found" | "unavailable" | "forbidden" | "invalid_input", message: string) {
    super(message);
  }
}

export interface WeixinBindingOwner {
  sessionId: string;
  generation: number;
  /** Revalidate after external I/O, before disclosing a QR or writing credentials. */
  current: () => boolean;
}

interface Attempt {
  id: string;
  owner: string;
  generation: number;
  current: () => boolean;
  client: Client;
  abort: AbortController;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  state: ScanState;
  qr?: { token: string; rows: string[] };
  inFlight: boolean;
  nextPollAt: number;
}

/** A dedicated merchant-owned channel, independent of chat and CLI watch credentials. */
export class MerchantWeixinChannel {
  private readonly directory: string;
  private readonly credentialsFile: string;
  private readonly cursorFile: string;
  private readonly lockFile: string;
  private readonly now: () => number;
  private readonly client: (baseUrl?: string) => Client;
  private attempt?: Attempt;
  private lease?: DatabaseSync;
  private disconnecting = false;
  private state: ConnectionState = "disconnected";
  private configured = false;
  private worker?: { abort: AbortController; done: Promise<void> };
  private closed = false;

  constructor(options: { dataDir: string; merchantId: string; client?: (baseUrl?: string) => Client; now?: () => number }) {
    const merchantKey = createHash("sha256").update(options.merchantId).digest("hex");
    this.directory = path.join(options.dataDir, "weixin-workbench", merchantKey);
    this.credentialsFile = path.join(this.directory, "credentials.json");
    this.cursorFile = path.join(this.directory, "sync.json");
    this.lockFile = path.join(this.directory, "owner.sqlite");
    this.client = options.client ?? ((baseUrl) => new IlinkClient({ baseUrl }));
    this.now = options.now ?? Date.now;
  }

  restore(): void {
    if (this.closed || this.configured || !existsSync(this.credentialsFile)) return;
    try {
      this.lock();
      this.configured = true;
      const credentials = loadCredentials(this.credentialsFile);
      if (!credentials.ilink_user_id) throw new Error("missing paired account");
      this.listen(credentials);
    } catch {
      this.state = this.lease ? "reconnect_required" : "unavailable";
    }
  }

  status() {
    this.restore();
    return { status: this.state, configured: this.configured };
  }

  async begin(owner: WeixinBindingOwner) {
    this.assertOwner(owner);
    if (this.disconnecting) throw new MerchantWeixinError("conflict", "微信通道正在断开，请稍后重试。");
    this.lock();
    if (this.configured || existsSync(this.credentialsFile)) {
      throw new MerchantWeixinError("conflict", "已有微信绑定，请先断开再重新扫码。");
    }
    this.expireAttempt();
    if (this.attempt !== undefined) {
      if (!this.matches(this.attempt, owner) || this.attempt.qr === undefined) {
        throw new MerchantWeixinError("conflict", "另有扫码正在进行，请等待或先取消。");
      }
      return this.qrView(this.attempt, this.attempt.qr.rows);
    }
    const attempt: Attempt = {
      id: randomUUID(), owner: owner.sessionId, generation: owner.generation,
      current: owner.current, client: this.client(), abort: new AbortController(), expiresAt: this.now() + QR_TTL_MS,
      timer: setTimeout(() => this.clearAttempt(attempt), QR_TTL_MS).unref(),
      state: "waiting", inFlight: false, nextPollAt: 0,
    };
    this.attempt = attempt;
    try {
      const qr = await attempt.client.getBotQrcode(attempt.abort.signal);
      this.findAttempt(owner, attempt.id);
      const matrix = encodeQrMatrix(qr.qrcode_img_content);
      const size = Math.sqrt(matrix.length);
      const rows = Array.from({ length: size }, (_, y) => matrix.slice(y * size, (y + 1) * size).join(""));
      attempt.qr = { token: qr.qrcode, rows };
      return this.qrView(attempt, rows);
    } catch (error) {
      this.clearAttempt(attempt);
      if (error instanceof MerchantWeixinError) throw error;
      throw new MerchantWeixinError("unavailable", "暂时无法生成微信二维码，请稍后重试。");
    }
  }

  async poll(owner: WeixinBindingOwner, id: string, verifyCode?: string) {
    const attempt = this.findAttempt(owner, id);
    if (attempt.qr === undefined || attempt.inFlight || this.now() < attempt.nextPollAt) {
      if (verifyCode !== undefined) throw new MerchantWeixinError("conflict", "上一次确认尚未结束，请稍后再提交配对码。");
      return { status: attempt.state };
    }
    if (verifyCode !== undefined && (attempt.state !== "verification_required" || !/^\d{1,12}$/.test(verifyCode))) {
      throw new MerchantWeixinError("invalid_input", "请填写手机微信显示的数字配对码。");
    }
    if (attempt.state === "verification_required" && verifyCode === undefined) return { status: attempt.state };
    attempt.inFlight = true;
    attempt.nextPollAt = this.now() + POLL_INTERVAL_MS;
    try {
      const result = await attempt.client.getQrcodeStatus(attempt.qr.token, { ...(verifyCode !== undefined ? { verifyCode } : {}), signal: attempt.abort.signal });
      this.findAttempt(owner, attempt.id);
      switch (result.state) {
        case "confirmed": {
          if (!result.credentials.ilink_user_id) throw new WeixinError("validation", "missing paired account");
          rmSync(this.cursorFile, { force: true });
          saveCredentials(this.credentialsFile, { ...result.credentials, saved_at: new Date(this.now()).toISOString() });
          this.configured = true;
          this.clearAttempt(attempt);
          this.listen(result.credentials);
          return { status: "confirmed" as const };
        }
        case "scaned_but_redirect":
          attempt.client.setBaseUrl(result.baseUrl);
          attempt.state = "scanned";
          break;
        case "scaned":
          attempt.state = "scanned";
          break;
        case "need_verifycode":
          attempt.state = "verification_required";
          break;
        case "expired":
        case "verify_code_blocked":
        case "binded_redirect":
          this.clearAttempt(attempt);
          return { status: result.state };
      }
      return { status: attempt.state };
    } catch (error) {
      if (error instanceof MerchantWeixinError) throw error;
      // iLink long polling can time out with nobody scanning. Keep this QR alive until its deadline.
      if (error instanceof WeixinError && error.code === "timeout") {
        this.findAttempt(owner, attempt.id);
        return { status: attempt.state };
      }
      this.clearAttempt(attempt);
      throw new MerchantWeixinError("unavailable", "暂时无法确认微信扫码状态，请重新生成二维码。");
    } finally {
      attempt.inFlight = false;
    }
  }

  cancel(owner: WeixinBindingOwner, id: string): void {
    this.clearAttempt(this.findAttempt(owner, id));
  }

  async disconnect(owner: WeixinBindingOwner): Promise<void> {
    this.assertOwner(owner);
    if (this.disconnecting) throw new MerchantWeixinError("conflict", "微信通道正在断开，请稍后重试。");
    this.lock();
    this.expireAttempt();
    if (this.attempt !== undefined) throw new MerchantWeixinError("conflict", "请先取消正在进行的扫码。");
    // No await between the session check, deleting credentials and aborting the worker.
    // An already-resolved poll is also fenced by the abort signal before it can write.
    try {
      rmSync(this.cursorFile, { force: true });
      rmSync(this.credentialsFile, { force: true });
    } catch {
      throw new MerchantWeixinError("unavailable", "暂时无法断开微信通道，请稍后重试。");
    }
    this.disconnecting = true;
    this.configured = false;
    this.state = "disconnected";
    try {
      await this.stopWorker();
    } finally {
      this.disconnecting = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.attempt !== undefined) this.clearAttempt(this.attempt);
    await this.stopWorker();
    this.lease?.close();
    this.lease = undefined;
  }

  private lock(): void {
    if (this.closed) throw new MerchantWeixinError("unavailable", "微信通道正在关闭。");
    if (this.lease) return;
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      // A reserved SQLite writer lock excludes another Workbench process and is
      // automatically released by the OS on process exit. This DB stores no data.
      db = new DatabaseSync(this.lockFile);
      db.exec("BEGIN IMMEDIATE");
      this.lease = db;
      if (this.state === "unavailable" && !this.configured) this.state = "disconnected";
    } catch {
      db?.close();
      throw new MerchantWeixinError("unavailable", "微信通道暂不可用，可能由另一个商家后台进程管理。");
    }
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    if (worker === undefined) return;
    worker.abort.abort();
    await worker.done;
    if (this.worker === worker) this.worker = undefined;
  }

  private listen(credentials: BotCredentials): void {
    const abort = new AbortController();
    this.state = "checking";
    const done = this.receive(credentials, abort.signal).catch(() => {
      if (!abort.signal.aborted) this.state = "unavailable";
    });
    this.worker = { abort, done };
  }

  private async receive(credentials: BotCredentials, signal: AbortSignal): Promise<void> {
    const client = this.client(credentials.base_url);
    let cursor = loadSyncState(this.cursorFile).get_updates_buf;
    while (!signal.aborted) {
      let pauseMs = 1_000;
      try {
        const updates = await client.getUpdates(cursor, credentials, signal);
        if (signal.aborted) return;
        this.state = "connected";
        if (cursor !== updates.next_sync_buf) {
          saveSyncState(this.cursorFile, { get_updates_buf: updates.next_sync_buf, seen: [] });
          cursor = updates.next_sync_buf;
        }
        // This is a connectivity check, not a general chat bot. No chat content is stored.
        for (const message of updates.messages) {
          if (signal.aborted) return;
          if (message.from_user_id !== credentials.ilink_user_id || message.text.trim() !== "/ping" || !message.context_token) continue;
          await client.sendMessage({
            to_user_id: credentials.ilink_user_id,
            text: "Kiwi 商家后台微信通道已连接。商家操作请回到工作台完成。",
            context_token: message.context_token,
          }, credentials, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WeixinError && (error.code === "auth" || error.code === "session_stale")) {
          this.state = "reconnect_required";
          return;
        }
        this.state = "retrying";
        pauseMs = 5_000;
      }
      await delay(pauseMs, undefined, { signal, ref: false }).catch(() => undefined);
    }
  }

  private clearAttempt(attempt: Attempt): void {
    if (this.attempt !== attempt) return;
    this.attempt = undefined;
    clearTimeout(attempt.timer);
    attempt.abort.abort();
  }

  private expireAttempt(): void {
    if (this.attempt && (this.now() >= this.attempt.expiresAt || !this.attempt.current())) {
      this.clearAttempt(this.attempt);
    }
  }

  private matches(attempt: Attempt, owner: WeixinBindingOwner): boolean {
    return attempt.owner === owner.sessionId && attempt.generation === owner.generation;
  }

  private findAttempt(owner: WeixinBindingOwner, id: string): Attempt {
    this.assertOwner(owner);
    this.expireAttempt();
    const attempt = this.attempt;
    if (attempt === undefined || attempt.id !== id || !this.matches(attempt, owner)) {
      throw new MerchantWeixinError("not_found", "扫码已失效，请重新生成二维码。");
    }
    return attempt;
  }

  private assertOwner(owner: WeixinBindingOwner): void {
    if (this.closed) throw new MerchantWeixinError("unavailable", "微信通道正在关闭。");
    if (!owner.current()) throw new MerchantWeixinError("forbidden", "管理会话已失效，请重新登录。");
  }

  private qrView(attempt: Attempt, rows: string[]) {
    return { attempt_id: attempt.id, qr_rows: rows, status: attempt.state,
      expires_at: new Date(attempt.expiresAt).toISOString() };
  }
}
