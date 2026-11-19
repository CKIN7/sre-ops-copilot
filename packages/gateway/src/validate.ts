import { AppError } from "@beacon/core/errors/app-error";
import { TOOL_INPUT_SCHEMAS, type ReadToolName } from "@beacon/core/schemas/tools";

/**
 * Valida los argumentos con el schema de la tool (fuente única en `core`).
 *
 * Devuelve el valor parseado —con defaults y coerción ya aplicados— para que lo
 * que se ejecuta y lo que se audita sean el mismo objeto. `parse`, no `validate`:
 * el gateway no reenvía al servidor MCP argumentos que no cumplen el contrato.
 */
export function parseToolArgs(tool: ReadToolName, args: unknown): unknown {
  const parsed = TOOL_INPUT_SCHEMAS[tool].safeParse(args);
  if (!parsed.success) {
    throw new AppError("invalid_input", `invalid arguments for ${tool}`, {
      statusCode: 400,
      details: parsed.error.issues,
    });
  }

  return parsed.data;
}