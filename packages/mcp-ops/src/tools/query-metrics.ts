import { AppError } from "@beacon/core/errors/app-error";
import { parseDurationSeconds } from "@beacon/core/domain/duration";
import type { QueryMetricsInput } from "@beacon/core/schemas/tools";
import type { Pool } from "pg";

export interface MetricPoint {
  timestamp: string;
  value: number;
}

export interface MetricsResult {
  service: string;
  metric: string;
  window: string;
  step: string;
  agg: string;
  bucketCount: number;
  points: MetricPoint[];
}

// El nombre de la función de agregación no puede ir como parámetro: el enum validado
// se mapea contra esta allowlist cerrada, nunca se interpola input.
const AGGREGATE_SQL = {
  avg: "avg(value)",
  min: "min(value)",
  max: "max(value)",
  sum: "sum(value)",
} as const;

interface ServiceIdRow {
  id: string;
}

interface MetricRow {
  bucket: Date;
  value: number;
}

export async function queryMetrics(
  pool: Pool,
  input: QueryMetricsInput,
): Promise<MetricsResult> {
  const { rows: services } = await pool.query<ServiceIdRow>(
    "select id from services where slug = $1",
    [input.service],
  );
  const service = services[0];

  if (!service) {
    throw new AppError("not_found", `unknown service: ${input.service}`, {
      statusCode: 404,
    });
  }

  const windowSeconds = parseDurationSeconds(input.window);
  const stepSeconds = parseDurationSeconds(input.step);
  const aggregateSql = AGGREGATE_SQL[input.agg];

  const { rows } = await pool.query<MetricRow>(
    `
      select date_bin(make_interval(secs => $2), ts, now() - make_interval(secs => $4)) as bucket,
             ${aggregateSql}::float8 as value
      from metrics_series
      where service_id = $1
        and metric = $3
        and ts >= now() - make_interval(secs => $4)
        and ts < now()
      group by bucket
      order by bucket
    `,
    [service.id, stepSeconds, input.metric, windowSeconds],
  );

  return {
    service: input.service,
    metric: input.metric,
    window: input.window,
    step: input.step,
    agg: input.agg,
    bucketCount: rows.length,
    points: rows.map((row) => ({
      timestamp: row.bucket.toISOString(),
      value: row.value,
    })),
  };
}
