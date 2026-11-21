import type { Pool } from "pg";

/**
 * Radio de impacto de un cambio (docs/plan.md §3.4).
 *
 * Lo que un humano necesita ver antes de aprobar: qué servicio se toca, de qué
 * tier es, quién lo lleva y **a quién alcanza** si el cambio sale mal. Los
 * dependientes se leen de `service_deps`: los servicios que dependen de este.
 */
export interface BlastRadiusInfo {
  service: string;
  tier: string;
  owner_team: string;
  dependents: string[];
  dependency_count: number;
}

interface ServiceRow {
  tier: string;
  owner_team: string;
}

interface DependentRow {
  slug: string;
}

export async function blastRadiusOf(pool: Pool, slug: string): Promise<BlastRadiusInfo> {
  const { rows: serviceRows } = await pool.query<ServiceRow>(
    "select tier, owner_team from services where slug = $1",
    [slug],
  );
  const service = serviceRows[0];

  const { rows: dependentRows } = await pool.query<DependentRow>(
    `select s.slug
     from service_deps d
     join services s on s.id = d.service_id
     where d.depends_on_slug = $1
     order by s.slug`,
    [slug],
  );

  return {
    service: slug,
    tier: service?.tier ?? "unknown",
    owner_team: service?.owner_team ?? "unknown",
    dependents: dependentRows.map((row) => row.slug),
    dependency_count: dependentRows.length,
  };
}
