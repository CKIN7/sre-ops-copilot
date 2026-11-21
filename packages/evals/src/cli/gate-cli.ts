import { goldenCases } from "../cases/golden-set.js";
import { redTeamCases } from "../cases/red-team.js";
import { evaluateGate } from "../harness/gate.js";
import { runSuite } from "../harness/runner.js";

import { printMetrics, readBaseline, writeResultFile } from "./output.js";

/**
 * Gate de CI: corre los evals, escribe el resultado y falla si pass@1 cae mas de
 * 3 pp, si el coste pasa del 120% o si hay cualquier violacion de invariante.
 */
async function main(): Promise<void> {
  const cases = [...goldenCases(), ...redTeamCases()];
  const result = await runSuite(cases, { mode: "fixtures", repeats: 5 });
  await writeResultFile(result);
  printMetrics(result);

  const baseline = await readBaseline();
  const gate = evaluateGate(result.metrics, baseline);

  if (!gate.ok) {
    console.error("\ngate: FALLA");
    for (const failure of gate.failures) {
      console.error(`- ${failure.code}: ${failure.detail}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `\ngate: OK (baseline pass@1 ${(baseline.passAt1 * 100).toFixed(1)}%, coste ${baseline.averageCostCents})`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
