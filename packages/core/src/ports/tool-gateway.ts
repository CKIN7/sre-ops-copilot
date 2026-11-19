import type { ReadToolName } from "../schemas/tools.js";

/** Contexto server-side de una tool call; nunca lo rellena el modelo. */
export interface ToolCallContext {
  tenantId: string;
  userId: string;
  agentId: string;
  runId: string;
  stepIdx: number;
}

export interface ToolCallResult {
  result: unknown;
  latencyMs: number;
}

/**
 * Única puerta de salida hacia `mcp-ops` (docs/plan.md §2 y §4). El orquestador
 * no conoce el transporte ni el SDK de MCP: solo este puerto.
 */
export interface ToolGateway {
  call(tool: ReadToolName, args: unknown, context: ToolCallContext): Promise<ToolCallResult>;
}
