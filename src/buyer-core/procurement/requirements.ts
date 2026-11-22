import { contentDigest } from "../../negotiation/jcs.js";

export const requirementKinds = ["invoice", "payment", "delivery", "warranty", "specification", "condition", "packaging", "after_sales"] as const;
export type RequirementKind = (typeof requirementKinds)[number];
export type RequirementValue = string | number | boolean;
export interface Requirement {
  id: string;
  kind: RequirementKind;
  hardness: "hard" | "soft";
  value: RequirementValue;
  comparison?: "eq" | "min" | "max";
  source: string;
  disclose: boolean;
}
export interface Basis {
  buyer_item_key: string;
  description: string;
  selection_mode: "exact_item" | "spec_based";
  model?: string;
  quantity?: number;
  unit?: string;
  destination?: string;
  delivery_before?: string;
  requirements: Requirement[];
  budget?: { amount_minor: number; hardness: "hard" | "soft"; scope: "total" | "unit" };
  channels?: ("kiwi" | "ecommerce")[];
  minimum_suppliers?: number;
  company?: string;
}
export const REQUIREMENTS_KEY = "kiwi_procurement_requirements_v1";
export const RESPONSE_KEY = "kiwi_procurement_response_v1";
export const COSTS_KEY = "kiwi_quote_costs_v1";

export function basisDigest(basis: Basis): string {
  const { budget: _budget, company: _company, channels: _channels, minimum_suppliers: _minimum, ...commercial } = basis;
  return contentDigest({ ...commercial, requirements: commercial.requirements.map(({ source: _source, ...requirement }) => requirement).sort((a, b) => a.id.localeCompare(b.id)) });
}

export function projectRequirements(basis: Basis) {
  const requirements = basis.requirements.filter(isProjectable)
    .map(({ id, kind, hardness, value, comparison }) => ({ id, kind, strength: hardness, requested: value, ...(comparison ? { comparison } : {}) }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const body = { schema_version: 1, requirements };
  return { ...body, projection_digest: contentDigest(body) };
}

export function isProjectable(requirement: Requirement) {
  return requirement.disclose && ["invoice", "payment", "delivery", "warranty", "specification"].includes(requirement.kind);
}

export function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value)) && Number.isFinite(Date.parse(value.slice(0, 10)))
    && new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10);
}

export function conditionMatches(requirement: Requirement, actual: unknown): boolean {
  if (requirement.comparison === "eq") return actual === requirement.value;
  if ((requirement.comparison === "min" || requirement.comparison === "max") && typeof requirement.value === "number") {
    return typeof actual === "number" && Number.isSafeInteger(actual) &&
      (requirement.comparison === "min" ? actual >= requirement.value : actual <= requirement.value);
  }
  if (requirement.kind === "warranty" && typeof requirement.value === "number") {
    return typeof actual === "number" && Number.isSafeInteger(actual) && actual >= requirement.value;
  }
  if (requirement.kind === "delivery" && validTimestamp(requirement.value)) {
    return validTimestamp(actual) && Date.parse(actual) <= Date.parse(requirement.value);
  }
  return actual === requirement.value;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
