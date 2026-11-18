import { parseDurationSeconds } from "@beacon/core/domain/duration";
import type { GetTraceSummaryInput } from "@beacon/core/schemas/tools";
import type { Pool } from "pg";

import { requireServiceId } from "./service-id.js";

export interface DownstreamSummary {
  name: string;
  kind: string;
  /** p95 medido en el propio downstream; `null` si es un sistema externo sin métricas. */
  latencyP95Ms: number | null;
  /** 5xx del downstream en la ventana; `null` si es externo. */
  errorRate: number | null;
  /** Latencia que el servicio observa hacia su downstream más lento. */
  observedDownstreamMs: number | null;
  instrumented: boolean;
}

export interface TraceSummary {
  service: string;
  window: string;
  downstreams: DownstreamSummary[];
}

interface DownstreamRow {
  downstream: string;
  kind: string;
  latency_p95_ms: string | null;
  error_rate: string | null;
  observed_downstream_ms: string | null;
}

// No hay tabla de trazas en el modelo de datos (docs/plan.md §7). El resumen se
// deriva de `metrics_series`: latencia y 5xx propios de cada dependencia más la
// latencia que el servicio observa hacia su downstream más lento. Decisión en ADR-010.
const TRACE_SUMMARY_SQL = `
  select sd.depends_on_slug as downstream,
         sd.kind,
         (
           select avg(m.value)::text
           from metrics_series m
           join services d on d.id = m.service_id
           where d.slug = sd.depends_on_slug
             and m.metric = 'latency_p95'
             and m.ts >= now() - make_interval(secs => $2)
             and m.ts < now()
         ) as latency_p95_ms,
         (
           select avg(m.value)::text
           from metrics_series m
           join services d on d.id = m.service_id
           where d.slug = sd.depends_on_slug
             and m.metric = 'http_5xx_rate'
             and m.ts >= now() - make_interval(secs => $2)
             and m.ts < now()
         ) as error_rate,
         (
           select avg(m.value)::text
           from metrics_series m
           where m.service_id = $1
             and m.metric = 'latency_downstream'
             and m.ts >= now() - make_interval(secs => $2)
             and m.ts < now()
         ) as observed_downstream_ms
  from service_deps sd
  where sd.service_id = $1
  order by sd.depends_on_slug
`;

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export async function getTraceSummary(
  pool: Pool,
  input: GetTraceSummaryInput,
): Promise<TraceSummary> {
  const serviceId = await requireServiceId(pool, input.service);
  const windowSeconds = parseDurationSeconds(input.window);

  const { rows } = await pool.query<DownstreamRow>(TRACE_SUMMARY_SQL, [
    serviceId,
    windowSeconds,
  ]);

  return {
    service: input.service,
    window: input.window,
    downstreams: rows.map((row) => {
      const latencyP95Ms = toNumber(row.latency_p95_ms);
      const errorRate = toNumber(row.error_rate);

      return {
        name: row.downstream,
        kind: row.kind,
        latencyP95Ms,
        errorRate,
        observedDownstreamMs: toNumber(row.observed_downstream_ms),
        instrumented: latencyP95Ms !== null,
      };
    }),
  };
}
