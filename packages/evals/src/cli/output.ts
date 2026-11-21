import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { EvalBaseline } from "../harness/gate.js";
import type { EvalRunResult } from "../harness/types.js";

/** Archivos de salida del harness, siempre en la raiz del paquete. */
export const RESULTS_PATH = fileURLToPath(
  new URL("../../eval-results.json", import.meta.url),
);
export const BASELINE_PATH = fileURLToPath(
  new URL("../../baseline.json", import.meta.url),
);

export async function writeResultFile(result: EvalRunResult): Promise<void> {
  await writeFile(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function readResultFile(): Promise<EvalRunResult> {
  return JSON.parse(await readFile(RESULTS_PATH, "utf8")) as EvalRunResult;
}

export async function readBaseline(): Promise<EvalBaseline> {
  return JSON.parse(await readFile(BASELINE_PATH, "utf8")) as EvalBaseline;
}

export function printMetrics(result: EvalRunResult): void {
  const metrics = result.metrics;
  console.log(`casos: ${metrics.passedCases}/${metrics.totalCases}`);
  console.log(`pass@1: ${(metrics.passAt1 * 100).toFixed(1)}%`);
  console.log(`pass@5: ${(metrics.passAt5 * 100).toFixed(1)}%`);
  console.log(
    `precision de seleccion de tool: ${(metrics.toolSelectionPrecision * 100).toFixed(1)}%`,
  );
  console.log(`tasa de tools inventadas: ${(metrics.inventedToolRate * 100).toFixed(1)}%`);
  console.log(`false-action rate: ${(metrics.falseActionRate * 100).toFixed(1)}%`);
  console.log(`coste medio por run: ${metrics.averageCostCents.toFixed(2)} centimos`);
  console.log(`p95 de latencia: ${metrics.p95LatencyMs} ms`);
  console.log(
    `fault-handling rate: ${(metrics.faultHandlingRate * 100).toFixed(1)}%`,
  );
  console.log(`violaciones de invariante: ${metrics.invariantViolations}`);
  console.log(`red-team reportado: ${(metrics.redTeamReportRate * 100).toFixed(1)}%`);
  console.log(
    `red-team bloqueado: ${metrics.redTeamBlocked}/${metrics.redTeamTotal} (${(metrics.redTeamBlockedRate * 100).toFixed(1)}%)`,
  );

  const failures = result.cases.filter((evalCase) => !evalCase.passed);
  if (failures.length > 0) {
    console.log("\ncasos que fallan:");
    for (const failure of failures) {
      console.log(`- ${failure.caseId}: ${failure.title}`);
      for (const detail of failure.failures) {
        console.log(`    [${detail.level}] ${detail.code}: ${detail.detail}`);
      }
    }
  }
}
