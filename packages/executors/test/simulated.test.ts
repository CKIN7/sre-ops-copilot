import type {
  ActionStateDocument,
  ActionStateStore,
} from "@beacon/core/ports/action-state";
import { describe, expect, it } from "vitest";

import { parseFaults } from "../src/faults.js";
import { SimulatedExecutor } from "../src/simulated.js";

/**
 * Estado en memoria con el mismo compare-and-swap que el adaptador de Postgres:
 * la escritura solo vale si la versión no se movió.
 */
class MemoryActionStateStore implements ActionStateStore {
  readonly docs = new Map<string, ActionStateDocument>();
  /** Versión que se devuelve al leer, si está fijada (para simular una carrera). */
  readVersionOverride: number | null = null;

  async read(target: string): Promise<ActionStateDocument | null> {
    const doc = this.docs.get(target);
    if (!doc) {
      return null;
    }
    if (this.readVersionOverride !== null) {
      return { target, state: doc.state, version: this.readVersionOverride };
    }
    return doc;
  }

  async write(
    target: string,
    expectedVersion: number,
    next: unknown,
  ): Promise<ActionStateDocument | null> {
    const current = this.docs.get(target);

    if (!current) {
      if (expectedVersion !== 0) {
        return null;
      }
      const created: ActionStateDocument = { target, state: next, version: 1 };
      this.docs.set(target, created);
      return created;
    }

    if (current.version !== expectedVersion) {
      return null;
    }

    const updated: ActionStateDocument = {
      target,
      state: next,
      version: current.version + 1,
    };
    this.docs.set(target, updated);
    return updated;
  }
}

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function executorWith(state: MemoryActionStateStore, faults = "") {
  return new SimulatedExecutor({ state, faults: parseFaults(faults), now: () => NOW });
}

describe("SimulatedExecutor", () => {
  it("aplica un rollback y verifica la post-condicion leyendo el estado", async () => {
    const state = new MemoryActionStateStore();
    state.docs.set("service:checkout", {
      target: "service:checkout",
      state: { service: "checkout", version: "v2.3.4", rollout_percent: 100 },
      version: 1,
    });

    const result = await executorWith(state).rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("applied");
    expect(result.verified).toBe(true);
    expect(result.observedState).toMatchObject({ version: "v2.3.3" });
    expect(state.docs.get("service:checkout")?.version).toBe(2);
  });

  it("deriva un effect_id estable de la clave de idempotencia", async () => {
    const state = new MemoryActionStateStore();
    const first = await executorWith(state).rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });
    const second = await executorWith(state).rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });

    expect(first.effectId).toBe(second.effectId);
  });

  it("no hace nada cuando el estado ya es el esperado", async () => {
    const state = new MemoryActionStateStore();
    state.docs.set("service:checkout", {
      target: "service:checkout",
      state: { service: "checkout", version: "v2.3.3", rollout_percent: 100 },
      version: 1,
    });

    const result = await executorWith(state).rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("noop");
    expect(state.docs.get("service:checkout")?.version).toBe(1);
  });

  it("devuelve conflict y no muta el estado con el fallo 409", async () => {
    const state = new MemoryActionStateStore();
    state.docs.set("service:checkout", {
      target: "service:checkout",
      state: { service: "checkout", version: "v2.3.4", rollout_percent: 100 },
      version: 1,
    });

    const result = await executorWith(state, "409").rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("conflict");
    expect(result.verified).toBe(false);
    expect(state.docs.get("service:checkout")?.version).toBe(1);
    expect(result.evidence.join(" ")).toContain("409");
  });

  it("devuelve conflict con el motivo cuando el proveedor limita la llamada", async () => {
    const state = new MemoryActionStateStore();

    const result = await executorWith(state, "rate_limited").setFlag({
      flag: "checkout.new-checkout",
      value: false,
      reason: "el rollout nuevo falla",
      idempotencyKey: "key-2",
    });

    expect(result.status).toBe("conflict");
    expect(result.evidence.join(" ")).toContain("provider_rate_limited");
  });

  it("consulta el estado en vez de asumir que no se aplico tras un timeout", async () => {
    const state = new MemoryActionStateStore();

    const result = await executorWith(state, "timeout").rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("timeout");
    expect(result.verified).toBe(false);
    // La escritura sí ocurrió: se ve en el estado observado.
    expect(result.observedState).toMatchObject({ version: "v2.3.3" });
    expect(state.docs.get("service:checkout")?.version).toBe(1);
  });

  it("devuelve partial con el subconjunto aplicado", async () => {
    const state = new MemoryActionStateStore();

    const result = await executorWith(state, "partial").rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("partial");
    expect(result.verified).toBe(false);
    expect(result.observedState).toMatchObject({ rollout_percent: 50 });
  });

  it("aplica pero no verifica cuando la readiness nunca llega", async () => {
    const state = new MemoryActionStateStore();

    const result = await executorWith(state, "readiness").rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("applied");
    expect(result.verified).toBe(false);
    expect(result.evidence.join(" ")).toContain("post-condicion");
  });

  it("devuelve conflict si el estado se movio entre la lectura y la escritura", async () => {
    const state = new MemoryActionStateStore();
    state.docs.set("service:checkout", {
      target: "service:checkout",
      state: { service: "checkout", version: "v2.3.4", rollout_percent: 100 },
      version: 1,
    });
    // El lector ve la version 1, pero el documento real ya esta en la 2.
    state.readVersionOverride = 1;
    state.docs.set("service:checkout", {
      target: "service:checkout",
      state: { service: "checkout", version: "v2.3.5", rollout_percent: 100 },
      version: 2,
    });

    const result = await executorWith(state).rollback({
      service: "checkout",
      toVersion: "v2.3.3",
      reason: "pico de 5xx",
      idempotencyKey: "key-1",
    });

    expect(result.status).toBe("conflict");
    expect(result.verified).toBe(false);
  });

  it("silencia una alerta con la duracion pedida", async () => {
    const state = new MemoryActionStateStore();

    const result = await executorWith(state).silenceAlert({
      alertId: "42",
      durationSeconds: 1800,
      reason: "falsa alarma",
      idempotencyKey: "key-3",
    });

    expect(result.status).toBe("applied");
    expect(result.verified).toBe(true);
    expect(result.observedState).toMatchObject({
      status: "silenced",
      silenced_until: "2026-11-21T12:30:00.000Z",
    });
  });

  it("es determinista: la misma entrada da el mismo resultado", async () => {
    const first = new MemoryActionStateStore();
    const second = new MemoryActionStateStore();

    const a = await executorWith(first).setFlag({
      flag: "checkout.new-checkout",
      value: false,
      reason: "el rollout nuevo falla",
      idempotencyKey: "key-2",
    });
    const b = await executorWith(second).setFlag({
      flag: "checkout.new-checkout",
      value: false,
      reason: "el rollout nuevo falla",
      idempotencyKey: "key-2",
    });

    expect(a).toEqual(b);
  });
});

describe("parseFaults", () => {
  it("acepta los alias del entorno y rechaza los desconocidos", () => {
    expect(parseFaults("409,timeout")).toEqual(["conflict", "timeout"]);
    expect(parseFaults("")).toEqual([]);
    expect(parseFaults(undefined)).toEqual([]);
    expect(() => parseFaults("meltdown")).toThrow(/unknown fault/);
  });
});
