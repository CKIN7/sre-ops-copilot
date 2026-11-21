import type { ToolName } from "../schemas/tools.js";

/**
 * Contexto server-side de una tool call; nunca lo rellena el modelo.
 *
 * `runId` es `null` cuando la llamada no viene de un run: una propuesta puede
 * abrirla un operador desde la API. El tenant y el usuario siempre vienen del borde
 * autenticado.
 */
export interface ToolCallContext {
  tenantId: string;
  userId: string;
  agentId: string;
  runId: string | null;
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
  call(tool: ToolName, args: unknown, context: ToolCallContext): Promise<ToolCallResult>;
}
