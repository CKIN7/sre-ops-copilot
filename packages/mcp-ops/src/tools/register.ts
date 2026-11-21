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

function asText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function registerTools(server: McpServer, pool: Pool): void {
  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "Lista el inventario de servicios con rol, tier, equipo y dependencias. Solo lectura.",
      inputSchema: listServicesInputSchema,
    },
    async () => asText({ services: await listServices(pool) }),
  );

  server.registerTool(
    "get_service",
    {
      title: "Get service",
      description:
        "Detalle de un servicio: owner, tier, SLO declarado y dependencias directas. Solo lectura.",
      inputSchema: getServiceInputSchema,
    },
    async (input) => asText(await getService(pool, input.name)),
  );

  server.registerTool(
    "query_metrics",
    {
      title: "Query metrics",
      description:
        "Serie temporal de una metrica de un servicio. Ventana maxima 24h, 300 puntos por respuesta, metricas del catalogo cerrado.",
      inputSchema: queryMetricsInputSchema,
    },
    async (input) => asText(await queryMetrics(pool, input)),
  );

  server.registerTool(
    "search_logs",
    {
      title: "Search logs",
      description:
        "Busca lineas de log de un servicio por texto, ventana maxima 24h y hasta 50 lineas. Devuelve el contenido ya redactado: emails, IPs y tokens sustituidos por marcas.",
      inputSchema: searchLogsInputSchema,
    },
    async (input) => asText(await searchLogs(pool, input)),
  );

  server.registerTool(
    "get_deploys",
    {
      title: "Get deploys",
      description:
        "Despliegues de un servicio en una ventana de hasta 30 dias, con commit, autor, diff resumido y estado del rollout. Solo lectura.",
      inputSchema: getDeploysInputSchema,
    },
    async (input) => asText(await getDeploys(pool, input)),
  );

  server.registerTool(
    "get_trace_summary",
    {
      title: "Get trace summary",
      description:
        "Latencia y errores por downstream de un servicio en una ventana de hasta 24h. Los sistemas externos sin metricas aparecen con instrumented=false.",
      inputSchema: getTraceSummaryInputSchema,
    },
    async (input) => asText(await getTraceSummary(pool, input)),
  );

  server.registerTool(
    "list_alerts",
    {
      title: "List alerts",
      description:
        "Alertas de una ventana de hasta 30 dias, filtrables por servicio y estado. Una alerta activa no prueba el sintoma: hay que contrastarla con metricas.",
      inputSchema: listAlertsInputSchema,
    },
    async (input) => asText(await listAlerts(pool, input)),
  );

  server.registerTool(
    "get_feature_flags",
    {
      title: "Get feature flags",
      description:
        "Feature flags de un servicio con porcentaje de rollout y los tres cambios mas recientes. Solo lectura.",
      inputSchema: getFeatureFlagsInputSchema,
    },
    async (input) => asText(await getFeatureFlags(pool, input.service)),
  );

  server.registerTool(
    "get_oncall",
    {
      title: "Get on-call",
      description:
        "Guardia de un servicio: primario, secundario y politica de escalado. Solo lectura.",
      inputSchema: getOncallInputSchema,
    },
    async (input) => asText(await getOncall(pool, input.service)),
  );

  server.registerTool(
    "search_runbooks",
    {
      title: "Search runbooks",
      description:
        "Busca en el texto de los runbooks operativos y devuelve hasta 5 coincidencias con su cuerpo en markdown.",
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
      title: "Propose rollback",
      description:
        "Calcula el plan de un rollback: de que version a cual, que cambio hay y a que servicios alcanza. No ejecuta nada: devuelve el plan para que un humano lo apruebe.",
      inputSchema: proposeRollbackInputSchema,
    },
    async (input) => asText(await proposeRollback(pool, input)),
  );

  server.registerTool(
    "propose_set_flag",
    {
      title: "Propose flag change",
      description:
        "Calcula el plan de un cambio de feature flag: valor actual, valor propuesto y rollout. No ejecuta nada: devuelve el plan para que un humano lo apruebe.",
      inputSchema: proposeSetFlagInputSchema,
    },
    async (input) => asText(await proposeSetFlag(pool, input)),
  );

  server.registerTool(
    "propose_silence_alert",
    {
      title: "Propose alert silence",
      description:
        "Calcula el plan de silenciar una alerta durante un tiempo. No ejecuta nada: devuelve el plan para que un humano lo apruebe.",
      inputSchema: proposeSilenceAlertInputSchema,
    },
    async (input) => asText(await proposeSilenceAlert(pool, input)),
  );
}
