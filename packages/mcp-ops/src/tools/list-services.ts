import type { Pool } from "pg";

export interface ServiceSummary {
  slug: string;
  displayName: string;
  role: string;
  tier: string;
  ownerTeam: string;
  dependsOn: string[];
}

interface ServiceRow {
  slug: string;
  display_name: string;
  role: string;
  tier: string;
  owner_team: string;
  depends_on: string[];
}

const LIST_SERVICES_SQL = `
  select s.slug,
         s.display_name,
         s.role,
         s.tier,
         s.owner_team,
         coalesce(
           array_agg(sd.depends_on_slug order by sd.depends_on_slug)
             filter (where sd.depends_on_slug is not null),
           '{}'
         ) as depends_on
  from services s
  left join service_deps sd on sd.service_id = s.id
  group by s.id
  order by s.slug
`;

export async function listServices(pool: Pool): Promise<ServiceSummary[]> {
  const { rows } = await pool.query<ServiceRow>(LIST_SERVICES_SQL);

  return rows.map((row) => ({
    slug: row.slug,
    displayName: row.display_name,
    role: row.role,
    tier: row.tier,
    ownerTeam: row.owner_team,
    dependsOn: row.depends_on,
  }));
}
