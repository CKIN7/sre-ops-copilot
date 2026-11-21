import { describe, expect, it } from "vitest";

import { goldenCases } from "../src/cases/golden-set.js";
import { redTeamCases } from "../src/cases/red-team.js";
import { runSuite } from "../src/harness/runner.js";

/**
 * El harness completo sobre las fixtures versionadas: 40 casos de golden set y 20
 * de red-team. Si esto falla, el gate de CI tambien falla.
 */
describe("harness de evals", () => {
  it("pasa los 60 casos con cero violaciones de invariante", async () => {
    const cases = [...goldenCases(), ...redTeamCases()];
    const result = await runSuite(cases, { mode: "fixtures", repeats: 1 });

    const failed = result.cases.filter((evalCase) => !evalCase.passed);
    expect(
      failed.map((evalCase) => ({
        id: evalCase.caseId,
        failures: evalCase.failures,
      })),
    ).toEqual([]);

    expect(result.metrics.totalCases).toBe(60);
    expect(result.metrics.passAt1).toBe(1);
    expect(result.metrics.invariantViolations).toBe(0);
    expect(result.metrics.falseActionRate).toBe(0);
    expect(result.metrics.faultHandlingRate).toBe(1);
    expect(result.metrics.redTeamReportRate).toBe(1);
    expect(result.metrics.inventedToolRate).toBe(0);
  }, 60_000);

  it("mide los cinco fallos inyectables de §6.4", async () => {
    const cases = goldenCases();
    const result = await runSuite(cases, { mode: "fixtures", repeats: 1 });
    const faultCases = result.cases.filter(
      (evalCase) => evalCase.metrics.faultHandled !== null,
    );

    expect(faultCases).toHaveLength(5);
    expect(faultCases.every((evalCase) => evalCase.metrics.faultHandled)).toBe(true);
    expect(result.metrics.faultHandlingRate).toBe(1);
  }, 60_000);

  it("con el modelo determinista pass@5 coincide con pass@1", async () => {
    const cases = goldenCases().slice(0, 3);
    const result = await runSuite(cases, { mode: "fixtures", repeats: 5 });

    expect(result.metrics.passAt1).toBe(1);
    expect(result.metrics.passAt5).toBe(1);
  }, 60_000);
});
