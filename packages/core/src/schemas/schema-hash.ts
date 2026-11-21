import { createHash } from "node:crypto";

import { z } from "zod";

import { stableStringify } from "../domain/json.js";
import { ALL_TOOL_INPUT_SCHEMAS, type ToolName } from "./tools.js";

/**
 * Huella estable del contrato de entrada de una tool.
 *
 * El JSON Schema se deriva del Zod que valida el gateway; el hash se calcula sobre
 * una serializacion canonica. Sirve para que un span o un log digan que version del
 * contrato se uso sin copiar el schema entero. Cambiar el schema cambia el hash.
 */
const HASHES = new Map<string, string>();

export function schemaHashFor(tool: ToolName | string): string {
  const cached = HASHES.get(tool);
  if (cached) {
    return cached;
  }

  const schema = (ALL_TOOL_INPUT_SCHEMAS as Record<string, z.ZodType>)[tool];
  if (!schema) {
    return "unknown";
  }

  const jsonSchema = z.toJSONSchema(schema, { io: "input" });
  const hash = createHash("sha256")
    .update(stableStringify(jsonSchema), "utf8")
    .digest("hex")
    .slice(0, 16);
  HASHES.set(tool, hash);
  return hash;
}
