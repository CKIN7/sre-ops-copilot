import { createHash } from "node:crypto";

import type { RateLimitPolicy } from "@beacon/core/ports/rate-limiter";
import { parseFaults, type Fault } from "@beacon/executors/faults";
import { z } from "zod";

import type { PrincipalSelection } from "./application/principal-directory.js";

export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  DATABASE_URL: z.string().min(1),
  AUTH_TOKENS_JSON: z.string().min(2),
  MCP_URL: z.url(),
  MCP_AUTH_TOKEN: z.string().min(32),
  // Rate limit del gateway (docs/plan.md §4.4): ventana deslizante por run, tenant y tool.
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  RATE_LIMIT_RUN: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_TENANT: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_TOOL: z.coerce.number().int().min(1).default(120),
  // Ejecución de acciones (ADR-005). Solo `simulated`: el `sandbox` real llega con
  // M7 y su suite de contrato.
  EXECUTOR: z.enum(["simulated"]).default("simulated"),
  // Fallos inyectados del executor: `409,timeout,partial,rate_limited,readiness`.
  FAULTS: z.string().default(""),
});

/**
 * Un token de operador apunta a slugs/emails, nunca a UUIDs: la API resuelve el
 * principal contra la base en cada request. Así el seed puede recrear el control
 * plane sin invalidar los tokens.
 */
const principalSelectionSchema = z.object({
  tenant: z.string().trim().min(1),
  user: z.string().trim().toLowerCase().pipe(z.email()),
  agent: z.string().trim().min(1),
});

const authTokensSchema = z.record(z.string().min(32), principalSelectionSchema);

export interface ResolvedAuthToken {
  /** SHA-256 del token; el valor en claro no se guarda en memoria. */
  digest: Buffer;
  selection: PrincipalSelection;
}

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  mcpUrl: string;
  mcpAuthToken: string;
  tokens: readonly ResolvedAuthToken[];
  rateLimit: RateLimitPolicy;
  /** Nombre del executor de acciones. */
  executor: "simulated";
  /** Fallos inyectados: los que se prueban, no los que se esperan. */
  faults: Fault[];
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function parseAuthTokens(raw: string): ResolvedAuthToken[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("AUTH_TOKENS_JSON no es JSON válido");
  }

  const parsed = authTokensSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`AUTH_TOKENS_JSON inválido: ${formatIssues(parsed.error)}`);
  }

  const entries = Object.entries(parsed.data);
  if (entries.length === 0) {
    throw new Error("AUTH_TOKENS_JSON debe definir al menos un token");
  }

  return entries.map(([token, selection]) => ({
    digest: createHash("sha256").update(token).digest(),
    selection,
  }));
}

/**
 * Configuración de la API validada al arrancar (playbook/architecture.md §Configuración).
 * Un fallo aquí impide escuchar: es preferible no arrancar a arrancar a medias.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`configuración de la API inválida: ${formatIssues(parsed.error)}`);
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: parsed.data.DATABASE_URL,
    mcpUrl: parsed.data.MCP_URL,
    mcpAuthToken: parsed.data.MCP_AUTH_TOKEN,
    tokens: parseAuthTokens(parsed.data.AUTH_TOKENS_JSON),
    rateLimit: {
      run: parsed.data.RATE_LIMIT_RUN,
      tenant: parsed.data.RATE_LIMIT_TENANT,
      tool: parsed.data.RATE_LIMIT_TOOL,
      windowMs: parsed.data.RATE_LIMIT_WINDOW_MS,
    },
    executor: parsed.data.EXECUTOR,
    faults: parseFaults(parsed.data.FAULTS),
  };
}