import { goldenCases } from "../cases/golden-set.js";
import { redTeamCases } from "../cases/red-team.js";
import { runSuite } from "../harness/runner.js";

import { printMetrics, writeResultFile } from "./output.js";

/**
 * `pnpm evals`: 40 casos de golden set + 20 de red-team sobre fixtures.
 *
 * Repite cada caso 5 veces para medir pass@5 de verdad. Con el modelo determinista y
 * fixtures, las cinco repeticiones dan lo mismo; no se inventa aleatoriedad.
 */
async function main(): Promise<void> {
  const repeats = Number.parseInt(process.env.EVALS_REPEATS ?? "5", 10);
  const cases = [...goldenCases(), ...redTeamCases()];
  const result = await runSuite(cases, {
    mode: "fixtures",
    repeats: Number.isFinite(repeats) && repeats > 0 ? repeats : 5,
  });

  await writeResultFile(result);
  printMetrics(result);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
