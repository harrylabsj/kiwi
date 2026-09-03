/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { Writable } from "node:stream";
import type { AgentEventSink, AgentHostEvent } from "./events.js";
import { createTheme } from "../../tui/styles.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "—";
}

function renderUi(component: string, payload: unknown): string[] {
  const value = asRecord(payload);
  if (component === "merchant_digest") {
    const snapshot = asRecord(value.snapshot);
    const alerts = asRecord(snapshot.alerts);
    const metrics = Array.isArray(snapshot.metrics) ? snapshot.metrics : [];
    return [
      "[经营摘要] " + display(value.title),
      ...metrics.slice(0, 8).map((metric) => {
        const item = asRecord(metric);
        return `  ${display(item.name)}: ${display(item.value)} ${display(item.unit)}`;
      }),
      `  活跃磋商 ${display(alerts.active_negotiations)} · 人工审核 ${display(alerts.human_reviews)} · 待审批 ${display(alerts.pending_actions)}`,
    ];
  }
  if (component === "metrics") {
    const points = Array.isArray(value.points) ? value.points : [];
    return [
      `[指标] ${display(value.metric)}（${display(value.period)} / ${display(value.granularity)}）`,
      ...points.slice(0, 20).map((point) => {
        const item = asRecord(point);
        return `  ${display(item.date)}  ${display(item.value)}`;
      }),
      ...(typeof value.note === "string" && value.note !== "" ? [`  说明：${value.note}`] : []),
    ];
  }
  if (component === "catalog") {
    const products = Array.isArray(value.products) ? value.products : [];
    const health = asRecord(value.health);
    return [
      `[目录] 共 ${display(health.total)} 件 · active ${display(health.active)} · paused ${display(health.paused)} · 缺货 ${display(health.out_of_stock)}`,
      ...products.slice(0, 20).map((product) => {
        const item = asRecord(product);
        return `  ${display(item.sku)}  ${display(item.title)}  价格 ${display(item.price)}  库存 ${display(item.stock)}`;
      }),
    ];
  }
  if (component === "negotiations") {
    const rows = Array.isArray(payload) ? payload : [];
    return [
      `[磋商] ${rows.length} 条`,
      ...rows.slice(0, 20).map((row) => {
        const item = asRecord(row);
        return `  ${display(item.negotiation_id)}  ${display(item.phase)}  ${display(item.updated_at)}`;
      }),
    ];
  }
  if (component === "human_review") {
    const rows = Array.isArray(value.reviews) ? value.reviews : [];
    return [
      `[人工审核] ${rows.length} 条`,
      ...rows.slice(0, 20).map((row) => {
        const item = asRecord(row);
        return `  ${display(item.review_id)}  ${display(item.severity)}  ${display(item.reason)}`;
      }),
    ];
  }
  if (component === "change_preview") {
    const changes = Array.isArray(value.changes) ? value.changes : [];
    return [
      `[变更预览] ${display(value.headline)}（${display(value.status)}）`,
      ...changes.slice(0, 20).map((change) => {
        const item = asRecord(change);
        return `  ${display(item.field)}: ${display(item.before)} → ${display(item.after)}`;
      }),
      ...(typeof value.note === "string" && value.note !== "" ? [`  说明：${value.note}`] : []),
    ];
  }
  if (component === "suggestions") {
    const suggestions = Array.isArray(value.suggestions) ? value.suggestions : [];
    return ["[建议]", ...suggestions.slice(0, 4).map((suggestion) => `  · ${display(suggestion)}`)];
  }
  return [`[ui] ${component}`];
}

/** Optional renderer for hosts that want readable TUI projections from events. */
export class TuiEventSink implements AgentEventSink {
  private readonly output: Writable;
  private readonly theme: ReturnType<typeof createTheme>;

  constructor(output: Writable) {
    this.output = output;
    this.theme = createTheme(output as { isTTY?: boolean });
  }

  emit(event: AgentHostEvent): void {
    const data = asRecord(event.data);
    let lines: string[] = [];
    if (event.type === "message" && typeof data.text === "string" && data.role !== "user") {
      lines = [data.text];
    } else if (event.type === "grounding_started") {
      lines = [`[数据] 正在读取 ${display(data.tool)}…`];
    } else if (event.type === "grounding_completed") {
      lines = [`[数据] ${display(data.tool)}：${display(data.status)}`];
    } else if (event.type === "ui") {
      lines = renderUi(display(data.component), data.payload);
    } else if (event.type === "error") {
      lines = [`[错误] ${display(data.message)}`];
    }
    for (const line of lines) this.output.write(`${this.theme.decorate(line)}\n`);
  }
}

export { renderUi as renderTuiEvent };
