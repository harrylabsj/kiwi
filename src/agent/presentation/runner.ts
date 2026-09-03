/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { sanitizePresentationValue } from "./sanitize.js";
import type { PresentationContext } from "./types.js";
import type { PresentationRegistry } from "./registry.js";

export async function runPresentation(
  registry: PresentationRegistry,
  toolName: string,
  rawInput: unknown,
  context: PresentationContext,
  emit: (component: string, payload: unknown) => Promise<void>,
): Promise<{ component: string }> {
  const component = registry.get(toolName);
  if (component === undefined) throw new Error(`unknown presentation tool ${toolName}`);
  const input = component.validate(rawInput);
  const payload = await component.enrich(input, context);
  await emit(component.component, sanitizePresentationValue(payload));
  return { component: component.component };
}
