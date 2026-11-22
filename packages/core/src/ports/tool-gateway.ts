import type { BudgetUsage } from "./budget.js";
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
  /**
   * Id de la tool call que originó esta llamada, si la hay. El orquestador crea la
   * fila antes de llamar al gateway (write-ahead), así que una escritura puede
   * engancharse a su tool call y verse en la timeline del run.
   */
  toolCallId?: string | null;
  /**
   * Sesion anonima de la demo publica y su IP normalizada. Los pone el borde HTTP
   * desde la cookie; el modelo nunca los aporta. Fuera de `DEMO_MODE` van vacios.
   */
  demoSessionId?: string | null;
  demoIp?: string | null;
}

export interface ToolCallResult {
  result: unknown;
  latencyMs: number;
  /** Uso liquidado en el presupuesto; cero cuando no hay medidor real. */
  usage?: BudgetUsage;
}

/**
 * Única puerta de salida hacia `mcp-ops` (docs/plan.md §2 y §4). El orquestador
 * no conoce el transporte ni el SDK de MCP: solo este puerto.
 */
export interface ToolGateway {
  call(tool: ToolName, args: unknown, context: ToolCallContext): Promise<ToolCallResult>;
}
