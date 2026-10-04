/**
 * A208: official Durable registry adapter. Host capabilities are trusted local
 * assembly, never model arguments. This module does not implement commercial
 * approval, budget, grant, recovery or operation state; host must enforce them.
 */
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Registry,
  type TaskId,
  type ConversationId,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { TSchema } from "@earendil-works/pi-ai";

export interface OwnerSdkToolCall {
  readonly taskId: TaskId;
  readonly callId: string;
  readonly conversationId: ConversationId;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Both capabilities must be assembled by the authenticated local host:
 * invokeTool enforces approval/fresh facts/grant/budget/operation gates;
 * historyStrong re-reads grant and reads the bound real SDK conversation.
 * Presence checks cannot establish that a caller implemented those contracts.
 */
export interface OwnerSdkHost {
  invokeTool(call: OwnerSdkToolCall): Promise<ToolExecutionResult>;
  historyStrong(limit: number): Promise<readonly string[]>;
}

export interface OwnerSdkToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
}

export interface OwnerSdkRegistry {
  readonly registry: Registry;
  history(limit?: number): Promise<readonly string[]>;
}

/**
 * New registry containing only these tools and SDK built-ins. Do not merge with
 * a registry containing ungated effects. Pure converse installs no tools.
 * Always reinstall on Harness reopen; SDK stores names, not closures.
 */
export function createOwnerSdkRegistry(input: {
  readonly mode: "converse" | "operation";
  readonly host: OwnerSdkHost;
  readonly tools: readonly OwnerSdkToolSpec[];
}): OwnerSdkRegistry {
  if (
    input === null ||
    typeof input !== "object" ||
    (input.mode !== "converse" && input.mode !== "operation") ||
    input.host === null ||
    typeof input.host !== "object" ||
    typeof input.host.invokeTool !== "function" ||
    typeof input.host.historyStrong !== "function" ||
    !Array.isArray(input.tools)
  ) {
    throw new TypeError("owner SDK registry: trusted host capabilities required");
  }
  // Capture methods now: swapping config methods cannot turn a live registry
  // into an ungated executor. Host remains responsible for its own state.
  const invokeTool = input.host.invokeTool.bind(input.host);
  const historyStrong = input.host.historyStrong.bind(input.host);
  const registry = createRegistry();
  if (input.mode === "operation") {
    const tools = input.tools.map((spec) => {
      if (
        spec === null ||
        typeof spec !== "object" ||
        typeof spec.name !== "string" ||
        spec.name.length === 0 ||
        typeof spec.description !== "string" ||
        spec.parameters === null ||
        typeof spec.parameters !== "object"
      ) {
        throw new TypeError("owner SDK registry: invalid tool specification");
      }
      const name = spec.name;
      return defineTool({
        name,
        description: spec.description,
        parameters: spec.parameters,
        replay: "unsafe",
        executionMode: "sequential",
        async execute(args, api) {
          // These identifiers are supplied by the actual SDK task, not model
          // arguments. Host must bind them to its exact local owner session.
          if (
            !Number.isSafeInteger(api.taskId) ||
            api.taskId <= 0 ||
            typeof api.callId !== "string" ||
            api.callId.length === 0 ||
            !Number.isSafeInteger(api.conversationId) ||
            api.conversationId <= 0 ||
            args === null ||
            typeof args !== "object" ||
            Array.isArray(args)
          ) {
            throw new TypeError("owner SDK registry: invalid SDK call context");
          }
          // No catch/fallback effect runner: host refusal remains refusal.
          return invokeTool(
            Object.freeze({
              taskId: api.taskId,
              callId: api.callId,
              conversationId: api.conversationId,
              tool: name,
              args: args as Readonly<Record<string, unknown>>,
            }),
          );
        },
      });
    });
    registry.install(defineExtension({ name: "kiwi-owner-host", tools }));
  }
  return Object.freeze({
    registry,
    async history(limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new RangeError("owner SDK registry: history limit must be 1..1000");
      }
      return historyStrong(limit);
    },
  });
}
