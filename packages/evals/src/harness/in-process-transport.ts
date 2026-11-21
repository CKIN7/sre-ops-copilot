import { runTool } from "@beacon/mcp-ops/tools/registry";
import type { ToolName } from "@beacon/core/schemas/tools";
import type { McpToolRequest, McpTransport } from "@beacon/gateway/transport";
import type { Pool } from "pg";

/**
 * Transporte in-process: llama a los handlers reales de `mcp-ops` sin levantar el
 * servidor HTTP ni hablar JSON-RPC.
 *
 * Es el modo live de los evals. El gateway sigue siendo la unica puerta del
 * orquestador: este transporte solo sustituye la frontera de red por una llamada
 * de funcion con el mismo contrato de argumentos.
 */
export class InProcessMcpTransport implements McpTransport {
  constructor(private readonly pool: Pool) {}

  async callTool(request: McpToolRequest): Promise<unknown> {
    return runTool(this.pool, request.name as ToolName, request.args);
  }
}
