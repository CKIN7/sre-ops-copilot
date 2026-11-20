import type { RunTimeline } from "@beacon/core/domain/runs";
import type { AuditChainVerification } from "@beacon/core/ports/audit-log";
import type { RunResult } from "@beacon/orchestrator/orchestrator";

export function formatRunResult(result: RunResult): string {
  const lines = [`run ${result.runId}: ${result.status} (${result.turns} turnos)`];

  if (result.answer) {
    lines.push(`hallazgo: ${result.answer.finding}`);
    lines.push("evidencia:");
    for (const item of result.answer.evidence) {
      lines.push(`  - ${item}`);
    }
    lines.push(`accion propuesta: ${result.answer.proposedAction ?? "ninguna"}`);
    lines.push(`confianza: ${result.answer.confidence}`);
    lines.push(`siguiente paso: ${result.answer.nextStep ?? "ninguno"}`);
  }

  if (result.errorCode) {
    lines.push(`error: ${result.errorCode}`);
  }

  return `${lines.join("\n")}\n`;
}

export function formatTimeline(timeline: RunTimeline): string {
  const { run } = timeline;
  const lines = [
    `timeline ${run.id}: ${run.status} (trigger=${run.trigger})`,
    `goal: ${run.goal}`,
  ];

  if (run.errorCode) {
    lines.push(`error: ${run.errorCode}`);
  }

  for (const step of timeline.steps) {
    const actor =
      step.kind === "model"
        ? `model ${step.model ?? "?"}@${step.promptVersion ?? "?"}`
        : "tool";
    lines.push(`[${step.idx}] ${actor} ${step.latencyMs} ms`);

    for (const call of step.toolCalls) {
      const error = call.errorCode ? ` error=${call.errorCode}` : "";
      lines.push(
        `    ${call.tool} ${call.status}${error} args=${JSON.stringify(call.argsRedacted)}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Veredicto de la cadena de audit. `ok: false` sale con código de salida 1: una
 * cadena rota es un fallo, no un aviso.
 */
export function formatAuditVerification(verification: AuditChainVerification): string {
  if (verification.ok) {
    return `audit: cadena intacta (${verification.entries} entradas verificadas)\n`;
  }

  return [
    `audit: CADENA ROTA en la entrada ${verification.brokenAt ?? "?"}`,
    `  motivo: ${verification.reason ?? "desconocido"}`,
    `  entradas revisadas: ${verification.entries}`,
    "",
  ].join("\n");
}