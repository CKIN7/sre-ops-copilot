import { AppError } from "@beacon/core/errors/app-error";
import type { z } from "zod";

/**
 * Valida en el borde y lanza `invalid_input` (400) con los issues de Zod.
 * `parse` de Zod devolvería un `ZodError`; se traduce aquí para que el handler
 * central solo conozca `AppError`.
 */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("invalid_input", "invalid request", {
      statusCode: 400,
      details: parsed.error.issues,
    });
  }
  return parsed.data;
}