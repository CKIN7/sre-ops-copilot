import type { McpServer } from "@modelcontextprotocol/server";
import {
  getDeploysInputSchema,
  getFeatureFlagsInputSchema,
  getOncallInputSchema,
  getServiceInputSchema,
  getTraceSummaryInputSchema,
  listAlertsInputSchema,
  listServicesInputSchema,
  queryMetricsInputSchema,
  searchLogsInputSchema,
  searchRunbooksInputSchema,
} from "@beacon/core/schemas/tools";
import {
  proposeRollbackInputSchema,
  proposeSetFlagInputSchema,
  proposeSilenceAlertInputSchema,
} from "@beacon/core/schemas/writes";
import type { Pool } from "pg";

import { getDeploys } from "./get-deploys.js";
import { getFeatureFlags } from "./get-feature-flags.js";
import { getOncall } from "./get-oncall.js";
import { getService } from "./get-service.js";
import { getTraceSummary } from "./get-trace-summary.js";
import { listAlerts } from "./list-alerts.js";
import { listServices } from "./list-services.js";
import { proposeRollback } from "./propose-rollback.js";
import { proposeSetFlag } from "./propose-set-flag.js";
import { proposeSilenceAlert } from "./propose-silence-alert.js";
import { queryMetrics } from "./query-metrics.js";
import { searchLogs } from "./search-logs.js";
import { searchRunbooks } from "./search-runbooks.js";
import { TOOL_DESCRIPTIONS, TOOL_TITLES } from "./registry.js";

function asText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function registerTools(server: McpServer, pool: Pool): void {
  server.registerTool(
    "list_services",
    {
      title: TOOL_TITLES.list_services,
      description: TOOL_DESCRIPTIONS.list_services,
      inputSchema: listServicesInputSchema,
    },
    async () => asText({ services: await listServices(pool) }),
  );

  server.registerTool(
    "get_service",
    {
      title: TOOL_TITLES.get_service,
      description: TOOL_DESCRIPTIONS.get_service,
      inputSchema: getServiceInputSchema,
    },
    async (input) => asText(await getService(pool, input.name)),
  );

  server.registerTool(
    "query_metrics",
    {
      title: TOOL_TITLES.query_metrics,
      description: TOOL_DESCRIPTIONS.query_metrics,
      inputSchema: queryMetricsInputSchema,
    },
    async (input) => asText(await queryMetrics(pool, input)),
  );

  server.registerTool(
    "search_logs",
    {
      title: TOOL_TITLES.search_logs,
      description: TOOL_DESCRIPTIONS.search_logs,
      inputSchema: searchLogsInputSchema,
    },
    async (input) => asText(await searchLogs(pool, input)),
  );

  server.registerTool(
    "get_deploys",
    {
      title: TOOL_TITLES.get_deploys,
      description: TOOL_DESCRIPTIONS.get_deploys,
      inputSchema: getDeploysInputSchema,
    },
    async (input) => asText(await getDeploys(pool, input)),
  );

  server.registerTool(
    "get_trace_summary",
    {
      title: TOOL_TITLES.get_trace_summary,
      description: TOOL_DESCRIPTIONS.get_trace_summary,
      inputSchema: getTraceSummaryInputSchema,
    },
    async (input) => asText(await getTraceSummary(pool, input)),
  );

  server.registerTool(
    "list_alerts",
    {
      title: TOOL_TITLES.list_alerts,
      description: TOOL_DESCRIPTIONS.list_alerts,
      inputSchema: listAlertsInputSchema,
    },
    async (input) => asText(await listAlerts(pool, input)),
  );

  server.registerTool(
    "get_feature_flags",
    {
      title: TOOL_TITLES.get_feature_flags,
      description: TOOL_DESCRIPTIONS.get_feature_flags,
      inputSchema: getFeatureFlagsInputSchema,
    },
    async (input) => asText(await getFeatureFlags(pool, input.service)),
  );

  server.registerTool(
    "get_oncall",
    {
      title: TOOL_TITLES.get_oncall,
      description: TOOL_DESCRIPTIONS.get_oncall,
      inputSchema: getOncallInputSchema,
    },
    async (input) => asText(await getOncall(pool, input.service)),
  );

  server.registerTool(
    "search_runbooks",
    {
      title: TOOL_TITLES.search_runbooks,
      description: TOOL_DESCRIPTIONS.search_runbooks,
      inputSchema: searchRunbooksInputSchema,
    },
    async (input) => asText(await searchRunbooks(pool, input.query)),
  );

  // --- Escrituras en dos fases (ADR-004) ---------------------------------------
  // Estas tools **no mutan nada**: calculan el plan de la escritura (diff, radio de
  // impacto y evidencia) y lo devuelven. Quien persiste la propuesta y pide la
  // aprobación humana es el gateway, no el servidor MCP.

  server.registerTool(
    "propose_rollback",
    {
      title: TOOL_TITLES.propose_rollback,
      description: TOOL_DESCRIPTIONS.propose_rollback,
      inputSchema: proposeRollbackInputSchema,
    },
    async (input) => asText(await proposeRollback(pool, input)),
  );

  server.registerTool(
    "propose_set_flag",
    {
      title: TOOL_TITLES.propose_set_flag,
      description: TOOL_DESCRIPTIONS.propose_set_flag,
      inputSchema: proposeSetFlagInputSchema,
    },
    async (input) => asText(await proposeSetFlag(pool, input)),
  );

  server.registerTool(
    "propose_silence_alert",
    {
      title: TOOL_TITLES.propose_silence_alert,
      description: TOOL_DESCRIPTIONS.propose_silence_alert,
      inputSchema: proposeSilenceAlertInputSchema,
    },
    async (input) => asText(await proposeSilenceAlert(pool, input)),
  );
}
