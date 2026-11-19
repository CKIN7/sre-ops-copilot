import type { ReadToolName } from "@beacon/core/schemas/tools";

export interface McpToolRequest {
  name: ReadToolName;
  args: unknown;
}

/**
 * Frontera de transporte con `mcp-ops`. El gateway solo ve esta interfaz: no
 * conoce JSON-RPC, headers ni el SDK de MCP.
 */
export interface McpTransport {
  callTool(request: McpToolRequest): Promise<unknown>;
}