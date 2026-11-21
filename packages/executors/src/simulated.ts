import { effectIdFromKey } from "@beacon/core/domain/idempotency";
import type {
  ActionExecutor,
  ActionResult,
  FlagCommand,
  RollbackCommand,
  SilenceCommand,
} from "@beacon/core/ports/action-executor";
import type { ActionStateStore } from "@beacon/core/ports/action-state";

import type { Fault } from "./faults.js";

/** Nombre del ejecutor: queda en la fila del efecto y en el audit. */
export const SIMULATED_EXECUTOR_NAME = "simulated";

export interface SimulatedExecutorOptions {
  /** Estado del mundo que se muta. */
  state: ActionStateStore;
  /**
   * Fallos inyectados. Si hay varios, aplica el **primero** de la lista: el
   * orden es la prioridad y el resultado es determinista.
   */
  faults?: readonly Fault[];
  /** Reloj inyectable: el ejecutor no consulta la hora del sistema por su cuenta. */
  now?: () => number;
}

interface OperationSpec {
  /** Clave del documento de estado que se muta. */
  target: string;
  /** Versión leída: la escritura solo vale si el estado sigue en esta versión. */
  expectedVersion: number;
  /** Estado actual. */
  base: Record<string, unknown>;
  /** Estado tras aplicar. */
  next: Record<string, unknown>;
  /** Estado tras aplicar solo a medias. */
  partial: Record<string, unknown>;
  /** Estado aplicado pero sin la post-condición. */
  notReady: Record<string, unknown>;
  /** Post-condición: se comprueba **leyendo** el estado, no se supone. */
  verify: (state: Record<string, unknown>) => boolean;
  /** Evidencia de la operación. */
  evidence: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Executor simulado (docs/plan.md §6.2, ADR-005).
 *
 * Muta un documento de estado versionado en Postgres y **no** habla con ningún
 * proveedor. Es determinista: sin fallos inyectados, la misma entrada produce
 * siempre el mismo resultado. Es el ejecutor de la demo pública, de los evals y del
 * CI.
 *
 * Los fallos reproducen lo que de verdad duele:
 *
 * | Fallo | Qué hace | Qué devuelve |
 * |---|---|---|
 * | `conflict` | el proveedor rechaza (409) | `conflict` con el estado observado |
 * | `rate_limited` | el proveedor limita (429) | `conflict` con `provider_rate_limited` en la evidencia |
 * | `timeout` | la escritura ocurrió y la respuesta se perdió | `timeout` con el estado **consultado** |
 * | `partial` | la escritura ocurrió a medias | `partial` con el subconjunto aplicado |
 * | `readiness` | la escritura ocurrió pero la post-condición no se cumple | `applied` con `verified=false` |
 *
 * `rate_limited` se traduce a `conflict` porque el contrato de `ActionResult` no
 * tiene un estado propio para ello (ADR-005: el puerto no cambia) y el
 * comportamiento seguro es el mismo: no reintentar a ciegas. El motivo concreto
 * queda en la evidencia.
 */
export class SimulatedExecutor implements ActionExecutor {
  readonly #state: ActionStateStore;
  readonly #faults: readonly Fault[];
  readonly #now: () => number;

  constructor(options: SimulatedExecutorOptions) {
    this.#state = options.state;
    this.#faults = options.faults ?? [];
    this.#now = options.now ?? (() => Date.now());
  }

  async rollback(command: RollbackCommand): Promise<ActionResult> {
    const target = `service:${command.service}`;
    const current = await this.#state.read(target);
    const base = asRecord(current?.state) ?? {
      service: command.service,
      version: "",
      rollout_percent: 0,
    };

    const next = {
      ...base,
      service: command.service,
      version: command.toVersion,
      rollout_percent: 100,
      last_rollback_at: this.#nowIso(),
    };

    return this.#execute(
      {
        target,
        expectedVersion: current?.version ?? 0,
        base,
        next,
        partial: { ...next, rollout_percent: 50 },
        notReady: { ...next, rollout_percent: 0 },
        verify: (state) =>
          state.version === command.toVersion && state.rollout_percent === 100,
        evidence: [`rollback de ${command.service} a ${command.toVersion}`],
      },
      command.idempotencyKey,
    );
  }

  async setFlag(command: FlagCommand): Promise<ActionResult> {
    const target = `flag:${command.flag}`;
    const current = await this.#state.read(target);
    const base = asRecord(current?.state) ?? {
      flag: command.flag,
      value: "",
      rollout_percent: 0,
    };

    const next = {
      ...base,
      flag: command.flag,
      value: String(command.value),
      updated_at: this.#nowIso(),
    };

    return this.#execute(
      {
        target,
        expectedVersion: current?.version ?? 0,
        base,
        next,
        partial: { ...next, rollout_percent: 50 },
        // El proveedor acepta el cambio pero el valor no se propaga.
        notReady: { ...base, updated_at: this.#nowIso() },
        verify: (state) => state.value === String(command.value),
        evidence: [`flag ${command.flag} -> ${String(command.value)}`],
      },
      command.idempotencyKey,
    );
  }

