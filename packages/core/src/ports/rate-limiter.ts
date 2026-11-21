/**
 * Rate limit con ventana deslizante (docs/plan.md §4.4, ADR-012).
 *
 * El puerto vive en `core` y la implementación en los adaptadores: el gateway solo
 * conoce esta interfaz (ADR-003), así que la política se prueba sin Postgres.
 */

/** Ámbitos del límite: por run, por tenant y por tool dentro del tenant. */
export type RateLimitScopeKind = "run" | "tenant" | "tool";

export interface RateLimitInput {
  tenantId: string;
  /** `null` = llamada fuera de un run (una propuesta abierta desde la API). */
  runId: string | null;
  tool: string;
}

export interface RateLimitDecision {
  /** `false` cuando algún ámbito rebasa su límite. */
  allowed: boolean;
  /** Ámbito que rebasó el límite; `null` si la llamada está permitida. */
  scope: RateLimitScopeKind | null;
  /** Límite del ámbito que rebasó. */
  limit: number;
  /** Eventos observados en la ventana. */
  observed: number;
  /** Milisegundos hasta que expire el evento más viejo de la ventana; `null` si está permitido. */
  retryAfterMs: number | null;
}

/** Límites por ámbito y tamaño de la ventana deslizante. */
export interface RateLimitPolicy {
  /** Tool calls por run y por ventana. */
  run: number;
  /** Tool calls por tenant y por ventana. */
  tenant: number;
  /** Tool calls de una misma tool por tenant y por ventana. */
  tool: number;
  /** Tamaño de la ventana deslizante, en milisegundos. */
  windowMs: number;
}

export interface RateLimiter {
  /**
   * Cuenta el evento en la ventana si ningún ámbito rebasa su límite.
   * Una llamada denegada no se cuenta: no consume presupuesto.
   */
  consume(input: RateLimitInput): Promise<RateLimitDecision>;
}
