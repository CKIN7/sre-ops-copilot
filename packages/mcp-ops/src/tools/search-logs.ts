import { parseDurationSeconds } from "@beacon/core/domain/duration";
import { redactText, redactValue } from "@beacon/core/redaction/redact";
import type { SearchLogsInput } from "@beacon/core/schemas/tools";
import type { Pool } from "pg";

import { requireServiceId } from "./service-id.js";

export interface LogLine {
  timestamp: string;
  level: string;
  message: string;
  fields: unknown;
}

export interface SearchLogsResult {
  service: string;
  query: string;
  window: string;
  level: string | null;
  limit: number;
  returned: number;
  redactions: number;
  lines: LogLine[];
}

interface LogRow {
  ts: Date;
  level: string;
  message: string;
  fields: unknown;
}

// `position` en vez de LIKE: la query del modelo es texto libre y no debe poder
// inyectar comodines ni escapar del filtro.
const SEARCH_LOGS_SQL = `
  select l.ts, l.level, l.message, l.fields
  from logs l
  where l.service_id = $1
    and l.ts >= now() - make_interval(secs => $2)
    and l.ts < now()
    and ($3::text is null or l.level = $3)
    and position(lower($4) in lower(l.message)) > 0
  order by l.ts desc
  limit $5
`;

export async function searchLogs(
  pool: Pool,
  input: SearchLogsInput,
): Promise<SearchLogsResult> {
  const serviceId = await requireServiceId(pool, input.service);
  const windowSeconds = parseDurationSeconds(input.window);

  const { rows } = await pool.query<LogRow>(SEARCH_LOGS_SQL, [
    serviceId,
    windowSeconds,
    input.level ?? null,
    input.query,
    input.limit,
  ]);

  let redactions = 0;
  const lines = rows.map((row) => {
    const redactedMessage = redactText(row.message);
    redactions += redactedMessage.redactions;

    return {
      timestamp: row.ts.toISOString(),
      level: row.level,
      message: redactedMessage.text,
      fields: redactValue(row.fields),
    };
  });

  return {
    service: input.service,
    query: input.query,
    window: input.window,
    level: input.level ?? null,
    limit: input.limit,
    returned: lines.length,
    redactions,
    lines,
  };
}