  async silenceAlert(command: SilenceCommand): Promise<ActionResult> {
    const target = `alert:${command.alertId}`;
    const current = await this.#state.read(target);
    const base = asRecord(current?.state) ?? {
      alert_id: command.alertId,
      status: "",
      silenced_until: null,
    };

    const until = new Date(
      this.#now() + command.durationSeconds * 1000,
    ).toISOString();

    const next = {
      ...base,
      alert_id: command.alertId,
      status: "silenced",
      silenced_until: until,
    };

    return this.#execute(
      {
        target,
        expectedVersion: current?.version ?? 0,
        base,
        next,
        partial: { ...base, status: "acknowledged", silenced_until: null },
        notReady: { ...base, status: "acknowledged", silenced_until: null },
        verify: (state) => state.silenced_until === until,
        evidence: [
          `alerta ${command.alertId} silenciada ${command.durationSeconds}s hasta ${until}`,
        ],
      },
      command.idempotencyKey,
    );
  }

  async #execute(spec: OperationSpec, idempotencyKey: string): Promise<ActionResult> {
    const startedAt = this.#now();
    const effectId = effectIdFromKey(idempotencyKey);
    const fault = this.#faults[0] ?? null;
    const durationMs = (): number => Math.max(0, this.#now() - startedAt);

    if (fault === "conflict" || fault === "rate_limited") {
      const observed = await this.#state.read(spec.target);
      return {
        effectId,
        status: "conflict",
        observedState: observed?.state ?? null,
        verified: false,
        durationMs: durationMs(),
        evidence:
          fault === "conflict"
            ? ["provider: 409 conflict; el estado no se modifico", ...spec.evidence]
            : [
                "provider: 429 provider_rate_limited; el estado no se modifico",
                ...spec.evidence,
              ],
      };
    }

    if (fault === "timeout") {
      // La escritura ocurrió y la respuesta se perdió: no se asume que no pasó, se
      // consulta el estado (docs/plan.md §6.3, punto 5).
      const written = await this.#state.write(spec.target, spec.expectedVersion, spec.next);
      const observed = written ?? (await this.#state.read(spec.target));
      return {
        effectId,
        status: "timeout",
        observedState: observed?.state ?? null,
        verified: false,
        durationMs: durationMs(),
        evidence: [
          "la llamada al proveedor expiro; el estado se consulto en vez de asumir que no se aplico",
          ...spec.evidence,
        ],
      };
    }

    if (fault === "partial") {
      const written = await this.#state.write(spec.target, spec.expectedVersion, spec.partial);
      return {
        effectId,
        status: "partial",
        observedState: written?.state ?? null,
        verified: false,
        durationMs: durationMs(),
        evidence: ["aplicado solo en parte; no se reintenta a ciegas", ...spec.evidence],
      };
    }

    if (fault === "readiness") {
      // Se aplica pero la post-condición no se cumple: nunca se declara éxito.
      const written = await this.#state.write(spec.target, spec.expectedVersion, spec.notReady);
      const observed = written ?? (await this.#state.read(spec.target));
      return {
        effectId,
        status: "applied",
        observedState: observed?.state ?? null,
        verified: false,
        durationMs: durationMs(),
        evidence: [
          "la escritura se aplico pero la post-condicion no se cumplio: no se declara exito",
          ...spec.evidence,
        ],
      };
    }

    // Camino normal. Si el estado ya es el esperado, no hay nada que escribir.
    if (spec.verify(spec.base)) {
      return {
        effectId,
        status: "noop",
        observedState: spec.base,
        verified: true,
        durationMs: durationMs(),
        evidence: ["el estado ya era el esperado; no se escribio nada", ...spec.evidence],
      };
    }

    const written = await this.#state.write(spec.target, spec.expectedVersion, spec.next);
    if (!written) {
      // El estado se movió entre la lectura y la escritura: 409 real, no reintento.
      const observed = await this.#state.read(spec.target);
      return {
        effectId,
        status: "conflict",
        observedState: observed?.state ?? null,
        verified: false,
        durationMs: durationMs(),
        evidence: [
          "el estado cambio antes de escribir (409): hay que reconciliar, no reintentar",
          ...spec.evidence,
        ],
      };
    }

    const verified = spec.verify(asRecord(written.state) ?? {});
    return {
      effectId,
      status: "applied",
      observedState: written.state,
      verified,
      durationMs: durationMs(),
      evidence: verified
        ? ["post-condicion verificada leyendo el estado", ...spec.evidence]
        : ["la post-condicion no se cumplio", ...spec.evidence],
    };
  }

  #nowIso(): string {
    return new Date(this.#now()).toISOString();
  }
}
