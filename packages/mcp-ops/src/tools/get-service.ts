import type { Pool } from "pg";

import { requireServiceId } from "./service-id.js";

export interface ServiceDetail {
  slug: string;
  displayName: string;
  role: string;
  tier: string;
  ownerTeam: string;
  slo: unknown;
  dependsOn: string[];
}

interface ServiceRow {
  slug: string;
  display_name: string;
  role: string;
  tier: string;
  owner_team: string;
  slo: unknown;
  depends_on: string[];
}

const GET_SERVICE_SQL = `
  select s.slug,
         s.display_name,
         s.role,
         s.tier,
         s.owner_team,
         s.slo,
         coalesce(
           array_agg(sd.depends_on_slug order by sd.depends_on_slug)
             filter (where sd.depends_on_slug is not null),
           '{}'
         ) as depends_on
  from services s
  left join service_deps sd on sd.service_id = s.id
  where s.slug = $1
  group by s.id
`;

export async function getService(pool: Pool, slug: string): Promise<ServiceDetail> {
  // Se resuelve primero para distinguir "no existe" de "sin dependencias".
  await requireServiceId(pool, slug);

  const { rows } = await pool.query<ServiceRow>(GET_SERVICE_SQL, [slug]);
  const row = rows[0];

  if (!row) {
    throw new Error(`service ${slug} disappeared between queries`);
  }

  return {
    slug: row.slug,
    displayName: row.display_name,
    role: row.role,
    tier: row.tier,
    ownerTeam: row.owner_team,
    slo: row.slo,
    dependsOn: row.depends_on,
  };
}
