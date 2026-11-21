import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Formato de fixture grabada (estilo VCR).
 *
 * Una fixture guarda la respuesta **exacta** que devolvio una tool para unos
 * argumentos concretos. El replay no toca Postgres: es determinista, barato y el
 * gate de CI no depende de que el seed sea reciente.
 *
 * Las fixtures se graban con `pnpm evals:record` contra la base sembrada y se
 * versionan. El modo live (`EVALS_MODE=live`) ignora las fixtures y llama a las
 * tools reales; sirve para re-grabar y para la comprobacion semanal.
 */
export interface FixtureEntry {
  tool: string;
  args: unknown;
  result: unknown;
  /** Si la tool fallo al grabar, se guarda el error para no fingir una respuesta. */
  error: { code: string; message: string } | null;
}

export interface FixtureFile {
  version: 1;
  caseId: string;
  fixture: "golden" | "red-team";
  /** ISO de la grabacion; informativo, no se usa para decidir. */
  recordedAt: string;
  entries: FixtureEntry[];
}

const FIXTURES_ROOT = new URL("../../fixtures/", import.meta.url);

export function fixturePath(
  fixture: "golden" | "red-team",
  caseId: string,
): string {
  return fileURLToPath(new URL(`${fixture}/${caseId}.json`, FIXTURES_ROOT));
}

export async function readFixture(
  fixture: "golden" | "red-team",
  caseId: string,
): Promise<FixtureFile> {
  const raw = await readFile(fixturePath(fixture, caseId), "utf8");
  const parsed = JSON.parse(raw) as FixtureFile;
  if (parsed.version !== 1 || parsed.caseId !== caseId) {
    throw new Error(`fixture invalida para ${caseId}`);
  }
  return parsed;
}

export async function writeFixture(file: FixtureFile): Promise<void> {
  const path = fixturePath(file.fixture, file.caseId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}
