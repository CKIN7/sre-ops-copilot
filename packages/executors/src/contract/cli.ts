import { runSandboxContract } from "./sandbox-contract.js";

/**
 * Entrypoint de la suite de contrato (`pnpm contract:sandbox`).
 *
 * No se ejecuta en el gate de PR. Si no hay kubectl o cluster, sale con 1 y el error
 * exacto: nunca se publica 6/6 sin una medicion real.
 */
try {
  const report = await runSandboxContract();
  for (const item of report.cases) {
    const marker = item.passed ? "ok  " : "FAIL";
    const simulated = item.simulated ? " (simulado)" : "";
    console.log(`${marker} ${item.id}. ${item.name}${simulated}`);
    if (item.error) {
      console.log(`     ${item.error}`);
    }
  }
  console.log(`\ncontrato sandbox: ${report.passed}/${report.total} (${report.target})`);
  if (report.passed !== report.total) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `contrato sandbox bloqueado: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
