import type { McpServer } from "@modelcontextprotocol/server";
import {
  listServicesInputSchema,
  queryMetricsInputSchema,
} from "@beacon/core/schemas/tools";
import type { Pool } from "pg";

import { listServices } from "./list-services.js";
import { queryMetrics } from "./query-metrics.js";

export function registerTools(server: McpServer, pool: Pool): void {
  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "Lista el inventario de servicios con rol, tier, equipo y dependencias. Solo lectura.",
      inputSchema: listServicesInputSchema,
    },
    async () => {
      const services = await listServices(pool);
      return {
        content: [{ type: "text", text: JSON.stringify({ services }) }],
      };
    },
  );

  server.registerTool(
    "query_metrics",
    {
      title: "Query metrics",
      description:
        "Serie temporal de una metrica de un servicio. Ventana maxima 24h, 300 puntos por respuesta, metricas del catalogo cerrado.",
      inputSchema: queryMetricsInputSchema,
    },
    async (input) => {
      const result = await queryMetrics(pool, input);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}
