import type {
  Run,
  RunStep,
  RunTimeline,
  TimelineStep,
  ToolCall,
} from "@beacon/core/domain/runs";
import { AppError } from "@beacon/core/errors/app-error";
import type {
  ListRunsOptions,
  AppendStepInput,
  AppendToolCallInput,
  CompleteToolCallInput,
  CreateRunRecordInput,
  FinishRunRecordInput,
  RunStore,
} from "@beacon/core/ports/run-store";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import type { Database } from "./db.js";
import { runs, steps, toolCalls } from "./schema.js";

function toIso(value: Date): string;
function toIso(value: Date | null): string | null;
function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toRun(row: typeof runs.$inferSelect): Run {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    status: row.status,
    trigger: row.trigger,
    goal: row.goal,
    startedAt: toIso(row.startedAt),
    endedAt: toIso(row.endedAt),
    costCents: row.costCents,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    errorCode: row.errorCode,
    createdAt: toIso(row.createdAt),
  };
}

function toStep(row: typeof steps.$inferSelect): RunStep {
  return {
    id: row.id,
    runId: row.runId,
    idx: row.idx,
    kind: row.kind,
    model: row.model,
    promptVersion: row.promptVersion,
    latencyMs: row.latencyMs,
    costCents: row.costCents,
    payloadRef: row.payloadRef,
    createdAt: toIso(row.createdAt),
  };
}

function toToolCall(row: typeof toolCalls.$inferSelect): ToolCall {
  return {
    id: row.id,
    stepId: row.stepId,
    tool: row.tool,
    argsRedacted: row.argsRedacted,
    resultHash: row.resultHash,
    status: row.status,
    errorCode: row.errorCode,
    idempotencyKey: row.idempotencyKey,
    createdAt: toIso(row.createdAt),
    finishedAt: toIso(row.finishedAt),
  };
}

/**
 * Implementación Drizzle del puerto `RunStore` (docs/plan.md §5).
 *
 * Toda lectura del timeline filtra por `tenant_id`: un run de otro tenant se
 * comporta como inexistente. Los inserts devuelven la fila completa para que el
 * orquestador tenga el id antes de ejecutar la tool (write-ahead).
 */
export class DrizzleRunStore implements RunStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async createRun(input: CreateRunRecordInput): Promise<Run> {
    const [row] = await this.#db
      .insert(runs)
      .values({
        tenantId: input.tenantId,
        agentId: input.agentId,
        status: "queued",
        trigger: input.trigger,
        goal: input.goal,
      })
      .returning();

    if (!row) {
      throw new AppError("internal", "insert run returned no row");
    }
    return toRun(row);
  }

  async markRunRunning(runId: string, startedAt: string): Promise<void> {
    await this.#db
      .update(runs)
      .set({ status: "running", startedAt: new Date(startedAt) })
      .where(eq(runs.id, runId));
  }

  async finishRun(runId: string, input: FinishRunRecordInput): Promise<void> {
    await this.#db
      .update(runs)
      .set({
        status: input.status,
        endedAt: new Date(input.endedAt),
        errorCode: input.errorCode,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        costCents: input.costCents,
      })
      .where(eq(runs.id, runId));
  }

  async appendStep(input: AppendStepInput): Promise<RunStep> {
    const [row] = await this.#db
      .insert(steps)
      .values({
        runId: input.runId,
        idx: input.idx,
        kind: input.kind,
        model: input.model,
        promptVersion: input.promptVersion,
        latencyMs: input.latencyMs,
        costCents: input.costCents,
        payloadRef: input.payloadRef,
      })
      .returning();

    if (!row) {
      throw new AppError("internal", "insert step returned no row");
    }
    return toStep(row);
  }

  async appendToolCall(input: AppendToolCallInput): Promise<ToolCall> {
    const [row] = await this.#db
      .insert(toolCalls)
      .values({
        stepId: input.stepId,
        tool: input.tool,
        argsRedacted: input.argsRedacted,
        status: input.status,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();

    if (!row) {
      throw new AppError("internal", "insert tool call returned no row");
    }
    return toToolCall(row);
  }

  async completeToolCall(input: CompleteToolCallInput): Promise<void> {
    await this.#db
      .update(toolCalls)
      .set({
        status: input.status,
        resultHash: input.resultHash,
        errorCode: input.errorCode,
        finishedAt: new Date(input.finishedAt),
      })
      .where(eq(toolCalls.id, input.toolCallId));
  }

  async getTimeline(runId: string, tenantId: string): Promise<RunTimeline | null> {
    const [runRow] = await this.#db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.tenantId, tenantId)))
      .limit(1);

    if (!runRow) {
      return null;
    }

    const stepRows = await this.#db
      .select()
      .from(steps)
      .where(eq(steps.runId, runId))
      .orderBy(asc(steps.idx));

    const callRows =
      stepRows.length === 0
        ? []
        : await this.#db
            .select()
            .from(toolCalls)
            .where(
              inArray(
                toolCalls.stepId,
                stepRows.map((step) => step.id),
              ),
            )
            .orderBy(asc(toolCalls.createdAt));

    const callsByStep = new Map<string, ToolCall[]>();
    for (const row of callRows) {
      const call = toToolCall(row);
      const bucket = callsByStep.get(call.stepId);
      if (bucket) {
        bucket.push(call);
      } else {
        callsByStep.set(call.stepId, [call]);
      }
    }

    const timelineSteps: TimelineStep[] = stepRows.map((row) => ({
      ...toStep(row),
      toolCalls: callsByStep.get(row.id) ?? [],
    }));

    return {
      run: toRun(runRow),
      steps: timelineSteps,
      // Las propuestas del run las compone la capa de aplicación: el store de runs no
      // conoce el control plane de escrituras.
      proposals: [],
    };
  }

  async getRun(runId: string, tenantId: string): Promise<Run | null> {
    const [row] = await this.#db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.tenantId, tenantId)))
      .limit(1);

    return row ? toRun(row) : null;
  }

  async listRuns(tenantId: string, options: ListRunsOptions = {}): Promise<Run[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where = options.status
      ? and(eq(runs.tenantId, tenantId), eq(runs.status, options.status))
      : eq(runs.tenantId, tenantId);

    const rows = await this.#db
      .select()
      .from(runs)
      .where(where)
      .orderBy(desc(runs.createdAt))
      .limit(limit);

    return rows.map(toRun);
  }
}