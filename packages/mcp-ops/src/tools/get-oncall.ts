import type { Pool } from "pg";

import { requireServiceId } from "./service-id.js";

export interface OncallRotation {
  service: string;
  rotation: string;
  primary: { name: string; handle: string };
  secondary: { name: string; handle: string };
  escalationMinutes: number[];
  policy: string;
}

interface OncallRow {
  rotation: string;
  primary_name: string;
  primary_handle: string;
  secondary_name: string;
  secondary_handle: string;
  escalation_minutes: number[];
  policy: string;
}

const GET_ONCALL_SQL = `
  select o.rotation,
         o.primary_name,
         o.primary_handle,
         o.secondary_name,
         o.secondary_handle,
         o.escalation_minutes,
         o.policy
  from oncall o
  where o.service_id = $1
`;

export async function getOncall(pool: Pool, slug: string): Promise<OncallRotation> {
  const serviceId = await requireServiceId(pool, slug);

  const { rows } = await pool.query<OncallRow>(GET_ONCALL_SQL, [serviceId]);
  const row = rows[0];

  if (!row) {
    throw new Error(`oncall not seeded for service ${slug}`);
  }

  return {
    service: slug,
    rotation: row.rotation,
    primary: { name: row.primary_name, handle: row.primary_handle },
    secondary: { name: row.secondary_name, handle: row.secondary_handle },
    escalationMinutes: row.escalation_minutes,
    policy: row.policy,
  };
}
