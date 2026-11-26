import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { loadCredentials, loadSyncState, saveCredentials, saveSyncState } from "../weixin/credentials.js";
import { IlinkClient } from "../weixin/ilink-client.js";
import { encodeQrMatrix } from "../weixin/qr.js";
import { WeixinError, type BotCredentials } from "../weixin/types.js";
import { bindingFingerprint, OwnerConversationError, WeixinOwnerConversation, type FollowupStyle, type WeixinOwnerConversationOptions } from "./weixin-owner-conversation.js";
import type { WeixinOwnerModelSettings } from "./weixin-owner-model-settings.js";

function fingerprint(credentials: BotCredentials): string {
  return bindingFingerprint(credentials.ilink_user_id ?? "", credentials.ilink_bot_id, credentials.bot_token, credentials.saved_at);
}

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
  principalId?: string;
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
  private readonly conversationFile: string;
  private readonly conversationOptions: WeixinOwnerConversationOptions | undefined;
  private readonly modelSettings: WeixinOwnerModelSettings | undefined;
  private conversation?: WeixinOwnerConversation;
  private readonly now: () => number;
  private readonly client: (baseUrl?: string) => Client;
  private attempt?: Attempt;
  private lease?: DatabaseSync;
  private disconnecting = false;
  private state: ConnectionState = "disconnected";
  private configured = false;
  private worker?: { abort: AbortController; done: Promise<void> };
  private closed = false;

  constructor(options: { dataDir: string; merchantId: string; client?: (baseUrl?: string) => Client; now?: () => number;
    conversation?: WeixinOwnerConversationOptions; modelSettings?: WeixinOwnerModelSettings }) {
    const merchantKey = createHash("sha256").update(options.merchantId).digest("hex");
    this.directory = path.join(options.dataDir, "weixin-workbench", merchantKey);
    this.credentialsFile = path.join(this.directory, "credentials.json");
    this.cursorFile = path.join(this.directory, "sync.json");
    this.lockFile = path.join(this.directory, "owner.sqlite");
    this.conversationFile = path.join(this.directory, "owner-conversation.v1.sqlite");
    this.conversationOptions = options.conversation;
    this.modelSettings = options.modelSettings;
    this.client = options.client ?? ((baseUrl) => new IlinkClient({ baseUrl }));
    this.now = options.now ?? Date.now;
  }

  private ownerModelSettings(owner: WeixinBindingOwner): WeixinOwnerModelSettings {
    this.assertOwner(owner);
    if (!owner.principalId || !this.conversationOptions?.ownerRevision(owner.principalId)) {
      throw new OwnerConversationError("forbidden", "仅当前店主可以配置对话模型。");
    }
    if (this.modelSettings === undefined) throw new OwnerConversationError("not_found", "此实例未装配模型设置。");
    return this.modelSettings;
  }

  modelStatus(owner: WeixinBindingOwner) {
    return this.ownerModelSettings(owner).status();
  }

  async setModel(owner: WeixinBindingOwner, input: { provider: unknown; model: unknown; apiKey: unknown }) {
    const settings = this.ownerModelSettings(owner);
    this.lock();
    return settings.save(input, () => { this.ownerModelSettings(owner); }, () => { this.conversation?.modelChanged(); });
  }

  private openConversation(): WeixinOwnerConversation | undefined {
    if (this.conversationOptions === undefined) return undefined;
    if (!this.conversationOptions.enabled && !existsSync(this.conversationFile)) return undefined;
    this.lock();
    this.conversation ??= new WeixinOwnerConversation(this.conversationFile, this.conversationOptions, this.now);
    return this.conversation;
  }

  private ownerConversation(owner: WeixinBindingOwner) {
    this.assertOwner(owner);
    const principal = owner.principalId;
    const conversation = this.openConversation();
    if (!principal || conversation === undefined) throw new OwnerConversationError("unavailable", "店主对话未装配。");
    if (!this.conversationOptions?.ownerRevision(principal)) throw new OwnerConversationError("forbidden", "当前主体不能管理店主对话。");
    return { principal, conversation };
  }

  confirmConversation(owner: WeixinBindingOwner, modelConsent?: string): void {
    const { principal, conversation } = this.ownerConversation(owner);
    if (!this.configured || !existsSync(this.credentialsFile)) throw new OwnerConversationError("conflict", "请先连接微信。");
    const agent = this.conversationOptions?.agent;
    if (agent?.state === "unavailable") throw new OwnerConversationError("unavailable", "Kiwi 对话模型配置不可用。");
    if (modelConsent !== (agent?.state === "configured" ? agent.consent : undefined)) {
      throw new OwnerConversationError("conflict", "请重新查看并确认当前对话模式及模型服务。");
    }
    const current = fingerprint(loadCredentials(this.credentialsFile));
    const status = conversation.status(principal, current);
    if (!status.authorized || (modelConsent !== undefined && !status.model_authorized)) {
      conversation.bind(principal, current, modelConsent);
    }
  }

  confirmReplies(owner: WeixinBindingOwner): void {
    const { principal, conversation } = this.ownerConversation(owner);
    if (this.conversationOptions?.replyToOwner !== true) throw new OwnerConversationError("unavailable", "微信回信未启用。");
    if (!this.configured || !existsSync(this.credentialsFile)) throw new OwnerConversationError("conflict", "请先连接微信。");
    const current = fingerprint(loadCredentials(this.credentialsFile));
    if (!conversation.status(principal, current).authorized) conversation.bind(principal, current);
  }

  stopModel(owner: WeixinBindingOwner): void {
    const { principal, conversation } = this.ownerConversation(owner);
    if (!this.configured || !existsSync(this.credentialsFile)) throw new OwnerConversationError("conflict", "请先连接微信。");
    conversation.stopModel(principal, fingerprint(loadCredentials(this.credentialsFile)));
  }

  clearConversation(owner: WeixinBindingOwner): void {
    const { principal, conversation } = this.ownerConversation(owner);
    if (!this.configured || !existsSync(this.credentialsFile)) throw new OwnerConversationError("conflict", "请先连接微信。");
    conversation.clear(principal, fingerprint(loadCredentials(this.credentialsFile)));
  }

  revokeConversation(owner: WeixinBindingOwner): void {
    const { conversation } = this.ownerConversation(owner);
    conversation.revoke();
  }

  followupPreference(owner: WeixinBindingOwner, change?: { version: number; style: FollowupStyle | null }) {
    const { principal, conversation } = this.ownerConversation(owner);
    return change === undefined ? conversation.preference(principal) : conversation.setPreference(principal, change.version, change.style);
  }

  replyDrafts(owner: WeixinBindingOwner) {
    const { principal, conversation } = this.ownerConversation(owner);
    return conversation.listDrafts(principal);
  }

  replyDraft(owner: WeixinBindingOwner, id: string, edit?: { version: number; body: string }) {
    const { principal, conversation } = this.ownerConversation(owner);
    const row = edit === undefined ? conversation.draft(principal, id) : conversation.edit(principal, id, edit.version, edit.body);
    const { inquiry, version, body, current, publication } = row;
    return { id: row.id, inquiry, version, body, current, publication };
  }

  discardReplyDraft(owner: WeixinBindingOwner, id: string, version: number): void {
    const { principal, conversation } = this.ownerConversation(owner);
    conversation.discardDraft(principal, id, version);
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

  status(ownerPrincipal?: string) {
    this.restore();
    const base = { status: this.state, configured: this.configured };
    if (!ownerPrincipal || !this.conversationOptions?.enabled) return base;
    const delivery = this.conversationOptions.replyToOwner ? "paired_owner" as const : "workbench_only" as const;
    const configuredAgent = this.conversationOptions.agent;
    const agent = configuredAgent?.state === "configured" ? {
      state: configuredAgent.state, consent: configuredAgent.consent, provider: configuredAgent.provider,
      model: configuredAgent.model, endpoint: configuredAgent.endpoint,
    } : configuredAgent;
    const modelStatus = agent === undefined ? {} : { agent };
    try {
      const key = this.configured ? fingerprint(loadCredentials(this.credentialsFile)) : undefined;
      const conversation = key === undefined ? undefined : this.openConversation()?.status(ownerPrincipal, key);
      return { ...base, conversation: { ...(conversation ?? { enabled: true, authorized: false, delivery }), ...modelStatus } };
    } catch {
      return { ...base, conversation: { enabled: true, authorized: false, unavailable: true, delivery, ...modelStatus } };
    }
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
          const credentials = { ...result.credentials, saved_at: new Date(this.now()).toISOString() };
          const conversation = this.openConversation();
          if (conversation !== undefined) {
            // 手机确认只授权当前店主的本地回信；模型数据授权不能从扫码继承。
            const options = this.conversationOptions;
            if (options?.enabled && owner.principalId && (options.replyToOwner || options.agent === undefined)) {
              conversation.bind(owner.principalId, fingerprint(credentials));
            } else conversation.revoke();
          }
          saveCredentials(this.credentialsFile, credentials);
          this.configured = true;
          this.clearAttempt(attempt);
          this.listen(conversation === undefined ? result.credentials : credentials);
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
      this.openConversation()?.revoke();
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
    this.conversation?.close();
    this.conversation = undefined;
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
    const account = credentials.ilink_user_id;
    const key = fingerprint(credentials);
    const runOwnerTurn = async (conversation: WeixinOwnerConversation): Promise<void> => {
      if (this.conversationOptions?.replyToOwner !== true || !account) {
        await conversation.prepare(key, signal);
        return;
      }
      // 收件人只取当前扫码凭据，不能由模型、消息正文或商家事实指定。
      await conversation.process(key, signal, ({ text, context }) => {
        signal.throwIfAborted();
        if (!existsSync(this.credentialsFile) || fingerprint(loadCredentials(this.credentialsFile)) !== key) {
          throw new WeixinError("session_stale", "店主微信绑定已变化。");
        }
        return client.sendMessage({ to_user_id: account, text, context_token: context }, credentials, signal);
      });
    };
    while (!signal.aborted) {
      let pauseMs = 1_000;
      try {
        const conversation = account ? this.openConversation() : undefined;
        if (conversation !== undefined) await runOwnerTurn(conversation);
        if (signal.aborted) return;
        const consent = conversation?.consent(key);
        const updates = await client.getUpdates(cursor, credentials, signal);
        if (signal.aborted) return;
        this.state = "connected";
        if (account) conversation?.admit(key, account, updates.messages, consent);
        if (cursor !== updates.next_sync_buf) {
          saveSyncState(this.cursorFile, { get_updates_buf: updates.next_sync_buf, seen: [] });
          cursor = updates.next_sync_buf;
        }
        // /ping 保持为既有连通性检查；业务答复走持久、去重的店主对话。
        for (const message of updates.messages) {
          if (signal.aborted) return;
          if (message.from_user_id !== credentials.ilink_user_id || message.text.trim() !== "/ping" || !message.context_token) continue;
          await client.sendMessage({
            to_user_id: credentials.ilink_user_id,
            text: "Kiwi 商家后台微信通道已连接。商家操作请回到工作台完成。",
            context_token: message.context_token,
          }, credentials, signal);
        }
        if (conversation !== undefined) await runOwnerTurn(conversation);
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
