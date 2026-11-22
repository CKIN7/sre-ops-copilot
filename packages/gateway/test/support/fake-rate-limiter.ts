import type {
  RateLimitDecision,
  RateLimitInput,
  RateLimiter,
} from "@beacon/core/ports/rate-limiter";

/**
 * Rate limit en memoria para los tests del gateway.
 *
 * Por defecto permite todo; `deny` simula un límite rebasado para comprobar que el
 * gateway rechaza la llamada y la audita.
 */
export class FakeRateLimiter implements RateLimiter {
  readonly calls: RateLimitInput[] = [];
  /** Si está definida, la siguiente llamada se rechaza con ese ámbito. */
  deny: {
    scope: "run" | "tenant" | "tool" | "session" | "ip";
    limit: number;
    observed: number;
  } | null = null;

  async consume(input: RateLimitInput): Promise<RateLimitDecision> {
    this.calls.push(input);

    if (this.deny) {
      return {
        allowed: false,
        scope: this.deny.scope,
        limit: this.deny.limit,
        observed: this.deny.observed,
        retryAfterMs: 1_000,
      };
    }

    return { allowed: true, scope: null, limit: 0, observed: 0, retryAfterMs: null };
  }
}
