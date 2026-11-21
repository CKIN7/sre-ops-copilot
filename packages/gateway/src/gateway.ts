import { AppError } from "@beacon/core/errors/app-error";
import type { AuditEntry, AuditLog } from "@beacon/core/ports/audit-log";
import type { ProposalStore } from "@beacon/core/ports/proposal-store";
import type { RateLimiter } from "@beacon/core/ports/rate-limiter";
import type { ToolCallResult, ToolGateway } from "@beacon/core/ports/tool-gateway";
import { redactValue } from "@beacon/core/redaction/redact";
import {
  WRITE_TOOL_NAMES,
  actionPlanSchema,
  type WriteToolName,
} from "@beacon/core/schemas/writes";

import { assertToolAllowed, resolveAllowedTools } from "./allowlist.js";
import { buildAuditEntry } from "./audit.js";
import { HttpMcpTransport } from "./http-transport.js";
import type { McpTransport } from "./transport.js";
import { parseToolArgs } from "./validate.js";
import { createProposalWriter, type ProposalWriter } from "./write-policy.js";

export interface CreateToolGatewayOptions {
  transport: McpTransport;
  /** `agents.allowed_tools` resuelto server-side para este run. */
  allowedTools: readonly string[];
  /** Audit append-only. Obligatorio: una tool call sin auditar no se ejecuta. */
  audit: AuditLog;
  /** Rate limit con ventana deslizante. Obligatorio: sin él no hay techo. */
  rateLimiter: RateLimiter;
  /** `agent:<nombre>` de quien actúa. */
  actor: string;
  /**
   * Persistencia de propuestas. Obligatoria si la allowlist incluye tools de
   * escritura: sin ella no hay dónde dejar el plan que se va a aprobar.
   */
  proposals?: ProposalStore;
  /** Aviso de fallos no fatales (por ejemplo, no se pudo auditar una denegación). */
  onError?: (error: unknown) => void;
}

/** ¿Es una tool de escritura (fase 1) o de lectura? */
export function isWriteTool(tool: string): tool is WriteToolName {
  return (WRITE_TOOL_NAMES as readonly string[]).includes(tool);
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
 *
 * El rate limit va entre la validación y la llamada: una tool denegada por límite no
 * consume presupuesto ni llega a `mcp-ops`.
 *
 * Las tools de escritura (`propose_*`) no mutan nada: calculan un plan. El gateway es
 * quien lo persiste como propuesta y devuelve el `approval_id` con el que un humano
 * puede aprobarlo (ADR-004).
 */
export function createToolGateway(options: CreateToolGatewayOptions): ToolGateway {
  const allowed = new Set(resolveAllowedTools(options.allowedTools));
  const { audit, rateLimiter, actor, onError } = options;

  const needsProposals = [...allowed].some((tool) => isWriteTool(tool));
  if (needsProposals && !options.proposals) {
    throw new AppError(
      "internal",
      "the allowlist includes write tools but no proposal store was provided",
    );
  }

  const writer: ProposalWriter | null = options.proposals
    ? createProposalWriter({ proposals: options.proposals, audit, actor, onError })
    : null;

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

      // Rate limit antes de la auditoría y de la llamada: una llamada rechazada por
      // límite no consume presupuesto y no sale a la red.
      const decision = await rateLimiter.consume({
        tenantId: context.tenantId,
        runId: context.runId,
        tool,
      });

      if (!decision.allowed) {
        await auditBestEffort("tool.call.denied", tool, context, {
          reason: "rate_limited",
          scope: decision.scope,
          limit: decision.limit,
          observed: decision.observed,
        });
        throw new AppError(
          "rate_limited",
          `rate limit exceeded for ${decision.scope ?? "unknown"} scope`,
          {
            statusCode: 429,
            details: {
              scope: decision.scope,
              limit: decision.limit,
              observed: decision.observed,
              retryAfterMs: decision.retryAfterMs,
            },
          },
        );
      }

      // La auditoría va antes de la llamada: si falla, la tool no se invoca.
      await auditCall("tool.call.allowed", tool, context, { args: parsed });

      const startedAt = performance.now();
      try {
        const raw = await options.transport.callTool({ name: tool, args: parsed });
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

        // Defensa en profundidad: las tools ya redactan, pero el gateway no confía
        // en ese contrato. Lo que sale hacia el modelo y hacia el audit va redactado.
        const result = redactValue(raw);

        await auditCall("tool.call.result", tool, context, {
          args: parsed,
          latency_ms: latencyMs,
          result,
        });

        if (!isWriteTool(tool)) {
          return { result, latencyMs };
        }

        // Fase 1: el plan se persiste como propuesta y queda pendiente de un humano.
        if (!writer) {
          throw new AppError("internal", "no proposal store configured for write tools");
        }

        const plan = actionPlanSchema.safeParse(result);
        if (!plan.success) {
          throw new AppError("upstream_error", `${tool} returned an invalid action plan`, {
            statusCode: 502,
            details: plan.error.issues,
          });
        }

        const proposal = await writer.persist({
          context,
          tool,
          args: parsed,
          plan: plan.data,
        });

        return {
          result: {
            proposal_id: proposal.id,
            approval_id: proposal.approvalId,
            status: proposal.status,
            plan: plan.data,
          },
          latencyMs,
        };
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
  /** Rate limit con ventana deslizante; obligatorio para que haya techo. */
  rateLimiter: RateLimiter;
  /** `agent:<nombre>` de quien actúa. */
  actor: string;
  /** Persistencia de propuestas; obligatoria si hay tools de escritura en la allowlist. */
  proposals?: ProposalStore;
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
    rateLimiter: options.rateLimiter,
    actor: options.actor,
    proposals: options.proposals,
    onError: options.onError,
  });
}

export { createActionApplier } from "./apply-policy.js";
export type { ActionApplierOptions } from "./apply-policy.js";
export { createProposalWriter } from "./write-policy.js";
export type { ProposalWriter, ProposalWriterOptions } from "./write-policy.js";
