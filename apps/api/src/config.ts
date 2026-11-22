import { createHash } from "node:crypto";

import type { BudgetUsage } from "@beacon/core/ports/budget";
import type { RateLimitPolicy } from "@beacon/core/ports/rate-limiter";
import { parseFaults, type Fault } from "@beacon/executors/faults";
import {
  EXECUTOR_NAMES,
  parseSandboxConfig,
  SANDBOX_TARGETS,
  type ExecutorName,
  type SandboxConfig,
} from "@beacon/executors/sandbox-config";
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

/** `0`/`1` explicito: `z.coerce.boolean` trataria la cadena "0" como `true`. */
const flag = z
  .enum(["0", "1"])
  .default("0")
  .transform((value) => value === "1");

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
  // Presupuesto (docs/plan.md §4.5). El coste por run lo pone `agents.budget_cents`;
  // estos valores son los techos de tokens/reloj y el agregado del tenant.
  BUDGET_RUN_TOKENS_IN: z.coerce.number().int().min(0).default(200_000),
  BUDGET_RUN_TOKENS_OUT: z.coerce.number().int().min(0).default(50_000),
  BUDGET_RUN_WALL_MS: z.coerce.number().int().min(0).default(90_000),
  BUDGET_TENANT_COST_CENTS: z.coerce.number().int().min(0).default(10_000),
  BUDGET_TENANT_TOKENS_IN: z.coerce.number().int().min(0).default(5_000_000),
  BUDGET_TENANT_TOKENS_OUT: z.coerce.number().int().min(0).default(1_000_000),
  BUDGET_TENANT_WALL_MS: z.coerce.number().int().min(0).default(3_600_000),
  BUDGET_RESERVATION_TTL_MS: z.coerce.number().int().min(1_000).default(300_000),
  // Ejecución de acciones (ADR-005 y ADR-015). `sandbox` solo cubre rollback.
  EXECUTOR: z.enum(EXECUTOR_NAMES).default("simulated"),
  SANDBOX_TARGET: z.enum(SANDBOX_TARGETS).default("kind"),
  SANDBOX_NAMESPACE: z.string().trim().min(1).default("beacon-sandbox"),
  SANDBOX_CONTEXT: z.string().trim().optional(),
  SANDBOX_KUBECONFIG: z.string().trim().optional(),
  SANDBOX_POLL_INTERVAL: z.string().trim().default("2s"),
  SANDBOX_COMMAND_TIMEOUT: z.string().trim().default("60s"),
  READINESS_TIMEOUT: z.string().trim().default("30s"),
  // Fallos inyectados del executor: `409,timeout,partial,rate_limited,readiness`.
  FAULTS: z.string().default(""),
  // Demo publica (plan §4.11). Se enforza en el gateway, nunca en la UI.
  DEMO_MODE: flag,
  REPLAY_ONLY: flag,
  DEMO_SESSION_BUDGET_CENTS: z.coerce.number().int().min(0).default(5),
  DEMO_SESSION_MAX_STEPS: z.coerce.number().int().min(1).default(6),
  DEMO_SESSION_TTL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  DEMO_DAILY_SESSIONS: z.coerce.number().int().min(1).default(200),
  DEMO_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  DEMO_RATE_LIMIT_IP: z.coerce.number().int().min(1).default(30),
  DEMO_RATE_LIMIT_SESSION: z.coerce.number().int().min(1).default(6),
  DEMO_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(3_600_000),
  DEMO_REPLAY_FIXTURES: z.string().trim().optional(),
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
  /** Overrides de presupuesto; el coste por run sale del agente. */
  budget: {
    overrides: {
      perRun?: Partial<BudgetUsage>;
      perTenant?: Partial<BudgetUsage>;
    };
    reservationTtlMs: number;
  };
  /** Nombre del executor de acciones. */
  executor: ExecutorName;
  /** Configuracion validada del sandbox (aunque el executor sea simulado). */
  sandbox: SandboxConfig;
  /** Fallos inyectados: los que se prueban, no los que se esperan. */
  faults: Fault[];
  /** Politica de la demo publica. */
  demo: {
    enabled: boolean;
    replayOnly: boolean;
    sessionBudgetCents: number;
    sessionMaxSteps: number;
    sessionTtlMs: number;
    dailySessions: number;
    failureThreshold: number;
    rateLimit: { ip: number; session: number; windowMs: number };
    replayFixtures: string | null;
  };
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

  const sandbox = parseSandboxConfig(env);
  const demo = {
    enabled: parsed.data.DEMO_MODE,
    replayOnly: parsed.data.REPLAY_ONLY,
    sessionBudgetCents: parsed.data.DEMO_SESSION_BUDGET_CENTS,
    sessionMaxSteps: parsed.data.DEMO_SESSION_MAX_STEPS,
    sessionTtlMs: parsed.data.DEMO_SESSION_TTL_MS,
    dailySessions: parsed.data.DEMO_DAILY_SESSIONS,
    failureThreshold: parsed.data.DEMO_FAILURE_THRESHOLD,
    rateLimit: {
      ip: parsed.data.DEMO_RATE_LIMIT_IP,
      session: parsed.data.DEMO_RATE_LIMIT_SESSION,
      windowMs: parsed.data.DEMO_RATE_LIMIT_WINDOW_MS,
    },
    replayFixtures: parsed.data.DEMO_REPLAY_FIXTURES ?? null,
  };

  // Falla cerrado: la demo publica solo puede escribir con el simulado, y
  // REPLAY_ONLY sin DEMO_MODE no tiene sentido.
  if (demo.enabled && parsed.data.EXECUTOR !== "simulated") {
    throw new Error("DEMO_MODE=1 exige EXECUTOR=simulated: la demo publica nunca escribe de verdad");
  }
  if (demo.replayOnly && !demo.enabled) {
    throw new Error("REPLAY_ONLY=1 exige DEMO_MODE=1");
  }
  if (demo.enabled && !demo.replayOnly && demo.replayFixtures === null) {
    throw new Error(
      "DEMO_MODE=1 exige DEMO_REPLAY_FIXTURES: sin fixtures el circuit breaker no puede caer a replay",
    );
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
      session: parsed.data.DEMO_RATE_LIMIT_SESSION,
      ip: parsed.data.DEMO_RATE_LIMIT_IP,
      // En la demo la ventana es la de la sesion; fuera de ella, la del gateway.
      windowMs: demo.enabled
        ? parsed.data.DEMO_RATE_LIMIT_WINDOW_MS
        : parsed.data.RATE_LIMIT_WINDOW_MS,
    },
    executor: parsed.data.EXECUTOR,
    sandbox,
    faults: parseFaults(parsed.data.FAULTS),
    demo,
    budget: {
      overrides: {
        perRun: {
          tokensIn: parsed.data.BUDGET_RUN_TOKENS_IN,
          tokensOut: parsed.data.BUDGET_RUN_TOKENS_OUT,
          wallMs: parsed.data.BUDGET_RUN_WALL_MS,
        },
        perTenant: {
          tokensIn: parsed.data.BUDGET_TENANT_TOKENS_IN,
          tokensOut: parsed.data.BUDGET_TENANT_TOKENS_OUT,
          costCents: parsed.data.BUDGET_TENANT_COST_CENTS,
          wallMs: parsed.data.BUDGET_TENANT_WALL_MS,
        },
      },
      reservationTtlMs: parsed.data.BUDGET_RESERVATION_TTL_MS,
    },
  };
}