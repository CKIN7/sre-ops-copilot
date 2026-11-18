import type { Pool } from "pg";

import { requireServiceId } from "./service-id.js";

export interface FlagChange {
  changedAt: string;
  changedBy: string;
  fromValue: string;
  toValue: string;
  reason: string;
}

export interface FeatureFlag {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  updatedAt: string;
  updatedBy: string;
  recentChanges: FlagChange[];
}

interface FlagRow {
  key: string;
  description: string;
  enabled: boolean;
  rollout_percent: number;
  updated_at: Date;
  updated_by: string;
  recent_changes: Array<{
    changed_at: string;
    changed_by: string;
    from_value: string;
    to_value: string;
    reason: string;
  }>;
}

const GET_FLAGS_SQL = `
  select f.key,
         f.description,
         f.enabled,
         f.rollout_percent,
         f.updated_at,
         f.updated_by,
         coalesce(
           (
             select json_agg(change order by change.changed_at desc)
             from (
               select c.changed_at, c.changed_by, c.from_value, c.to_value, c.reason
               from feature_flag_changes c
               where c.flag_id = f.id
               order by c.changed_at desc
               limit 3
             ) change
           ),
           '[]'::json
         ) as recent_changes
  from feature_flags f
  where f.service_id = $1
  order by f.key
`;

export async function getFeatureFlags(
  pool: Pool,
  slug: string,
): Promise<{ service: string; flags: FeatureFlag[] }> {
  const serviceId = await requireServiceId(pool, slug);

  const { rows } = await pool.query<FlagRow>(GET_FLAGS_SQL, [serviceId]);

  return {
    service: slug,
    flags: rows.map((row) => ({
      key: row.key,
      description: row.description,
      enabled: row.enabled,
      rolloutPercent: row.rollout_percent,
      updatedAt: row.updated_at.toISOString(),
      updatedBy: row.updated_by,
      recentChanges: row.recent_changes.map((change) => ({
        changedAt: new Date(change.changed_at).toISOString(),
        changedBy: change.changed_by,
        fromValue: change.from_value,
        toValue: change.to_value,
        reason: change.reason,
      })),
    })),
  };
}
