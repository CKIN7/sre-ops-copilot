import type { Run, RunStep, ToolCall } from "@beacon/core/domain/runs";
import type { Model, ModelDecision } from "@beacon/core/ports/model";
import type {
  AppendStepInput,
  AppendToolCallInput,
  CompleteToolCallInput,
  CreateRunRecordInput,
  FinishRunRecordInput,
  RunStore,
} from "@beacon/core/ports/run-store";
import type { ToolCallContext, ToolCallResult, ToolGateway } from "@beacon/core/ports/tool-gateway";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";

import { Orchestrator, type StartRunInput } from "../src/orchestrator.js";

const INPUT: StartRunInput = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  goal: "investiga el pico de 5xx en checkout",
  trigger: "cli",
};

const FINAL = {
  finding: "checkout sube 5xx",
  evidence: ["query_metrics: max=4.1"],
  proposedAction: null,
  confidence: 0.7,
  nextStep: null,
};

class FakeStore implements RunStore {
  readonly events: string[] = [];
  readonly steps: RunStep[] = [];
  readonly toolCalls: ToolCall[] = [];
  finished: FinishRunRecordInput | undefined;
  #stepSeq = 0;
  #callSeq = 0;

  async createRun(input: CreateRunRecordInput): Promise<Run> {
    this.events.push("createRun");
    return {
      id: "10000000-0000-4000-8000-000000000000",
      tenantId: input.tenantId,
      agentId: input.agentId,
      status: "queued",
      trigger: input.trigger,
      goal: input.goal,
      startedAt: null,
      endedAt: null,
      costCents: 0,
      tokensIn: 0,
      tokensOut: 0,
      errorCode: null,
      createdAt: "2026-11-19T00:00:00.000Z",
    };
  }

  async markRunRunning(): Promise<void> {
    this.events.push("markRunRunning");
  }

  async finishRun(_runId: string, input: FinishRunRecordInput): Promise<void> {
    this.events.push("finishRun");
    this.finished = input;
  }

  async appendStep(input: AppendStepInput): Promise<RunStep> {
    this.events.push(`appendStep:${input.kind}`);
    this.#stepSeq += 1;
    const step: RunStep = {
      id: `20000000-0000-4000-8000-${String(this.#stepSeq).padStart(12, "0")}`,
      runId: input.runId,
      idx: input.idx,
      kind: input.kind,
      model: input.model,
      promptVersion: input.promptVersion,
      latencyMs: input.latencyMs,
      costCents: input.costCents,
      payloadRef: input.payloadRef,
      createdAt: "2026-11-19T00:00:01.000Z",
    };
    this.steps.push(step);
    return step;
  }

  async appendToolCall(input: AppendToolCallInput): Promise<ToolCall> {
    this.events.push("appendToolCall");
    this.#callSeq += 1;
    const call: ToolCall = {
      id: `30000000-0000-4000-8000-${String(this.#callSeq).padStart(12, "0")}`,
      stepId: input.stepId,
      tool: input.tool,
      argsRedacted: input.argsRedacted,
      resultHash: null,
      status: input.status,
      errorCode: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: "2026-11-19T00:00:02.000Z",
      finishedAt: null,
    };
    this.toolCalls.push(call);
    return call;
  }

  async completeToolCall(input: CompleteToolCallInput): Promise<void> {
    this.events.push(`completeToolCall:${input.status}`);
  }

  async getTimeline(): Promise<null> {
    return null;
  }

  async getRun(): Promise<null> {
    return null;
  }

  async listRuns(): Promise<Run[]> {
    return [];
  }
}

function scriptedModel(decisions: ModelDecision[]): Model {
  let index = 0;
  return {
    id: "fake-model",
    promptVersion: "test-v0",
    async decide() {
      const decision = decisions[index];
      index += 1;
      if (!decision) {
        throw new Error("scripted model ran out of decisions");
      }
      return decision;
    },
  };
}

function fakeGateway(
  result: unknown = { ok: true },
  events: string[] = [],
): { gateway: ToolGateway; calls: Array<{ tool: string; args: unknown; context: ToolCallContext }> } {
  const calls: Array<{ tool: string; args: unknown; context: ToolCallContext }> = [];
  return {
    calls,
    gateway: {
      async call(tool, args, context): Promise<ToolCallResult> {
        events.push("gateway.call");
        calls.push({ tool, args, context });
        return { result, latencyMs: 2 };
      },
    },
  };
}

function toolCall(tool: string, args: Record<string, unknown>): ModelDecision {
  return { type: "tool_call", tool: tool as never, args, rationale: "test" };
}

