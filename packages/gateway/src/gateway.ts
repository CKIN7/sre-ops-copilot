import type { ToolCallResult, ToolGateway } from "@beacon/core/ports/tool-gateway";

import { assertToolAllowed, resolveAllowedTools } from "./allowlist.js";
import type { McpTransport } from "./transport.js";
import { parseToolArgs } from "./validate.js";

export interface CreateToolGatewayOptions {
  transport: McpTransport;
  /** `agents.allowed_tools` resuelto server-side para este run. */
  allowedTools: readonly string[];
}

/**
 * Gateway v0: allowlist + validación + llamada. Es la única puerta del
 * orquestador hacia `mcp-ops`, aunque las políticas completas (rate limit, audit,
 * presupuesto, aprobación) lleguen en M3/M4/M6.
 */
export function createToolGateway(options: CreateToolGatewayOptions): ToolGateway {
  const allowed = new Set(resolveAllowedTools(options.allowedTools));

  return {
    async call(tool, args, _context): Promise<ToolCallResult> {
      assertToolAllowed(tool, allowed);
      const parsed = parseToolArgs(tool, args);

      const startedAt = performance.now();
      const result = await options.transport.callTool({ name: tool, args: parsed });

      return {
        result,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    },
  };
}