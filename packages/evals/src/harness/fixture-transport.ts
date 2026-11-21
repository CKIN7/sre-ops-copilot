import { stableStringify } from "@beacon/core/domain/json";

import type { McpToolRequest, McpTransport } from "@beacon/gateway/transport";
import type { FixtureEntry, FixtureFile } from "../fixtures/format.js";

function keyOf(tool: string, args: unknown): string {
  return `${tool}\u0000${stableStringify(args)}`;
}

/**
 * Transporte VCR: responde desde una fixture grabada.
 *
 * La clave es `(tool, args)` canonico, no la posicion en la lista. Si un caso cambia
 * de argumentos y la fixture no tiene esa llamada, falla: es mejor un fallo visible
 * que reutilizar la respuesta de otra ventana y fingir que el caso paso.
 */
export class FixtureMcpTransport implements McpTransport {
  readonly #entries: Map<string, FixtureEntry>;

  constructor(file: FixtureFile) {
    this.#entries = new Map(
      file.entries.map((entry) => [keyOf(entry.tool, entry.args), entry]),
    );
  }

  async callTool(request: McpToolRequest): Promise<unknown> {
    const entry = this.#entries.get(keyOf(request.name, request.args));
    if (!entry) {
      throw new Error(
        `fixture sin respuesta para ${request.name} con args ${stableStringify(request.args)}`,
      );
    }
    if (entry.error) {
      throw new Error(`${entry.error.code}: ${entry.error.message}`);
    }
    return entry.result;
  }
}
