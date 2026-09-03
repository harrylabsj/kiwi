/**
 * Copyright 2026 harrylabsj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { AnyPresentationComponent, PresentationComponent } from "./types.js";

/** Immutable-by-convention registry for the built-in presentation surface. */
export class PresentationRegistry {
  private readonly components = new Map<string, AnyPresentationComponent>();

  register<I, O>(component: PresentationComponent<I, O>): this {
    if (this.components.has(component.toolName)) {
      throw new Error(`duplicate presentation tool ${component.toolName}`);
    }
    this.components.set(component.toolName, component as AnyPresentationComponent);
    return this;
  }

  get(toolName: string): AnyPresentationComponent | undefined {
    return this.components.get(toolName);
  }

  list(): AnyPresentationComponent[] {
    return [...this.components.values()];
  }
}
