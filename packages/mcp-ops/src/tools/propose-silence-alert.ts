import { parseDurationSeconds } from "@beacon/core/domain/duration";
import { MEDIUM_RISK_SILENCE_SECONDS } from "@beacon/core/domain/write-tools";
import { AppError } from "@beacon/core/errors/app-error";
import type { ProposeSilenceAlertInput } from "@beacon/core/schemas/writes";
import type { Pool } from "pg";

import { blastRadiusOf } from "./propose-plan.js";

interface AlertRow {
  id: string;
  name: string;
  service_slug: string;
  severity: string;
  status: string;
  started_at: Date;
  summary: string;
}

const ALERT_SQL = `
  select a.id::text as id,
         a.name,
         s.slug as service_slug,
         a.severity,
         a.status,
         a.started_at,
         a.summary
  from alerts a
  join services s on s.id = a.service_id
  where a.id = $1
  limit 1
`;

/**
 * Fase 1 de un silenciado de alerta (ADR-004): calcula el plan y **no muta nada**.
 *
 * Silenciar una alerta tapa una señal: por eso el plan dice cuánto tiempo se tapa y
 * hasta cuándo. El riesgo sube a medio a partir de una hora (plan §3.4).
 *
 * La alerta se identifica por su `id`, que es lo que expone `list_alerts`: el nombre
 * se repite entre servicios y no identifica una sola fila.
 */
export async function proposeSilenceAlert(pool: Pool, input: ProposeSilenceAlertInput) {
  const { rows } = await pool.query<AlertRow>(ALERT_SQL, [input.alert_id]);
  const alert = rows[0];

  if (!alert) {
    throw new AppError("not_found", `unknown alert: ${input.alert_id}`, {
      statusCode: 404,
    });
  }

  const durationSeconds = parseDurationSeconds(input.duration);
  const silencedUntil = new Date(Date.now() + durationSeconds * 1000).toISOString();
  const blastRadius = await blastRadiusOf(pool, alert.service_slug);
  const risk = durationSeconds > MEDIUM_RISK_SILENCE_SECONDS ? "medio" : "bajo";

  const evidence = [
    `alerta ${alert.name} (${alert.severity}) en ${alert.service_slug}: ${alert.status} desde ${alert.started_at.toISOString()}`,
    `resumen: ${alert.summary}`,
    `silencio propuesto: ${durationSeconds}s, hasta ${silencedUntil}`,
  ];
  if (alert.status === "resolved") {
    evidence.push("la alerta ya esta resuelta: silenciarla no aporta nada");
  }
  if (durationSeconds > MEDIUM_RISK_SILENCE_SECONDS) {
    evidence.push("silencio largo: mientras dure, la senal no llega a nadie");
  }

  return {
    kind: "silence_alert" as const,
    target: alert.id,
    risk,
    summary: `silenciar ${alert.name} de ${alert.service_slug} durante ${input.duration}`,
    diff: {
      kind: "silence_alert" as const,
      alert_id: alert.id,
      alert_name: alert.name,
      service: alert.service_slug,
      from_status: alert.status,
      to_status: "silenced",
      duration_seconds: durationSeconds,
      silenced_until: silencedUntil,
    },
    blast_radius: blastRadius,
    evidence,
  };
}
