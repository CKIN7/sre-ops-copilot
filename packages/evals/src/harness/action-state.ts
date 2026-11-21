import type {
  ActionStateDocument,
  ActionStateStore,
} from "@beacon/core/ports/action-state";

/**
 * Estado del mundo en memoria para `SimulatedExecutor`.
 *
 * Replica el compare-and-swap por version: dos writes con la misma version esperada
 * no pueden ganar los dos. El estado inicial lo define el caso (por ejemplo, la
 * version actual de checkout).
 */
export class MemoryActionState implements ActionStateStore {
  readonly #documents = new Map<string, ActionStateDocument>();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [target, state] of Object.entries(initial)) {
      this.#documents.set(target, { target, state, version: 1 });
    }
  }

  async read(target: string): Promise<ActionStateDocument | null> {
    const document = this.#documents.get(target);
    return document ? structuredClone(document) : null;
  }

  async write(
    target: string,
    expectedVersion: number,
    next: unknown,
  ): Promise<ActionStateDocument | null> {
    const current = this.#documents.get(target);

    if (!current) {
      const created: ActionStateDocument = { target, state: next, version: 1 };
      this.#documents.set(target, created);
      return structuredClone(created);
    }

    if (current.version !== expectedVersion) {
      return null;
    }

    const updated: ActionStateDocument = {
      target,
      state: next,
      version: current.version + 1,
    };
    this.#documents.set(target, updated);
    return structuredClone(updated);
  }
}
