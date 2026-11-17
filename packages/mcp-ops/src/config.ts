import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres connection string",
    ),
});

export interface Config {
  databaseUrl: string;
}

/** Config validada al arrancar: si falta algo crítico, el proceso no arranca a medias. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid configuration: ${detail}`);
  }

  return { databaseUrl: parsed.data.DATABASE_URL };
}