describe("Orchestrator", () => {
  it("escribe la tool call antes de ejecutarla y cierra el run con éxito", async () => {
    const store = new FakeStore();
    const { gateway } = fakeGateway(undefined, store.events);
    const model = scriptedModel([toolCall("list_services", {}), { type: "final", answer: FINAL }]);
    const orchestrator = new Orchestrator({ model, gateway, store });

    const result = await orchestrator.run(INPUT);

    expect(result).toMatchObject({ status: "succeeded", errorCode: null, turns: 2 });
    expect(result.answer).toEqual(FINAL);
    expect(store.events).toEqual([
      "createRun",
      "markRunRunning",
      "appendStep:model",
      "appendStep:tool",
      "appendToolCall",
      "gateway.call",
      "completeToolCall:ok",
      "appendStep:model",
      "finishRun",
    ]);
    expect(store.steps.map((step) => step.idx)).toEqual([0, 1, 2]);
    expect(store.finished).toMatchObject({ status: "succeeded", errorCode: null });
  });

  it("persiste los args redactados antes de llamar al gateway", async () => {
    const store = new FakeStore();
    const { gateway } = fakeGateway();
    const model = scriptedModel([
      toolCall("search_logs", { service: "checkout", query: "avisa a a@b.com", window: "1h" }),
      { type: "final", answer: FINAL },
    ]);

    await new Orchestrator({ model, gateway, store, now: () => 1_000 }).run(INPUT);

    const persisted = JSON.stringify(store.toolCalls[0]?.argsRedacted);
    expect(persisted).not.toContain("a@b.com");
    expect(persisted).toContain("[redacted:email]");
  });

  it("registra la tool call como error y falla el run cuando el gateway falla", async () => {
    const store = new FakeStore();
    const gateway: ToolGateway = {
      async call() {
        throw new Error("boom");
      },
    };
    const model = scriptedModel([toolCall("list_services", {}), { type: "final", answer: FINAL }]);

    const result = await new Orchestrator({ model, gateway, store }).run(INPUT);

    expect(result).toMatchObject({ status: "failed", errorCode: "internal", turns: 1 });
    expect(store.events).toContain("completeToolCall:error");
    expect(store.finished).toMatchObject({ status: "failed", errorCode: "internal" });
  });

  it("aborta con loop_detected al repetir tool y args", async () => {
    const store = new FakeStore();
    const { gateway, calls } = fakeGateway();
    const model = scriptedModel([
      toolCall("list_services", {}),
      toolCall("list_services", {}),
    ]);

    const result = await new Orchestrator({ model, gateway, store }).run(INPUT);

    expect(result).toMatchObject({ status: "failed", errorCode: "loop_detected", turns: 2 });
    expect(calls).toHaveLength(1);
    expect(store.finished).toMatchObject({ status: "failed", errorCode: "loop_detected" });
  });

  it("corta por presupuesto de turnos", async () => {
    const store = new FakeStore();
    const { gateway, calls } = fakeGateway();
    const model = scriptedModel([
      toolCall("get_service", { name: "api" }),
      toolCall("get_service", { name: "web" }),
    ]);

    const result = await new Orchestrator({
      model,
      gateway,
      store,
      limits: { maxModelTurns: 2 },
    }).run(INPUT);

    expect(result).toMatchObject({ status: "failed", errorCode: "budget_exceeded" });
    expect(calls).toHaveLength(2);
  });

  it("corta por reloj de pared antes de llamar al modelo", async () => {
    const store = new FakeStore();
    const { gateway } = fakeGateway();
    let clock = 1_000_000;
    let modelCalls = 0;
    const model: Model = {
      id: "never",
      promptVersion: "test",
      async decide() {
        modelCalls += 1;
        throw new Error("no debería llamarse");
      },
    };

    // El reloj avanza mientras el run arranca: el primer tick del loop ya supera
    // los 90 s, así que el modelo no llega a decidir.
    const markRunRunning = store.markRunRunning.bind(store);
    store.markRunRunning = async () => {
      await markRunRunning();
      clock += 100_000;
    };

    const result = await new Orchestrator({
      model,
      gateway,
      store,
      limits: { maxWallMs: 90_000 },
      now: () => clock,
    }).run(INPUT);

    expect(result).toMatchObject({ status: "failed", errorCode: "timeout", turns: 0 });
    expect(modelCalls).toBe(0);
    expect(store.finished).toMatchObject({ status: "failed", errorCode: "timeout" });
  });

  it("respeta la cancelación antes del primer turno", async () => {
    const store = new FakeStore();
    const { gateway, calls } = fakeGateway();
    const model = scriptedModel([{ type: "final", answer: FINAL }]);
    const controller = new AbortController();
    controller.abort();

    const result = await new Orchestrator({ model, gateway, store }).run({
      ...INPUT,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ status: "cancelled", errorCode: null, turns: 0 });
    expect(calls).toHaveLength(0);
    expect(store.finished).toMatchObject({ status: "cancelled" });
  });

  it("emite spans de run, step y tool_call con los atributos del plan", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();

    const store = new FakeStore();
    const { gateway } = fakeGateway();
    const model = scriptedModel([
      toolCall("list_services", {}),
      { type: "final", answer: FINAL },
    ]);

    await new Orchestrator({ model, gateway, store }).run(INPUT);

    const spans = exporter.getFinishedSpans();
    const names = spans.map((span) => span.name);
    expect(names).toContain("run");
    expect(names).toContain("step");
    expect(names).toContain("tool_call");

    const run = spans.find((span) => span.name === "run");
    expect(run?.attributes).toMatchObject({
      tenant_id: INPUT.tenantId,
      run_id: "10000000-0000-4000-8000-000000000000",
      model: "fake-model",
      prompt_version: "test-v0",
    });

    const call = spans.find((span) => span.name === "tool_call");
    expect(call?.attributes).toMatchObject({
      tenant_id: INPUT.tenantId,
      run_id: "10000000-0000-4000-8000-000000000000",
      tool: "list_services",
      step_idx: 1,
    });
    expect(typeof call?.attributes.schema_hash).toBe("string");
    expect(call?.attributes.schema_hash).not.toBe("unknown");

    await provider.shutdown();
  });

  it("rechaza una respuesta final sin evidencia", async () => {
    const store = new FakeStore();
    const { gateway } = fakeGateway();
    const model = scriptedModel([
      { type: "final", answer: { ...FINAL, evidence: [] } as never },
    ]);

    const result = await new Orchestrator({ model, gateway, store }).run(INPUT);

    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_input" });
    expect(store.finished).toMatchObject({ status: "failed" });
  });
});