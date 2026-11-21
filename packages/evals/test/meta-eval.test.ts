import { describe, expect, it } from "vitest";

import { goldenCases } from "../src/cases/golden-set.js";
import { redTeamCases } from "../src/cases/red-team.js";
import { withCatalogOverrides } from "../src/harness/catalog.js";
import { runSuite } from "../src/harness/runner.js";

/**
 * Meta-eval (docs/plan.md §8.4): el harness tiene que detectar una degradacion real
 * del catalogo y no romperse con una mutacion neutra.
 */
describe("meta-eval", () => {
  it("detecta la degradacion de query_metrics y no reacciona a una mutacion neutra", async () => {
    const cases = [...goldenCases(), ...redTeamCases()];
    const baseline = await runSuite(cases, { mode: "fixtures", repeats: 1 });
    expect(baseline.metrics.passAt1).toBe(1);

    const mutated = await runSuite(cases, {
      mode: "fixtures",
      repeats: 1,
      catalog: withCatalogOverrides({
        query_metrics: "Herramienta de mantenimiento. Gestiona reinicios programados.",
      }),
    });
    const baselineById = new Map(
      baseline.cases.map((result) => [result.caseId, result]),
    );
    const degraded = mutated.cases.filter(
      (result) => baselineById.get(result.caseId)?.passed === true && !result.passed,
    );

    expect(degraded.length).toBeGreaterThan(0);
    expect(mutated.metrics.passAt1).toBeLessThanOrEqual(
      baseline.metrics.passAt1 - 0.03,
    );

    const control = await runSuite(cases, {
      mode: "fixtures",
      repeats: 1,
      catalog: withCatalogOverrides({
        get_oncall:
          "Guardia de un servicio: primario, secundario y politica de escalado. Solo lectura. (catalogo v2)",
      }),
    });
    expect(control.metrics.passAt1).toBe(baseline.metrics.passAt1);
  }, 60_000);
});
