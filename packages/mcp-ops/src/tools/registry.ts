import {
  getDeploysInputSchema,
  getFeatureFlagsInputSchema,
  getOncallInputSchema,
  getServiceInputSchema,
  getTraceSummaryInputSchema,
  listAlertsInputSchema,
  queryMetricsInputSchema,
  searchLogsInputSchema,
  searchRunbooksInputSchema,
  type ToolName,
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

/**
 * Catalogo de las 13 tools de `mcp-ops`: titulo y descripcion con los que se
 * presentan al modelo. Es la **fuente unica** del catalogo, porque de el dependen
 * tres cosas que no pueden divergir:
 *
 * 1. El servidor MCP, que las publica.
 * 2. Los evals, que resuelven una capacidad a una tool leyendo la descripcion.
 * 3. El meta-eval, que muta una descripcion para comprobar que el harness detecta
 *    la degradacion (docs/plan.md §8.4).
 *
 * Una descripcion no es decoracion: es el contrato que permite al modelo elegir
 * la tool correcta. Si deja de decir que hace, la seleccion se degrada.
 */
export const TOOL_TITLES = {
  list_services: "List services",
  get_service: "Get service",
  query_metrics: "Query metrics",
  search_logs: "Search logs",
  get_deploys: "Get deploys",
  get_trace_summary: "Get trace summary",
  list_alerts: "List alerts",
  get_feature_flags: "Get feature flags",
  get_oncall: "Get on-call",
  search_runbooks: "Search runbooks",
  propose_rollback: "Propose rollback",
  propose_set_flag: "Propose flag change",
  propose_silence_alert: "Propose alert silence",
} as const satisfies Record<ToolName, string>;

export const TOOL_DESCRIPTIONS = {
  list_services:
    "Lista el inventario de servicios con rol, tier, equipo y dependencias. Solo lectura.",
  get_service:
    "Detalle de un servicio: owner, tier, SLO declarado y dependencias directas. Solo lectura.",
  query_metrics:
    "Serie temporal de una metrica de un servicio. Ventana maxima 24h, 300 puntos por respuesta, metricas del catalogo cerrado.",
  search_logs:
    "Busca lineas de log de un servicio por texto, ventana maxima 24h y hasta 50 lineas. Devuelve el contenido ya redactado: emails, IPs y tokens sustituidos por marcas.",
  get_deploys:
    "Despliegues de un servicio en una ventana de hasta 30 dias, con commit, autor, diff resumido y estado del rollout. Solo lectura.",
  get_trace_summary:
    "Latencia y errores por downstream de un servicio en una ventana de hasta 24h. Los sistemas externos sin metricas aparecen con instrumented=false.",
  list_alerts:
    "Alertas de una ventana de hasta 30 dias, filtrables por servicio y estado. Una alerta activa no prueba el sintoma: hay que contrastarla con metricas.",
  get_feature_flags:
    "Feature flags de un servicio con porcentaje de rollout y los tres cambios mas recientes. Solo lectura.",
  get_oncall:
    "Guardia de un servicio: primario, secundario y politica de escalado. Solo lectura.",
  search_runbooks:
    "Busca en el texto de los runbooks operativos y devuelve hasta 5 coincidencias con su cuerpo en markdown.",
  propose_rollback:
    "Calcula el plan de un rollback: de que version a cual, que cambio hay y a que servicios alcanza. No ejecuta nada: devuelve el plan para que un humano lo apruebe.",
  propose_set_flag:
    "Calcula el plan de un cambio de feature flag: valor actual, valor propuesto y rollout. No ejecuta nada: devuelve el plan para que un humano lo apruebe.",
  propose_silence_alert:
    "Calcula el plan de silenciar una alerta durante un tiempo. No ejecuta nada: devuelve el plan para que un humano lo apruebe.",
} as const satisfies Record<ToolName, string>;

/**
 * Ejecuta una tool con el mismo contrato que publica el servidor MCP: valida los
 * argumentos contra el schema de `core` y llama al handler real.
 *
 * Los evals lo usan para grabar fixtures contra la base sembrada y para el modo
 * live; no levanta HTTP ni conoce JSON-RPC. El gateway sigue siendo la unica
 * puerta del orquestador: este runner vive por debajo del transporte.
 */
export async function runTool(
  pool: Pool,
  name: ToolName,
  args: unknown,
): Promise<unknown> {
  switch (name) {
    case "list_services":
      return { services: await listServices(pool) };
    case "get_service":
      return getService(pool, getServiceInputSchema.parse(args).name);
    case "query_metrics":
      return queryMetrics(pool, queryMetricsInputSchema.parse(args));
    case "search_logs":
      return searchLogs(pool, searchLogsInputSchema.parse(args));
    case "get_deploys":
      return getDeploys(pool, getDeploysInputSchema.parse(args));
    case "get_trace_summary":
      return getTraceSummary(pool, getTraceSummaryInputSchema.parse(args));
    case "list_alerts":
      return listAlerts(pool, listAlertsInputSchema.parse(args));
    case "get_feature_flags":
      return getFeatureFlags(pool, getFeatureFlagsInputSchema.parse(args).service);
    case "get_oncall":
      return getOncall(pool, getOncallInputSchema.parse(args).service);
    case "search_runbooks":
      return searchRunbooks(pool, searchRunbooksInputSchema.parse(args).query);
    case "propose_rollback":
      return proposeRollback(pool, proposeRollbackInputSchema.parse(args));
    case "propose_set_flag":
      return proposeSetFlag(pool, proposeSetFlagInputSchema.parse(args));
    case "propose_silence_alert":
      return proposeSilenceAlert(pool, proposeSilenceAlertInputSchema.parse(args));
  }
}
