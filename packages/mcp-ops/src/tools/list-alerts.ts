import { parseDurationSeconds } from "@beacon/core/domain/duration";
import type { ListAlertsInput } from "@beacon/core/schemas/tools";
import type { Pool } from "pg";

export interface AlertSummary {
  /** Id de la alerta: es lo que usa `propose_silence_alert` para referirse a ella. */
  id: string;
  name: string;
  service: string;
  severity: string;
  status: string;
  startedAt: string;
  resolvedAt: string | null;
  summary: string;
}

interface AlertRow {
  id: string;
  name: string;
  slug: string;
  severity: string;
  status: string;
  started_at: Date;
  resolved_at: Date | null;
  summary: string;
}

const LIST_ALERTS_SQL = `
  select a.id::text as id,
         a.name,
         s.slug,
         a.severity,
         a.status,
         a.started_at,
         a.resolved_at,
         a.summary
  from alerts a
  join services s on s.id = a.service_id
  where a.started_at >= now() - make_interval(secs => $1)
    and a.started_at < now()
    and ($2::text is null or s.slug = $2)
    and ($3::text is null or a.status = $3)
  order by a.started_at desc
`;

export async function listAlerts(
  pool: Pool,
  input: ListAlertsInput,
): Promise<{ window: string; service: string | null; status: string | null; alerts: AlertSummary[] }> {
  const windowSeconds = parseDurationSeconds(input.window);

  const { rows } = await pool.query<AlertRow>(LIST_ALERTS_SQL, [
    windowSeconds,
    input.service ?? null,
    input.status ?? null,
  ]);

  return {
    window: input.window,
    service: input.service ?? null,
    status: input.status ?? null,
    alerts: rows.map((row) => ({
      id: row.id,
      name: row.name,
      service: row.slug,
      severity: row.severity,
      status: row.status,
      startedAt: row.started_at.toISOString(),
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      summary: row.summary,
    })),
  };
}
