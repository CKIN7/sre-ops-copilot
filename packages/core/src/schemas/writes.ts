import { z } from "zod";

import { DURATION_PATTERN, parseDurationSeconds } from "../domain/duration.js";
import {
  ALERT_ID_PATTERN,
  FLAG_KEY_PATTERN,
  SERVICE_SLUG_PATTERN,
  VERSION_PATTERN,
} from "../domain/tool-args.js";
import {
  MAX_FLAG_VALUE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_SILENCE_SECONDS,
  RISK_LEVELS,
  WRITE_KINDS,
} from "../domain/write-tools.js";

/**
 * Contratos de las tools de escritura (docs/plan.md §3.4, ADR-004).
 *
 * Una tool `propose_*` **calcula** un plan: no muta nada y no persiste nada. El
 * gateway es quien guarda la propuesta y el quien la somete a aprobación. Por eso
 * estos schemas solo describen la intención: qué se quiere cambiar y por qué.
 *
 * El schema de `apply` no aparece aquí: `apply` no es una tool del modelo, es una
 * operación interna del gateway ([ADR-004](./../../docs/decisions/004-escrituras-dos-fases.md)).
 * Su contrato vive en `packages/gateway/src/apply-policy.ts`.
 */

const serviceSlugSchema = z
  .string()
  .regex(SERVICE_SLUG_PATTERN, "service must be a lowercase slug such as checkout");

const flagKeySchema = z
  .string()
  .regex(FLAG_KEY_PATTERN, "flag must be a flag key such as checkout.new-checkout");

const alertIdSchema = z
  .string()
  .regex(ALERT_ID_PATTERN, "alert_id must be the numeric id exposed by list_alerts");

const versionSchema = z
  .string()
  .regex(VERSION_PATTERN, "to_version must look like v2.3.3");

const durationSchema = z.string().regex(DURATION_PATTERN, "duration must look like 30m or 6h");

const reasonSchema = z.string().min(1).max(MAX_REASON_LENGTH);

/** El valor de una flag: booleano, número o texto corto. */
const flagValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string().max(MAX_FLAG_VALUE_LENGTH),
]);

export const proposeRollbackInputSchema = z.object({
  service: serviceSlugSchema,
  to_version: versionSchema,
  reason: reasonSchema,
});

export type ProposeRollbackInput = z.infer<typeof proposeRollbackInputSchema>;

export const proposeSetFlagInputSchema = z.object({
  flag: flagKeySchema,
  value: flagValueSchema,
  reason: reasonSchema,
});

export type ProposeSetFlagInput = z.infer<typeof proposeSetFlagInputSchema>;

export const proposeSilenceAlertInputSchema = z
  .object({
    alert_id: alertIdSchema,
    duration: durationSchema,
    reason: reasonSchema,
  })
  .superRefine((value, ctx) => {
    const seconds = parseDurationSeconds(value.duration);
    if (seconds > MAX_SILENCE_SECONDS) {
      ctx.addIssue({
        code: "custom",
        path: ["duration"],
        message: `duration must not exceed ${MAX_SILENCE_SECONDS}s`,
      });
    }
  });

export type ProposeSilenceAlertInput = z.infer<typeof proposeSilenceAlertInputSchema>;

export const WRITE_TOOL_INPUT_SCHEMAS = {
  propose_rollback: proposeRollbackInputSchema,
  propose_set_flag: proposeSetFlagInputSchema,
  propose_silence_alert: proposeSilenceAlertInputSchema,
} as const;

export const WRITE_TOOL_NAMES = Object.keys(WRITE_TOOL_INPUT_SCHEMAS) as WriteToolName[];

export type WriteToolName = keyof typeof WRITE_TOOL_INPUT_SCHEMAS;

/** Qué tool corresponde a qué tipo de escritura. */
export const WRITE_TOOL_KINDS: Record<WriteToolName, (typeof WRITE_KINDS)[number]> = {
  propose_rollback: "rollback",
  propose_set_flag: "set_flag",
  propose_silence_alert: "silence_alert",
};

/* -------------------------------------------------------------------------- */
/* El plan que devuelve una tool propose_*                                     */
/* -------------------------------------------------------------------------- */

export const rollbackDiffSchema = z.object({
  kind: z.literal("rollback"),
  service: z.string(),
  from_version: z.string(),
  to_version: z.string(),
  rollout_percent: z.number().int().min(0).max(100),
  commit_sha: z.string(),
  files_changed: z.number().int().min(0),
});

export type RollbackDiff = z.infer<typeof rollbackDiffSchema>;

export const setFlagDiffSchema = z.object({
  kind: z.literal("set_flag"),
  flag: z.string(),
  service: z.string(),
  from_value: z.string(),
  to_value: z.string(),
  rollout_percent: z.number().int().min(0).max(100),
});

export type SetFlagDiff = z.infer<typeof setFlagDiffSchema>;

export const silenceAlertDiffSchema = z.object({
  kind: z.literal("silence_alert"),
  alert_id: z.string(),
  alert_name: z.string(),
  service: z.string(),
  from_status: z.string(),
  to_status: z.string(),
  duration_seconds: z.number().int().min(1),
  silenced_until: z.string(),
});

export type SilenceAlertDiff = z.infer<typeof silenceAlertDiffSchema>;

export const actionDiffSchema = z.discriminatedUnion("kind", [
  rollbackDiffSchema,
  setFlagDiffSchema,
  silenceAlertDiffSchema,
]);

export type ActionDiff = z.infer<typeof actionDiffSchema>;

/**
 * Radio de impacto: a quién alcanza el cambio si sale bien o mal. Es lo que un
 * humano mira antes de aprobar, así que nombra los dependientes en vez de un
 * número suelto.
 */
export const blastRadiusSchema = z.object({
  service: z.string(),
  tier: z.string(),
  owner_team: z.string(),
  dependents: z.array(z.string()),
  dependency_count: z.number().int().min(0),
});

export type BlastRadius = z.infer<typeof blastRadiusSchema>;

/** El plan completo que una tool `propose_*` devuelve al gateway. */
export const actionPlanSchema = z.object({
  kind: z.enum(WRITE_KINDS),
  target: z.string(),
  risk: z.enum(RISK_LEVELS),
  summary: z.string(),
  diff: actionDiffSchema,
  blast_radius: blastRadiusSchema,
  evidence: z.array(z.string()),
});

export type ActionPlan = z.infer<typeof actionPlanSchema>;
