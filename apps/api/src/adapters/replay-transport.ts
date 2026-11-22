import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { stableStringify } from "@beacon/core/domain/json";
import type { McpToolRequest, McpTransport } from "@beacon/gateway/transport";

interface FixtureEntry {
  tool: string;
  args: unknown;
  result: unknown;
}

interface FixtureFile {
  entries?: FixtureEntry[];
}

function keyOf(tool: string, args: unknown): string {
  return `${tool}\u0000${stableStringify(args)}`;
}

/**
 * Transporte de replay para `REPLAY_ONLY` (plan §12, capa 3).
 *
 * Sirve respuestas desde fixtures grabadas: no llama a `mcp-ops` ni sale a la red.
 * La clave es `(tool, args)` canonico; si la fixture no tiene esa llamada, falla en
 * vez de inventar una respuesta. El fallback del circuit breaker se nota, y se dice.
 */
export class ReplayTransport implements McpTransport {
  readonly #entries: Map<string, FixtureEntry>;

  constructor(entries: readonly FixtureEntry[]) {
    this.#entries = new Map(entries.map((entry) => [keyOf(entry.tool, entry.args), entry]));
  }

  async callTool(request: McpToolRequest): Promise<unknown> {
    const entry = this.#entries.get(keyOf(request.name, request.args));
    if (!entry) {
      throw new Error(
        `REPLAY_ONLY sin fixture para ${request.name} con args ${stableStringify(request.args)}`,
      );
    }
    return entry.result;
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Carga un archivo o un directorio de fixtures (formato `packages/evals`). */
function resolvePath(path: string): string {
  if (isAbsolute(path)) {
    return path;
  }
  // El `.env` vive en la raiz, pero la API corre con cwd `apps/api`: se prueban los
  // padres para que una ruta relativa a la raiz funcione sin hardcodear el repo.
  let base = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(base, path);
    if (existsSync(candidate)) {
      return candidate;
    }
    base = resolve(base, "..");
  }
  return resolve(path);
}

export function loadReplayTransport(rawPath: string): ReplayTransport {
  const path = resolvePath(rawPath);
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(path, name))
    : [path];

  const entries: FixtureEntry[] = [];
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as FixtureFile;
    for (const entry of parsed.entries ?? []) {
      if (typeof entry.tool === "string") {
        entries.push(entry);
      }
    }
  }

  return new ReplayTransport(entries);
}
