import { AppError } from "@beacon/core/errors/app-error";
import type { AuditEntry, AuditLog } from "@beacon/core/ports/audit-log";
import type { ToolCallResult, ToolGateway } from "@beacon/core/ports/tool-gateway";

import { assertToolAllowed, resolveAllowedTools } from "./allowlist.js";
import { buildAuditEntry } from "./audit.js";
import { HttpMcpTransport } from "./http-transport.js";
import type { McpTransport } from "./transport.js";
import { parseToolArgs } from "./validate.js";

export interface CreateToolGatewayOptions {
  transport: McpTransport;
  /** `agents.allowed_tools` resuelto server-side para este run. */
  allowedTools: readonly string[];
  /** Audit append-only. Obligatorio: una tool call sin auditar no se ejecuta. */
  audit: AuditLog;
  /** `agent:<nombre>` de quien actúa. */
  actor: string;
  /** Aviso de fallos no fatales (por ejemplo, no se pudo auditar una denegación). */
  onError?: (error: unknown) => void;
}

/**
 * Gateway v0: allowlist + validación + audit + llamada.
 *
 * Es la única puerta del orquestador hacia `mcp-ops`. El orden de las comprobaciones es
 * el que cuenta: primero la allowlist, después el contrato de los argumentos, después
 * el audit de la decisión y solo entonces la llamada. Nada llega a `mcp-ops` sin haber
 * pasado por las tres primeras.
 *
 * **Fallar cerrado:** si no se puede escribir la entrada de audit, la llamada no se
 * ejecuta. Un gateway que deja pasar tool calls sin registrar es exactamente el agujero
 * que este proyecto quiere cerrar. La denegación, en cambio, se audita en segundo plano:
 * si esa escritura falla, la denegación sigue siendo denegación.
 */
export function createToolGateway(options: CreateToolGatewayOptions): ToolGateway {
  const allowed = new Set(resolveAllowedTools(options.allowedTools));
  const { audit, actor, onError } = options;

  const auditCall = async (
    action: "tool.call.allowed" | "tool.call.denied" | "tool.call.error" | "tool.call.result",
    tool: string,
    context: Parameters<ToolGateway["call"]>[2],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const entry: AuditEntry = buildAuditEntry({
      tenantId: context.tenantId,
      actor,
      action,
      tool,
      runId: context.runId,
      userId: context.userId,
      stepIdx: context.stepIdx,
      payload,
    });
    await audit.append(entry);
  };

  const auditBestEffort = async (
    action: "tool.call.denied" | "tool.call.error",
    tool: string,
    context: Parameters<ToolGateway["call"]>[2],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await auditCall(action, tool, context, payload);
    } catch (error) {
      onError?.(error);
    }
  };

  return {
    async call(tool, args, context): Promise<ToolCallResult> {
      try {
        assertToolAllowed(tool, allowed);
      } catch (error) {
        await auditBestEffort("tool.call.denied", tool, context, {
          reason: error instanceof AppError ? error.code : "unknown",
          args,
        });
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = parseToolArgs(tool, args);
      } catch (error) {
        await auditBestEffort("tool.call.denied", tool, context, {
          reason: error instanceof AppError ? error.code : "unknown",
          args,
        });
        throw error;
      }

      // La auditoría va antes de la llamada: si falla, la tool no se invoca.
      await auditCall("tool.call.allowed", tool, context, { args: parsed });

      const startedAt = performance.now();
      try {
        const result = await options.transport.callTool({ name: tool, args: parsed });
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

        await auditCall("tool.call.result", tool, context, {
          args: parsed,
          latency_ms: latencyMs,
        });

        return { result, latencyMs };
      } catch (error) {
        await auditBestEffort("tool.call.error", tool, context, {
          args: parsed,
          error_code: error instanceof AppError ? error.code : "unknown",
        });
        throw error;
      }
    },
  };
}

export interface CreateHttpToolGatewayOptions {
  /** URL del endpoint `POST /mcp` de mcp-ops. */
  url: string;
  /** Bearer de servicio; nunca es una credencial de usuario. */
  token: string;
  /** `agents.allowed_tools` resuelto server-side para este run. */
  allowedTools: readonly string[];
  /** Audit append-only; obligatorio para que el gateway pueda auditar. */
  audit: AuditLog;
  /** `agent:<nombre>` de quien actúa. */
  actor: string;
  /** Aviso de fallos no fatales. */
  onError?: (error: unknown) => void;
  timeoutMs?: number;
}

/**
 * Composition del gateway sobre el transporte HTTP. La API no necesita conocer
 * `HttpMcpTransport` ni cómo se presenta el bearer: solo pide un gateway para la
 * allowlist del agente.
 */
export function createHttpToolGateway(options: CreateHttpToolGatewayOptions): ToolGateway {
  return createToolGateway({
    transport: new HttpMcpTransport({
      url: options.url,
      token: options.token,
      timeoutMs: options.timeoutMs,
    }),
    allowedTools: options.allowedTools,
    audit: options.audit,
    actor: options.actor,
    onError: options.onError,
  });
}
