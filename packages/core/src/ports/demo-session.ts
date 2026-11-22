/**
 * Estado efimero de la demo publica (docs/plan.md §4.11 y §12).
 *
 * La sesion vive en Postgres, no en memoria: el techo diario, el gasto y los fallos
 * se comparten entre replicas y sobreviven a un reinicio. La IP se guarda **hasheada**
 * y no se persiste ningun dato personal.
 *
 * El gateway es el unico que llama a este puerto; la UI solo lee el estado.
 */
export type DemoDenialReason =
  | "daily_cap"
  | "session_expired"
  | "session_budget"
  | "replay_only";

export interface DemoSessionState {
  sessionId: string;
  /** SHA-256 de la IP; nunca la IP en claro. */
  ipHash: string;
  createdAt: string;
  expiresAt: string;
  spentCents: number;
  steps: number;
  sessionsToday: number;
  dailyLimit: number;
  failures: number;
  replayOnly: boolean;
}

export interface DemoSessionDecision {
  allowed: boolean;
  /** `null` si esta permitida. */
  reason: DemoDenialReason | null;
  state: DemoSessionState | null;
  /** Limite que se rebaso, util para el 429. */
  limit: number | null;
  observed: number | null;
}

export interface OpenDemoSessionInput {
  sessionId: string;
  ip: string;
  now: number;
  ttlMs: number;
  dailyLimit: number;
}

export interface TouchDemoSessionInput {
  sessionId: string;
  ip: string;
  now: number;
  ttlMs: number;
  dailyLimit: number;
}

export interface ChargeDemoSessionInput {
  sessionId: string;
  now: number;
  ttlMs: number;
  costCents: number;
  /** Limite de coste acumulado de la sesion. */
  maxCostCents: number;
  /** Limite de steps acumulados de la sesion. */
  maxSteps: number;
}

export interface RecordDemoFailureInput {
  sessionId: string;
  now: number;
  /** Umbral de fallos consecutivos que dispara `REPLAY_ONLY`. */
  threshold: number;
}

export interface DemoSessionStats {
  sessionsToday: number;
  dailyLimit: number | null;
  replayOnly: boolean;
  failures: number;
}

export interface DemoSessionStore {
  /** Registra la sesion del dia de forma atomica y aplica el techo global. */
  open(input: OpenDemoSessionInput): Promise<DemoSessionDecision>;
  /** Refresca la sesion y devuelve su estado actual (incluido el breaker). */
  touch(input: TouchDemoSessionInput): Promise<DemoSessionDecision>;
  /** Cobra un step y su coste con reserva atomica; es el presupuesto de la sesion. */
  charge(input: ChargeDemoSessionInput): Promise<DemoSessionDecision>;
  /** Un fallo de dependencia acerca el circuit breaker. */
  recordFailure(input: RecordDemoFailureInput): Promise<DemoSessionState>;
  setReplayOnly(value: boolean, now: number): Promise<void>;
  isReplayOnly(): Promise<boolean>;
  stats(now: number): Promise<DemoSessionStats>;
  /** Resiembra nocturna / boton de reinicio: vacia sesiones y breaker. */
  reset(): Promise<void>;
}
