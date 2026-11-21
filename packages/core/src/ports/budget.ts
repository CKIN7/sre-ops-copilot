/**
 * Presupuesto con reserva atomica y liquidacion (docs/plan.md §4.5 y §7).
 *
 * El puerto vive en `core` y la implementacion en los adaptadores: el gateway solo
 * conoce esta interfaz y la politica se prueba con fakes (ADR-003, ADR-013).
 *
 * La mecanica es siempre la misma:
 *
 * 1. Antes de la llamada se **reserva** una estimacion de uso. Si el run o el
 *    tenant ya estan en su limite, no hay reserva y la tool no se ejecuta.
 * 2. Despues de la llamada se **liquida** con el uso observado. La diferencia entre
 *    reservado y usado se libera.
 * 3. La reserva es idempotente por `idempotencyKey`: repetirla no suma dos veces.
 *
 * Los ceros son un valor valido. Hoy el modelo es guionizado y las tools no gastan
 * tokens ni dinero, asi que el uso por defecto es cero; la mecanica existe y se
 * ejercita con un medidor inyectado en tests. No se publica un coste de proveedor
 * que no existe.
 */

/** Unidades del presupuesto. Todas no negativas. */
export interface BudgetUsage {
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  /** Reloj de pared atribuido a la operacion; se liquida con la latencia real. */
  wallMs: number;
}

export const ZERO_USAGE: Readonly<BudgetUsage> = Object.freeze({
  tokensIn: 0,
  tokensOut: 0,
  costCents: 0,
  wallMs: 0,
});

/** Limites por run y por tenant. */
export interface BudgetLimits {
  perRun: BudgetUsage;
  perTenant: BudgetUsage;
}

export type BudgetDimension = keyof BudgetUsage;

/** Estado de una reserva. `reserved` es el unico estado vivo. */
export const BUDGET_RESERVATION_STATUSES = ["reserved", "settled"] as const;

export type BudgetReservationStatus = (typeof BUDGET_RESERVATION_STATUSES)[number];

export interface BudgetReservation {
  id: string;
  tenantId: string;
  runId: string | null;
  idempotencyKey: string;
  status: BudgetReservationStatus;
  /** Estimacion reservada antes de la llamada. */
  reserved: BudgetUsage;
  /** Uso liquidado; `null` mientras la reserva sigue viva. */
  used: BudgetUsage | null;
  createdAt: string;
  settledAt: string | null;
}

export interface ReserveBudgetInput {
  tenantId: string;
  /** `null` = operacion fuera de un run (una propuesta abierta desde la API). */
  runId: string | null;
  /** Clave estable: repetirla devuelve la misma reserva sin cobrar dos veces. */
  idempotencyKey: string;
  /** Estimacion que se reserva antes de ejecutar. */
  estimate: BudgetUsage;
  /** Limites que aplican a esta operacion. */
  limits: BudgetLimits;
}

export type BudgetDecision =
  | {
      allowed: true;
      reservation: BudgetReservation;
      /** `true` si la clave ya existia y se devolvio la reserva guardada. */
      replayed: boolean;
    }
  | {
      allowed: false;
      reason: "budget_exceeded";
      dimension: BudgetDimension;
      /** Limite del ambito que se rebaso (`run` o `tenant`). */
      scope: "run" | "tenant";
      limit: number;
      observed: number;
      requested: number;
    };

export interface SettleBudgetInput {
  reservationId: string;
  /** Uso observado. Puede ser menor que la estimacion; la diferencia se libera. */
  usage: BudgetUsage;
  /** Origen de la liquidacion; por defecto una tool call. */
  kind?: "tool_call" | "model" | "action_apply";
  tool?: string | null;
}

export interface BudgetSettlement {
  reservation: BudgetReservation;
  /** `true` si la reserva ya estaba liquidada y no se volvio a escribir. */
  replayed: boolean;
}

/** Uso agregado de un run/tenant, util para la timeline y los tests. */
export interface BudgetSnapshot {
  tenantId: string;
  runId: string | null;
  reserved: BudgetUsage;
  settled: BudgetUsage;
  openReservations: number;
}

export interface BudgetPort {
  reserve(input: ReserveBudgetInput): Promise<BudgetDecision>;
  settle(input: SettleBudgetInput): Promise<BudgetSettlement>;
  /**
   * Libera una reserva sin uso observado. Se usa cuando el camino falla antes de
   * llamar a la tool (por ejemplo, el audit no esta disponible).
   */
  release(reservationId: string): Promise<BudgetSettlement>;
  /** Foto del consumo de un tenant y, si se pide, de un run. */
  snapshot(tenantId: string, runId: string | null): Promise<BudgetSnapshot>;
}

/**
 * Medidor de uso del borde de una tool call. El gateway no inventa tokens: el
 * medidor los aporta. El medidor por defecto devuelve cero porque no hay LLM real;
 * los tests inyectan uno determinista para ejercitar la mecanica.
 */
export interface ToolUsageMeter {
  estimate(input: {
    tool: string;
    args: unknown;
    tenantId: string;
    runId: string | null;
  }): BudgetUsage;
}

export const ZERO_USAGE_METER: ToolUsageMeter = Object.freeze({
  estimate: () => ZERO_USAGE,
});
