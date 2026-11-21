import type {
  RateLimitDecision,
  RateLimitInput,
  RateLimiter,
} from "@beacon/core/ports/rate-limiter";

/** Rate limit que permite todo: el eval mide politica de agente, no carga. */
export class AllowAllRateLimiter implements RateLimiter {
  readonly calls: RateLimitInput[] = [];

  async consume(input: RateLimitInput): Promise<RateLimitDecision> {
    this.calls.push(input);
    return { allowed: true, scope: null, limit: 0, observed: 0, retryAfterMs: null };
  }
}
