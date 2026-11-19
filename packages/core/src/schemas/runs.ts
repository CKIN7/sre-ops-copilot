import { z } from "zod";

/** Entrada del caso de uso `POST /runs`; el tenant y el usuario no vienen de aquí. */
export const createRunInputSchema = z.object({
  goal: z.string().trim().min(1, "goal is required").max(2000, "goal is too long"),
});

export type CreateRunInput = z.infer<typeof createRunInputSchema>;

/** Salida final estructurada del orquestador (docs/plan.md §5). */
export const finalAnswerSchema = z.object({
  finding: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  proposedAction: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
  nextStep: z.string().min(1).nullable(),
});

export type FinalAnswer = z.infer<typeof finalAnswerSchema>;

export const runIdSchema = z.uuid();
