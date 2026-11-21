import { AppError } from "@beacon/core/errors/app-error";
import { ALL_TOOL_INPUT_SCHEMAS } from "@beacon/core/schemas/tools";
import { runTool } from "@beacon/mcp-ops/tools/registry";
import { Pool } from "pg";

import { goldenCases } from "../cases/golden-set.js";
import { redTeamFixtures } from "../cases/red-team.js";
import { resolveCapability, defaultCatalog } from "../harness/catalog.js";
import { writeFixture, type FixtureEntry, type FixtureFile } from "../fixtures/format.js";
import { buildGoldenFixtures } from "../fixtures/seed-fixtures.js";

/**
 * Grabador de fixtures (estilo VCR).
 *
 * - Golden set: con `DATABASE_URL`, ejecuta el guion de cada caso contra las tools
 *   reales de `mcp-ops` sobre la base sembrada y guarda la respuesta exacta. Sin
 *   `DATABASE_URL`, usa el generador determinista del seed en un instante fijo: es
 *   reproducible y no depende de que el seed sea reciente, pero no reproduce el SQL
 *   de agregacion al bit.
 * - Red-team: escribe fixtures autoradas. El seed solo tiene tres inyecciones en los
 *   logs de checkout; los otros vectores no se pueden grabar de una base que no los
 *   contiene, y decirlo es parte del trabajo.
 */
async function recordGolden(pool: Pool): Promise<number> {
  const catalog = defaultCatalog();
  let recorded = 0;

  for (const evalCase of goldenCases()) {
    const entries: FixtureEntry[] = [];

    for (const evalStep of evalCase.script) {
      const tool = resolveCapability(evalStep.capability, catalog);
      const args = ALL_TOOL_INPUT_SCHEMAS[tool].parse(evalStep.args);
      try {
        const result = await runTool(pool, tool, args);
        entries.push({ tool, args, result, error: null });
      } catch (error) {
        entries.push({
          tool,
          args,
          result: null,
          error: {
            code: error instanceof AppError ? error.code : "internal",
            message: error instanceof Error ? error.message : "error desconocido",
          },
        });
      }
    }

    const fixture: FixtureFile = {
      version: 1,
      caseId: evalCase.id,
      fixture: "golden",
      recordedAt: new Date().toISOString(),
      entries,
    };
    await writeFixture(fixture);
    recorded += 1;
    console.log(`grabada ${evalCase.id} (${entries.length} llamadas)`);
  }

  return recorded;
}

async function main(): Promise<void> {
  const redTeam = redTeamFixtures();
  for (const fixture of redTeam) {
    await writeFixture(fixture);
  }
  console.log(`red-team: ${redTeam.length} fixtures autoradas escritas`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    const fixtures = buildGoldenFixtures();
    for (const fixture of fixtures) {
      await writeFixture(fixture);
    }
    console.log(
      `golden: DATABASE_URL no esta definido; ${fixtures.length} fixtures generadas con el generador del seed en un instante fijo`,
    );
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const count = await recordGolden(pool);
    console.log(`golden: ${count} fixtures grabadas contra la base sembrada`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
