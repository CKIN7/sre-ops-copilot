import type {
  BudgetDecision,
  BudgetPort,
  BudgetReservation,
  BudgetSettlement,
  BudgetSnapshot,
  ReserveBudgetInput,
  SettleBudgetInput,
} from "@beacon/core/ports/budget";

/**
 * `BudgetPort` en memoria para la suite de politicas del gateway.
 *
 * No simula Postgres: solo registra si el gateway reservo antes de llamar, liquido
 * despues y libero cuando el audit fallo. La atomicidad real se prueba en
 * `apps/api/test/budget.integration.test.ts`.
 */
export class FakeBudget implements BudgetPort {
  readonly reserves: ReserveBudgetInput[] = [];
  readonly settlements: SettleBudgetInput[] = [];
  readonly releases: string[] = [];
  deny: Omit<Extract<BudgetDecision, { allowed: false }>, "allowed"> | null = null;
  #seq = 0;

  async reserve(input: ReserveBudgetInput): Promise<BudgetDecision> {
    this.reserves.push(input);
    if (this.deny) {
      return { allowed: false, ...this.deny };
    }
    this.#seq += 1;
    return {
      allowed: true,
      replayed: false,
      reservation: {
        id: `budget-${this.#seq}`,
        tenantId: input.tenantId,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        status: "reserved",
        reserved: input.estimate,
        used: null,
        createdAt: new Date(0).toISOString(),
        settledAt: null,
      },
    };
  }

  async settle(input: SettleBudgetInput): Promise<BudgetSettlement> {
    this.settlements.push(input);
    return {
      replayed: false,
      reservation: {
        id: input.reservationId,
        tenantId: "tenant",
        runId: null,
        idempotencyKey: "key",
        status: "settled",
        reserved: { tokensIn: 0, tokensOut: 0, costCents: 0, wallMs: 0 },
        used: input.usage,
        createdAt: new Date(0).toISOString(),
        settledAt: new Date(1).toISOString(),
      } satisfies BudgetReservation,
    };
  }

  async release(reservationId: string): Promise<BudgetSettlement> {
    this.releases.push(reservationId);
    return this.settle({
      reservationId,
      usage: { tokensIn: 0, tokensOut: 0, costCents: 0, wallMs: 0 },
    });
  }

  async snapshot(tenantId: string, runId: string | null): Promise<BudgetSnapshot> {
    return {
      tenantId,
      runId,
      reserved: { tokensIn: 0, tokensOut: 0, costCents: 0, wallMs: 0 },
      settled: { tokensIn: 0, tokensOut: 0, costCents: 0, wallMs: 0 },
      openReservations: 0,
    };
  }
}
