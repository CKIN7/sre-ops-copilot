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

const httpConfigSchema = configSchema.extend({
  // Token de servicio que presenta el gateway. No es la identidad del usuario:
  // esa la resuelve el gateway y viaja en la capa HTTP (ADR-002).
  MCP_AUTH_TOKEN: z
    .string()
    .min(32, "MCP_AUTH_TOKEN must be at least 32 characters")
    .refine(
      (value) => !/^change[-_ ]?me/i.test(value),
      "MCP_AUTH_TOKEN must not be a placeholder",
    ),
  MCP_HOST: z.string().min(1).default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});

export interface HttpConfig extends Config {
  authToken: string;
  host: string;
  port: number;
}

/** Config del transporte HTTP. El token es obligatorio: no hay modo abierto. */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const parsed = httpConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid configuration: ${detail}`);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    authToken: parsed.data.MCP_AUTH_TOKEN,
    host: parsed.data.MCP_HOST,
    port: parsed.data.MCP_PORT,
  };
}
