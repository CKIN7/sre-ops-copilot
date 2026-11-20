import type {
  RunStatus,
  RunTrigger,
  StepKind,
  ToolCallStatus,
} from "@beacon/core/domain/runs";
import type { AuditAction } from "@beacon/core/ports/audit-log";
import {
  bigint,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Espejo Drizzle de `infra/migrations/migrations/0003_control-plane.sql`.
 * Las migraciones siguen siendo SQL versionado (ADR-009); este archivo solo
 * describe las columnas que la API lee y escribe. El dominio cruza fechas como
 * ISO 8601; el adaptador convierte `Date` ↔ ISO en un único lugar.
 */
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  allowedTools: text("allowed_tools").array().notNull(),
  budgetCents: integer("budget_cents").notNull().default(0),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id),
  status: text("status").$type<RunStatus>().notNull(),
  trigger: text("trigger").$type<RunTrigger>().notNull(),
  goal: text("goal").notNull(),
  startedAt: timestamptz("started_at"),
  endedAt: timestamptz("ended_at"),
  costCents: integer("cost_cents").notNull().default(0),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  errorCode: text("error_code"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const steps = pgTable("steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  idx: integer("idx").notNull(),
  kind: text("kind").$type<StepKind>().notNull(),
  model: text("model"),
  promptVersion: text("prompt_version"),
  latencyMs: integer("latency_ms").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  payloadRef: text("payload_ref"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const toolCalls = pgTable("tool_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  stepId: uuid("step_id")
    .notNull()
    .references(() => steps.id, { onDelete: "cascade" }),
  tool: text("tool").notNull(),
  argsRedacted: jsonb("args_redacted").$type<unknown>().notNull(),
  resultHash: text("result_hash"),
  status: text("status").$type<ToolCallStatus>().notNull(),
  errorCode: text("error_code"),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  finishedAt: timestamptz("finished_at"),
});

/**
 * Espejo Drizzle de `infra/migrations/migrations/0004_audit.sql`.
 *
 * Solo se guardan huellas: `payload_hash` del payload redactado, `prev_hash` de la
 * fila anterior y `hash` de la fila completa. El payload no existe en la tabla.
 */
export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" })
    .primaryKey()
    .generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  actor: text("actor").notNull(),
  action: text("action").$type<AuditAction>().notNull(),
  target: text("target").notNull(),
  payloadHash: text("payload_hash").notNull(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  createdAt: timestamptz("created_at").notNull(),
});