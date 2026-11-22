import type {
  ChargeDemoSessionInput,
  DemoSessionDecision,
  DemoSessionState,
  DemoSessionStats,
  DemoSessionStore,
  OpenDemoSessionInput,
  RecordDemoFailureInput,
  TouchDemoSessionInput,
} from "@beacon/core/ports/demo-session";

/**
 * `DemoSessionStore` en memoria para la suite de politicas del gateway.
 *
 * No simula Postgres: ejercita la politica (techo diario, presupuesto de sesion,
 * breaker y replay) sin abrir una conexion. La atomicidad real se prueba contra
 * Postgres en `apps/api/test/demo.integration.test.ts` cuando hay base.
 */
export class FakeDemoSessions implements DemoSessionStore {
  replayOnly = false;
  failures = 0;
  sessionsToday = 0;
  steps = 0;
  spentCents = 0;
  expired = false;
  readonly opens: OpenDemoSessionInput[] = [];
  readonly charges: ChargeDemoSessionInput[] = [];
  readonly recordFailures: RecordDemoFailureInput[] = [];
  #threshold = 5;

  async open(input: OpenDemoSessionInput): Promise<DemoSessionDecision> {
    this.opens.push(input);
    if (this.sessionsToday >= input.dailyLimit) {
      this.replayOnly = true;
      return {
        allowed: false,
        reason: "daily_cap",
        state: null,
        limit: input.dailyLimit,
        observed: this.sessionsToday,
      };
    }
    this.sessionsToday += 1;
    return { allowed: true, reason: null, state: this.#state(input.sessionId), limit: null, observed: null };
  }

  async touch(input: TouchDemoSessionInput): Promise<DemoSessionDecision> {
    if (this.expired) {
      return {
        allowed: false,
        reason: "session_expired",
        state: null,
        limit: null,
        observed: null,
      };
    }
    return {
      allowed: true,
      reason: null,
      state: this.#state(input.sessionId),
      limit: null,
      observed: null,
    };
  }

  async charge(input: ChargeDemoSessionInput): Promise<DemoSessionDecision> {
    this.charges.push(input);
    if (this.steps + 1 > input.maxSteps) {
      return {
        allowed: false,
        reason: "session_budget",
        state: this.#state(input.sessionId),
        limit: input.maxSteps,
        observed: this.steps,
      };
    }
    if (this.spentCents + input.costCents > input.maxCostCents) {
      return {
        allowed: false,
        reason: "session_budget",
        state: this.#state(input.sessionId),
        limit: input.maxCostCents,
        observed: this.spentCents,
      };
    }
    this.steps += 1;
    this.spentCents += Math.max(0, input.costCents);
    return {
      allowed: true,
      reason: null,
      state: this.#state(input.sessionId),
      limit: null,
      observed: null,
    };
  }

  async recordFailure(input: RecordDemoFailureInput): Promise<DemoSessionState> {
    this.recordFailures.push(input);
    this.#threshold = input.threshold;
    this.failures += 1;
    if (this.failures >= input.threshold) {
      this.replayOnly = true;
    }
    return this.#state(input.sessionId);
  }

  async setReplayOnly(value: boolean): Promise<void> {
    this.replayOnly = value;
  }

  async isReplayOnly(): Promise<boolean> {
    return this.replayOnly;
  }

  async stats(): Promise<DemoSessionStats> {
    return {
      sessionsToday: this.sessionsToday,
      dailyLimit: null,
      replayOnly: this.replayOnly,
      failures: this.failures,
    };
  }

  async reset(): Promise<void> {
    this.replayOnly = false;
    this.failures = 0;
    this.sessionsToday = 0;
    this.steps = 0;
    this.spentCents = 0;
    this.expired = false;
  }

  #state(sessionId: string): DemoSessionState {
    return {
      sessionId,
      ipHash: "hash",
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(3_600_000).toISOString(),
      spentCents: this.spentCents,
      steps: this.steps,
      sessionsToday: this.sessionsToday,
      dailyLimit: this.#threshold,
      failures: this.failures,
      replayOnly: this.replayOnly,
    };
  }
}
