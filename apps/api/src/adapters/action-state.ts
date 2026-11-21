import type {
  ActionStateDocument,
  ActionStateStore,
} from "@beacon/core/ports/action-state";
import { and, eq } from "drizzle-orm";

import type { Database } from "./db.js";
import { simulatedState } from "./schema.js";

/**
 * Implementación Drizzle del puerto `ActionStateStore` (ADR-005 decisión 3).
 *
 * La escritura es un compare-and-swap por versión: primero se intenta actualizar la
 * fila que se leyó y, si no estaba, se inserta. Si el estado se movió entre la
 * lectura y la escritura, `write` devuelve `null` y el ejecutor responde `conflict`
 * con el estado observado, en vez de pisar el cambio de otro.
 */
export class DrizzleActionStateStore implements ActionStateStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async read(target: string): Promise<ActionStateDocument | null> {
    const rows = await this.#db
      .select()
      .from(simulatedState)
      .where(eq(simulatedState.target, target))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }
    return { target: row.target, state: row.state, version: row.version };
  }

  async write(
    target: string,
    expectedVersion: number,
    next: unknown,
  ): Promise<ActionStateDocument | null> {
    const updated = await this.#db
      .update(simulatedState)
      .set({
        state: next,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(eq(simulatedState.target, target), eq(simulatedState.version, expectedVersion)),
      )
      .returning();

    const updatedRow = updated[0];
    if (updatedRow) {
      return {
        target: updatedRow.target,
        state: updatedRow.state,
        version: updatedRow.version,
      };
    }

    // No había fila: se crea con versión 1. Si ya existía con otra versión, el
    // `on conflict do nothing` no inserta y el estado se movió: conflicto.
    const inserted = await this.#db
      .insert(simulatedState)
      .values({ target, state: next, version: 1 })
      .onConflictDoNothing({ target: simulatedState.target })
      .returning();

    const insertedRow = inserted[0];
    if (!insertedRow) {
      return null;
    }
    return {
      target: insertedRow.target,
      state: insertedRow.state,
      version: insertedRow.version,
    };
  }
}
