import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { goldenCases } from "../cases/golden-set.js";
import { redTeamCases } from "../cases/red-team.js";
import { withCatalogOverrides } from "../harness/catalog.js";
import { runSuite } from "../harness/runner.js";

const META_RESULTS_PATH = fileURLToPath(
  new URL("../../meta-eval-results.json", import.meta.url),
);

/**
 * Meta-eval (docs/plan.md §8.4).
 *
 * 1. Corre el set completo y exige que todo pase: si el baseline ya falla, el
 *    meta-eval no prueba nada.
 * 2. Degrada la descripcion de `query_metrics` y comprueba que los casos que la
 *    necesitan fallan. Si no caen, el harness es teatro.
 * 3. Control: una mutacion neutra de `get_oncall` (sigue anunciando "guardia") no
 *    debe romper nada. Sin este control, "detectar" podria significar simplemente
 *    "cualquier cambio rompe el harness".
 */
async function main(): Promise<void> {
  const cases = [...goldenCases(), ...redTeamCases()];
  const baseline = await runSuite(cases, { mode: "fixtures", repeats: 1 });

  if (baseline.metrics.passAt1 < 1) {
    console.error(
      `meta-eval invalido: el baseline ya falla (${baseline.metrics.passedCases}/${baseline.metrics.totalCases})`,
    );
    process.exitCode = 2;
    return;
  }

  const mutated = await runSuite(cases, {
    mode: "fixtures",
    repeats: 1,
    catalog: withCatalogOverrides({
      query_metrics: "Herramienta de mantenimiento del cluster. Gestiona reinicios programados.",
    }),
  });

  const baselineById = new Map(
    baseline.cases.map((result) => [result.caseId, result]),
  );
  const degradedCases = mutated.cases.filter(
    (result) => baselineById.get(result.caseId)?.passed === true && !result.passed,
  );
  const impactedCases = cases.filter((evalCase) =>
    evalCase.expect.trajectory.expectedTools.includes("query_metrics"),
  );
  const detected =
    degradedCases.length > 0 &&
    mutated.metrics.passAt1 <= baseline.metrics.passAt1 - 0.03;

  const control = await runSuite(cases, {
    mode: "fixtures",
    repeats: 1,
    catalog: withCatalogOverrides({
      get_oncall:
        "Guardia de un servicio: primario, secundario y politica de escalado. Solo lectura. (catalogo v2)",
    }),
  });
  const controlOk =
    control.metrics.passAt1 === baseline.metrics.passAt1 &&
    control.metrics.invariantViolations === baseline.metrics.invariantViolations;

  const report = {
    baselinePassAt1: baseline.metrics.passAt1,
    mutatedPassAt1: mutated.metrics.passAt1,
    controlPassAt1: control.metrics.passAt1,
    impactedCases: impactedCases.length,
    degradedCases: degradedCases.length,
    detected,
    controlOk,
    degradedCaseIds: degradedCases.map((result) => result.caseId),
    measuredAt: new Date().toISOString(),
  };
  await writeFile(
    META_RESULTS_PATH,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log(`baseline pass@1: ${(baseline.metrics.passAt1 * 100).toFixed(1)}%`);
  console.log(
    `mutacion query_metrics -> pass@1: ${(mutated.metrics.passAt1 * 100).toFixed(1)}%`,
  );
  console.log(`casos impactados por la mutacion: ${impactedCases.length}`);
  console.log(`casos que pasaban y ahora fallan: ${degradedCases.length}`);
  console.log(`degradacion detectada: ${detected ? "SI" : "NO"}`);
  console.log(
    `control get_oncall -> pass@1: ${(control.metrics.passAt1 * 100).toFixed(1)}% (${controlOk ? "sin cambios, correcto" : "cambio inesperado"})`,
  );

  if (!detected) {
    console.error(
      "meta-eval: FALLA. El harness no detecta la degradacion del catalogo; hay que arreglar el harness, no el resultado.",
    );
    process.exitCode = 1;
    return;
  }
  if (!controlOk) {
    console.error(
      "meta-eval: FALLA. Una mutacion neutra rompe el harness: la deteccion no es especifica.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("meta-eval: OK");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
