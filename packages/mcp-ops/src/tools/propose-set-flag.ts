import { AppError } from "@beacon/core/errors/app-error";
import type { ProposeSetFlagInput } from "@beacon/core/schemas/writes";
import type { Pool } from "pg";

import { blastRadiusOf } from "./propose-plan.js";

interface FlagRow {
  key: string;
  service_slug: string;
  enabled: boolean;
  rollout_percent: number;
  updated_at: Date;
  updated_by: string;
  description: string;
}

const FLAG_SQL = `
  select f.key,
         s.slug as service_slug,
         f.enabled,
         f.rollout_percent,
         f.updated_at,
         f.updated_by,
         f.description
  from feature_flags f
  join services s on s.id = f.service_id
  where f.key = $1
  limit 1
`;

const FLAG_CHANGES_SQL = `
  select c.changed_at, c.changed_by, c.from_value, c.to_value, c.reason
  from feature_flag_changes c
  join feature_flags f on f.id = c.flag_id
  where f.key = $1
  order by c.changed_at desc
  limit 3
`;

/**
 * Fase 1 de un cambio de flag (ADR-004): calcula el plan y **no muta nada**.
 *
 * Devuelve el valor de antes y el de después, el rollout actual y la evidencia (los
 * últimos cambios de la flag). Una flag con rollout parcial es un caso de riesgo
 * alto: cambiar el valor no cambia el efecto en producción hasta que el rollout
 * llega al 100 %.
 */
export async function proposeSetFlag(pool: Pool, input: ProposeSetFlagInput) {
  const { rows } = await pool.query<FlagRow>(FLAG_SQL, [input.flag]);
  const flag = rows[0];

  if (!flag) {
    throw new AppError("not_found", `unknown feature flag: ${input.flag}`, {
      statusCode: 404,
    });
  }

  const { rows: changes } = await pool.query<{
    changed_at: Date;
    changed_by: string;
    from_value: string;
    to_value: string;
    reason: string;
  }>(FLAG_CHANGES_SQL, [input.flag]);

  const blastRadius = await blastRadiusOf(pool, flag.service_slug);
  const toValue = String(input.value);

  const evidence = [
    `flag ${flag.key} de ${flag.service_slug}: enabled=${flag.enabled} rollout=${flag.rollout_percent}%`,
    `descripcion: ${flag.description}`,
    `ultimo cambio: ${flag.updated_by} (${flag.updated_at.toISOString()})`,
  ];
  for (const change of changes) {
    evidence.push(
      `cambio anterior ${change.changed_at.toISOString()}: ${change.from_value} -> ${change.to_value} (${change.reason})`,
    );
  }
  if (flag.rollout_percent < 100) {
    evidence.push(
      `el rollout esta en ${flag.rollout_percent}%: el cambio no afecta a todo el trafico`,
    );
  }

  return {
    kind: "set_flag" as const,
    target: flag.key,
    risk: "alto" as const,
    summary: `cambio de la flag ${flag.key} de ${String(flag.enabled)} a ${toValue}`,
    diff: {
      kind: "set_flag" as const,
      flag: flag.key,
      service: flag.service_slug,
      from_value: String(flag.enabled),
      to_value: toValue,
      rollout_percent: flag.rollout_percent,
    },
    blast_radius: blastRadius,
    evidence,
  };
}
