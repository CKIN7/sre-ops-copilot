import { MAX_RUNBOOK_RESULTS } from "@beacon/core/domain/read-tools";
import type { Pool } from "pg";

export interface RunbookHit {
  service: string;
  slug: string;
  title: string;
  bodyMd: string;
  updatedAt: string;
}

interface RunbookRow {
  service: string;
  slug: string;
  title: string;
  body_md: string;
  updated_at: Date;
}

const SEARCH_RUNBOOKS_SQL = `
  select coalesce(s.slug, 'global') as service,
         r.slug,
         r.title,
         left(r.body_md, 2000) as body_md,
         r.updated_at
  from runbooks r
  left join services s on s.id = r.service_id
  where position(lower($1) in lower(r.title || ' ' || r.body_md)) > 0
  order by r.updated_at desc
  limit $2
`;

export async function searchRunbooks(
  pool: Pool,
  query: string,
): Promise<{ query: string; returned: number; runbooks: RunbookHit[] }> {
  const { rows } = await pool.query<RunbookRow>(SEARCH_RUNBOOKS_SQL, [
    query,
    MAX_RUNBOOK_RESULTS,
  ]);

  return {
    query,
    returned: rows.length,
    runbooks: rows.map((row) => ({
      service: row.service,
      slug: row.slug,
      title: row.title,
      bodyMd: row.body_md,
      updatedAt: row.updated_at.toISOString(),
    })),
  };
}
