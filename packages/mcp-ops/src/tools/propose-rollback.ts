import { AppError } from "@beacon/core/errors/app-error";
import type { ProposeRollbackInput } from "@beacon/core/schemas/writes";
import type { Pool } from "pg";

import { blastRadiusOf } from "./propose-plan.js";
import { requireServiceId } from "./service-id.js";

interface DeployRow {
  version: string;
  commit_sha: string;
  diff_summary: string;
  files_changed: number;
  rollout_status: string;
  deployed_at: Date;
}

interface RunbookRow {
  slug: string;
  title: string;
}

const CURRENT_DEPLOY_SQL = `
  select version, commit_sha, diff_summary, files_changed, rollout_status, deployed_at
  from deploys
  where service_id = $1
  order by deployed_at desc
  limit 1
`;

const TARGET_DEPLOY_SQL = `
  select version, commit_sha, diff_summary, files_changed, rollout_status, deployed_at
  from deploys
  where service_id = $1 and version = $2
  limit 1
`;

const ROLLBACK_RUNBOOKS_SQL = `
  select slug, title
  from runbooks
  where service_id = $1 and slug ilike '%rollback%'
  order by slug
  limit 3
`;

/**
 * Fase 1 de un rollback (ADR-004): calcula el plan y **no muta nada**.
 *
 * Devuelve el diff (de qué versión a cuál y qué cambió), el radio de impacto (a quién
 * alcanza) y la evidencia. El plan es lo que un humano aprueba; la escritura la
 * hace el ejecutor, más tarde y solo con esa aprobación.
 */
export async function proposeRollback(pool: Pool, input: ProposeRollbackInput) {
  const serviceId = await requireServiceId(pool, input.service);

  const { rows: currentRows } = await pool.query<DeployRow>(CURRENT_DEPLOY_SQL, [serviceId]);
  const current = currentRows[0];

  const { rows: targetRows } = await pool.query<DeployRow>(TARGET_DEPLOY_SQL, [
    serviceId,
    input.to_version,
  ]);
  const target = targetRows[0];

  if (!target) {
    throw new AppError(
      "not_found",
      `unknown version for ${input.service}: ${input.to_version}`,
      { statusCode: 404 },
    );
  }

  const { rows: runbookRows } = await pool.query<RunbookRow>(ROLLBACK_RUNBOOKS_SQL, [serviceId]);
  const blastRadius = await blastRadiusOf(pool, input.service);

  const evidence = [
    `despliegue actual ${current?.version ?? "desconocido"} (${current?.commit_sha ?? "?"}): ${
      current?.diff_summary ?? "sin resumen"
    }`,
    `version objetivo ${target.version} (${target.commit_sha}): ${target.diff_summary}`,
    `el ultimo rollout quedo en ${current?.rollout_status ?? "desconocido"}`,
  ];
  if (runbookRows.length > 0) {
    evidence.push(
      `runbook de rollback disponible: ${runbookRows.map((row) => row.slug).join(", ")}`,
    );
  }
  if (blastRadius.dependency_count > 0) {
    evidence.push(
      `el cambio alcanza a ${blastRadius.dependents.length} servicio(s) dependiente(s): ${blastRadius.dependents.join(", ")}`,
    );
  }

  return {
    kind: "rollback" as const,
    target: input.service,
    risk: "alto" as const,
    summary: `rollback de ${input.service} de ${current?.version ?? "?"} a ${input.to_version}`,
    diff: {
      kind: "rollback" as const,
      service: input.service,
      from_version: current?.version ?? "",
      to_version: target.version,
      rollout_percent: 100,
      commit_sha: target.commit_sha,
      files_changed: target.files_changed,
    },
    blast_radius: blastRadius,
    evidence,
  };
}
