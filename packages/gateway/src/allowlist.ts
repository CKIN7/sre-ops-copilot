import { AppError } from "@beacon/core/errors/app-error";
import { TOOL_INPUT_SCHEMAS, type ReadToolName } from "@beacon/core/schemas/tools";

/**
 * Normaliza la allowlist del agente. Un nombre desconocido es un error de
 * configuración server-side, no una tool que el modelo pueda intentar: revienta
 * al construir el gateway en vez de fallar en la primera llamada.
 */
export function resolveAllowedTools(configured: readonly string[]): ReadToolName[] {
  const unknown = configured.filter((name) => !(name in TOOL_INPUT_SCHEMAS));
  if (unknown.length > 0) {
    throw new AppError("internal", `unknown tools in allowlist: ${unknown.join(", ")}`);
  }

  return [...new Set(configured)] as ReadToolName[];
}

/** La allowlist es la primera puerta: si la tool no está, no se valida ni se llama. */
export function assertToolAllowed(tool: string, allowed: ReadonlySet<string>): void {
  if (!allowed.has(tool)) {
    throw new AppError("forbidden", `tool ${tool} is not allowed for this agent`, {
      statusCode: 403,
    });
  }
}