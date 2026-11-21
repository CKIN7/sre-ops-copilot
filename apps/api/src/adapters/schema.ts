import type {
  RunStatus,
  RunTrigger,
  StepKind,
  ToolCallStatus,
} from "@beacon/core/domain/runs";
import type { RiskLevel, WriteKind } from "@beacon/core/domain/write-tools";
import type { AuditAction } from "@beacon/core/ports/audit-log";
import type { EffectStatus } from "@beacon/core/ports/effect-ledger";
import type { ProposalStatus } from "@beacon/core/ports/proposal-store";
import type { WriteToolName } from "@beacon/core/schemas/writes";
import {
  bigint,
  boolean,
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

/**
 * Espejo Drizzle de `infra/migrations/migrations/0005_rate_limit.sql`.
 *
 * Una fila por tool call aceptada; el límite se evalúa contando las filas de la
 * ventana deslizante.
 */
export const rateLimitEvents = pgTable("rate_limit_events", {
  id: bigint("id", { mode: "number" })
    .primaryKey()
    .generatedAlwaysAsIdentity(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
  tool: text("tool").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

/**
 * Espejo Drizzle de `infra/migrations/migrations/0006_write-proposals.sql`.
 *
 * `id` y `approval_id` los aporta la aplicación: el audit cita la propuesta antes de
 * que exista la fila, y la aprobación nace con ella.
 */
export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey(),
  approvalId: uuid("approval_id").notNull(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  kind: text("kind").$type<WriteKind>().notNull(),
  tool: text("tool").$type<WriteToolName>().notNull(),
  status: text("status").$type<ProposalStatus>().notNull(),
  risk: text("risk").$type<RiskLevel>().notNull(),
  target: text("target").notNull(),
  argsRedacted: jsonb("args_redacted").$type<unknown>().notNull(),
  diff: jsonb("diff").$type<unknown>().notNull(),
  blastRadius: jsonb("blast_radius").$type<unknown>().notNull(),
  evidence: jsonb("evidence").$type<string[]>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  decidedAt: timestamptz("decided_at"),
  appliedAt: timestamptz("applied_at"),
});

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey(),
  proposalId: uuid("proposal_id")
    .notNull()
    .references(() => proposals.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  approver: text("approver").notNull(),
  decision: text("decision").$type<"approved" | "rejected">().notNull(),
  reason: text("reason"),
  decidedAt: timestamptz("decided_at").notNull().defaultNow(),
});

/**
 * Espejo Drizzle de `infra/migrations/migrations/0007_action-effects.sql`.
 *
 * `idempotency_key` es única: es la restricción que hace que un rettento del apply
 * no vuelva a ejecutar la escritura.
 */
export const actionEffects = pgTable("action_effects", {
  id: uuid("id").primaryKey(),
  proposalId: uuid("proposal_id")
    .notNull()
    .references(() => proposals.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
  idempotencyKey: text("idempotency_key").notNull(),
  executor: text("executor").notNull(),
  effectId: text("effect_id").notNull(),
  status: text("status").$type<EffectStatus>().notNull(),
  verified: boolean("verified").notNull().default(false),
  observedState: jsonb("observed_state").$type<unknown>(),
  evidence: jsonb("evidence").$type<string[]>().notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  errorCode: text("error_code"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  appliedAt: timestamptz("applied_at"),
});

/**
 * Espejo Drizzle de la tabla `simulated_state`: el documento versionado que muta el
 * `SimulatedExecutor`. La versión es lo que permite el compare-and-swap y, con él,
 * el `409`.
 */
export const simulatedState = pgTable("simulated_state", {
  target: text("target").primaryKey(),
  state: jsonb("state").$type<unknown>().notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});