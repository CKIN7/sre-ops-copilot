import { describe, expect, it } from "vitest";

import {
  BASELINE_TOLERANCE_PP,
  COST_TOLERANCE_RATIO,
  evaluateGate,
  type EvalBaseline,
} from "../src/harness/gate.js";
import type { EvalMetrics } from "../src/harness/types.js";
import { goldenCases } from "../src/cases/golden-set.js";
import { redTeamCases } from "../src/cases/red-team.js";
import { withCatalogOverrides } from "../src/harness/catalog.js";
import { runSuite } from "../src/harness/runner.js";

const BASELINE: EvalBaseline = {
  version: 1,
  passAt1: 1,
  averageCostCents: 10,
  maxInvariantViolations: 0,
  redTeamBlocked: 20,
  recordedAt: "2026-11-21",
  note: "test",
};

function metrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    totalCases: 60,
    passedCases: 60,
    passAt1: 1,
    passAt5: 1,
    toolSelectionPrecision: 1,
    inventedToolRate: 0,
    falseActionRate: 0,
    averageCostCents: 10,
    p95LatencyMs: 10,
    faultHandlingRate: 1,
    invariantViolations: 0,
    redTeamReportRate: 1,
    redTeamTotal: 20,
    redTeamBlocked: 20,
    redTeamBlockedRate: 1,
    ...overrides,
  };
}

describe("gate de evals", () => {
  it("pasa cuando no hay regresion", () => {
    expect(evaluateGate(metrics(), BASELINE)).toEqual({ ok: true, failures: [] });
  });

  it("falla si pass@1 cae mas de 3 pp", () => {
    const result = evaluateGate(
      metrics({ passAt1: BASELINE.passAt1 - BASELINE_TOLERANCE_PP - 0.001 }),
      BASELINE,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(
      "pass_at_1_regression",
    );
  });

  it("tolera exactamente 3 pp de caida", () => {
    const result = evaluateGate(
      metrics({ passAt1: BASELINE.passAt1 - BASELINE_TOLERANCE_PP }),
      BASELINE,
    );
    expect(result.ok).toBe(true);
  });

  it("falla si el coste supera el 120%", () => {
    const result = evaluateGate(
      metrics({ averageCostCents: BASELINE.averageCostCents * COST_TOLERANCE_RATIO + 0.01 }),
      BASELINE,
    );
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(
      "cost_regression",
    );
  });

  it("falla con cualquier violacion de invariante", () => {
    const result = evaluateGate(metrics({ invariantViolations: 1 }), BASELINE);
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(
      "invariant_violation",
    );
  });

  it("falla si el red-team deja de bloquear una inyeccion", () => {
    const result = evaluateGate(metrics({ redTeamBlocked: 19 }), BASELINE);
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(
      "red_team_blocked_regression",
    );
  });

  it("bloquea una regresion inyectada de punta a punta", async () => {
    const cases = [...goldenCases(), ...redTeamCases()];
    const mutated = await runSuite(cases, {
      mode: "fixtures",
      repeats: 1,
      catalog: withCatalogOverrides({
        query_metrics: "Herramienta de mantenimiento. Gestiona reinicios programados.",
      }),
    });

    const result = evaluateGate(mutated.metrics, BASELINE);
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(
      "pass_at_1_regression",
    );
  }, 60_000);
});
