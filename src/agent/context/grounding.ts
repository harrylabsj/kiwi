/** Deterministic first-read grounding primitives for model turns. */

export interface GroundingContext {
  latestUserText: string;
  sessionState: Readonly<Record<string, unknown>>;
}

export interface GroundingRead {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface GroundingRule {
  name: string;
  priority: number;
  match(context: GroundingContext): GroundingRead | undefined;
}

export function firstGroundingRead(
  rules: readonly GroundingRule[],
  context: GroundingContext,
): GroundingRead | undefined {
  return groundingReads(rules, context, 1)[0];
}

/** Return at most maxReads unique read-only tools in deterministic priority order. */
export function groundingReads(
  rules: readonly GroundingRule[],
  context: GroundingContext,
  maxReads = 2,
): GroundingRead[] {
  const seen = new Set<string>();
  const reads: GroundingRead[] = [];
  for (const read of [...rules]
    .sort((a, b) => a.priority - b.priority)
    .map((rule) => rule.match(context))
    .filter((read): read is GroundingRead => read !== undefined)) {
    if (seen.has(read.tool)) continue;
    seen.add(read.tool);
    reads.push(read);
    if (reads.length >= Math.max(1, maxReads)) break;
  }
  return reads;
}
