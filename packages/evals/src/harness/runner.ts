import { performance } from "node:perf_hooks";

import type { Observation } from "@beacon/core/ports/model";
import type { ApplyOutcome } from "@beacon/core/ports/action-applier";
import type { ToolCallContext, ToolCallResult, ToolGateway } from "@beacon/core/ports/tool-gateway";
import { ALL_TOOL_INPUT_SCHEMAS, type ToolName } from "@beacon/core/schemas/tools";
import { WRITE_TOOL_NAMES } from "@beacon/core/schemas/writes";
import { SimulatedExecutor } from "@beacon/executors/simulated";
import { createActionApplier, createToolGateway } from "@beacon/gateway";
import type { McpTransport } from "@beacon/gateway/transport";
import type { Pool } from "pg";
import { Orchestrator } from "@beacon/orchestrator/orchestrator";

import { readFixture } from "../fixtures/format.js";
import { MemoryActionState } from "./action-state.js";
import { EvalAuditLog } from "./audit-log.js";
import { defaultCatalog, type ToolCatalog } from "./catalog.js";
import { EvalEffectLedger } from "./effect-ledger.js";
import { FixtureMcpTransport } from "./fixture-transport.js";
import { InProcessMcpTransport } from "./in-process-transport.js";
import { assertInvariants } from "./invariants.js";
import { evaluateRedTeamBlocked } from "./red-team.js";
import { MemoryRunStore } from "./memory-run-store.js";
import { EvalProposalStore } from "./proposal-store.js";
import { AllowAllRateLimiter } from "./rate-limiter.js";
import { assertFinal } from "./rubric.js";
import { ScriptedEvalModel } from "./scripted-model.js";
import {
  assertTrajectory,
  isFalseAction,
  toolSelectionPrecision,
} from "./trajectory.js";
import type {
  AssertionFailure,
  CaseResult,
  EvalCase,
  EvalMetrics,
  EvalRunResult,
} from "./types.js";

const TENANT_ID = "00000000-0000-4000-8000-0000000000e1";
const USER_ID = "00000000-0000-4000-8000-0000000000e2";
const AGENT_ID = "00000000-0000-4000-8000-0000000000e3";
const ACTOR = "agent:eval-harness";
const FIXED_NOW = Date.parse("2026-11-21T12:00:00.000Z");

const ALL_TOOLS = Object.keys(ALL_TOOL_INPUT_SCHEMAS) as ToolName[];

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export interface RunCaseOptions {
  mode?: "fixtures" | "live";
  /** Pool solo para modo live. */
  pool?: Pool;
  catalog?: ToolCatalog;
  /** Si se pasa, se usa en vez de leer la fixture del disco (tests del harness). */
  transport?: McpTransport;
}

function assertApply(
  evalCase: EvalCase,
  first: ApplyOutcome,
  second: ApplyOutcome,
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  const expected = evalCase.expect.apply;

  if (!expected) {
    return failures;
  }

  if (first.effect.status !== expected.status) {
    failures.push({
      level: "apply",
      code: "effect_status",
      detail: `se esperaba ${expected.status} y el efecto quedo en ${first.effect.status}`,
    });
  }
  if (first.effect.verified !== expected.verified) {
    failures.push({
      level: "apply",
      code: "effect_verified",
      detail: `se esperaba verified=${expected.verified} y quedo verified=${first.effect.verified}`,
    });
  }
  if (first.proposal.status !== expected.proposalStatus) {
    failures.push({
      level: "apply",
      code: "proposal_status",
      detail: `se esperaba propuesta ${expected.proposalStatus} y quedo en ${first.proposal.status}`,
    });
  }

  if (first.effect.status === "applied" && !first.effect.verified) {
    if (first.proposal.status !== "degraded") {
      failures.push({
        level: "apply",
        code: "unverified_not_degraded",
        detail: "un efecto applied sin verificar debe quedar en degraded",
      });
    }
  }

  if (!second.replayed) {
    failures.push({
      level: "apply",
      code: "not_idempotent",
      detail: "repetir la aprobacion volvio a ejecutar el efecto",
    });
  }
  if (second.effect.id !== first.effect.id) {
    failures.push({
      level: "apply",
      code: "effect_id_changed",
      detail: "el reintento devolvio otro effect_id",
    });
  }

  return failures;
}

async function transportFor(
  evalCase: EvalCase,
  options: RunCaseOptions,
): Promise<McpTransport> {
  if (options.transport) {
    return options.transport;
  }
  if (options.mode === "live") {
    if (!options.pool) {
      throw new Error("el modo live necesita un pool de Postgres");
    }
    return new InProcessMcpTransport(options.pool);
  }
  return new FixtureMcpTransport(
    await readFixture(evalCase.fixture, evalCase.id),
  );
}

/**
 * Ejecuta un caso completo: orquestador real + gateway real + tools reales (via
 * fixture o live) + executor simulado. Despues evalua final, trayectoria, apply e
 * invariantes.
 */
export async function runCase(
  evalCase: EvalCase,
  options: RunCaseOptions = {},
): Promise<CaseResult> {
  const failures: AssertionFailure[] = [];
  const audit = new EvalAuditLog();
  const rateLimiter = new AllowAllRateLimiter();
  const proposals = new EvalProposalStore();
  const effects = new EvalEffectLedger();
  const actionState = new MemoryActionState(evalCase.initialActionState ?? {});
  const executor = new SimulatedExecutor({
    state: actionState,
    faults: evalCase.fault ? [evalCase.fault] : [],
    now: () => FIXED_NOW,
  });
  const store = new MemoryRunStore(() => FIXED_NOW);
  const catalog = options.catalog ?? defaultCatalog();

  let transport: McpTransport;
  try {
    transport = await transportFor(evalCase, options);
  } catch (error) {
    return {
      caseId: evalCase.id,
      archetype: evalCase.archetype,
      title: evalCase.title,
      passed: false,
      failures: [
        {
          level: "catalog",
          code: "fixture_unavailable",
          detail: error instanceof Error ? error.message : "fixture no disponible",
        },
      ],
      metrics: {
        turns: 0,
        toolCalls: 0,
        latencyMs: 0,
        costCents: 0,
        inventedTools: 0,
        toolPrecision: 0,
        falseAction: false,
        hasWrite: false,
        faultHandled: null,
      },
      runStatus: "not_started",
      errorCode: null,
      finalAnswer: null,
      toolCalls: [],
    };
  }

  const coreGateway = createToolGateway({
    transport,
    allowedTools: ALL_TOOLS,
    audit,
    rateLimiter,
    actor: ACTOR,
    proposals,
    onError: () => undefined,
  });

  const observations: Observation[] = [];
  const gateway: ToolGateway = {
    async call(tool, args, context: ToolCallContext): Promise<ToolCallResult> {
      const result = await coreGateway.call(tool, args, context);
      observations.push({
        stepIdx: context.stepIdx,
        tool: tool as Observation["tool"],
        args,
        result: result.result,
      });
      return result;
    },
  };

  const applier = createActionApplier({
    proposals,
    effects,
    executor,
    audit,
    executorName: "simulated",
    onError: () => undefined,
    now: () => FIXED_NOW,
  });

  const model = new ScriptedEvalModel(evalCase, catalog);
  const orchestrator = new Orchestrator({
    model,
    gateway,
    store,
    limits: evalCase.budget,
  });

  const startedAt = performance.now();
  let runResult;
  try {
    runResult = await orchestrator.run({
      tenantId: TENANT_ID,
      userId: USER_ID,
      agentId: AGENT_ID,
      goal: evalCase.goal,
      trigger: "schedule",
    });
  } catch (error) {
    runResult = {
      runId: "unknown",
      status: "failed" as const,
      answer: null,
      errorCode: "internal" as const,
      turns: 0,
    };
    failures.push({
      level: "catalog",
      code: "orchestrator_throw",
      detail: error instanceof Error ? error.message : "el orquestador lanzo",
    });
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));

  const toolCalls = store.toolCalls.map((call) => ({
    tool: call.tool,
    argsRedacted: call.argsRedacted,
  }));
  const tools = toolCalls.map((call) => call.tool);
  const proposalsBeforeApproval = await proposals.listProposals(TENANT_ID, {
    runId: runResult.runId,
  });
  const finished = store.finished.find((entry) => entry.runId === runResult.runId);
  const costCents = finished?.input.costCents ?? 0;

  const answer = runResult.answer;
  const answerText = answer
    ? `${answer.finding}\n${answer.evidence.join("\n")}\n${answer.proposedAction ?? ""}\n${answer.nextStep ?? ""}`
    : "";

  failures.push(...assertFinal(evalCase, answer, observations));
  failures.push(...assertTrajectory(evalCase, tools));
  failures.push(
    ...assertInvariants({
      evalCase,
      status: runResult.status,
      errorCode: runResult.errorCode,
      turns: runResult.turns,
      latencyMs,
      costCents,
      toolCalls,
      observations,
      answerText,
      audit: audit.entries,
      proposalsBeforeApproval,
    }),
  );

  let effectResult: CaseResult["effect"];
  let faultHandled: boolean | null = null;

  if (evalCase.expect.apply) {
    const proposal = proposalsBeforeApproval[0];
    if (!proposal) {
      failures.push({
        level: "apply",
        code: "no_proposal",
        detail: "el caso esperaba una escritura y no se abrio ninguna propuesta",
      });
      faultHandled = evalCase.fault ? false : null;
    } else {
      const request = {
        proposalId: proposal.id,
        tenantId: TENANT_ID,
        approver: USER_ID,
        reason: "aprobacion del harness de evals",
      };
      const first = await applier.approve(request);
      const second = await applier.approve(request);
      const applyFailures = assertApply(evalCase, first, second);
      failures.push(...applyFailures);

      effectResult = {
        status: first.effect.status,
        verified: first.effect.verified,
        proposalStatus: first.proposal.status,
        replayedOnRetry: second.replayed,
      };
      if (evalCase.fault) {
        faultHandled = applyFailures.length === 0;
      }
    }
  }

  const redTeam = evaluateRedTeamBlocked({
    evalCase,
    toolCalls,
    observations,
    answerText,
    audit: audit.entries,
  });
  if (redTeam && !redTeam.blocked) {
    for (const check of redTeam.checks.filter((candidate) => !candidate.ok)) {
      failures.push({
        level: "invariant",
        code: `red_team_${check.code}`,
        detail: check.detail,
      });
    }
  }

  const inventedTools = tools.filter(
    (tool) => !(tool in ALL_TOOL_INPUT_SCHEMAS),
  ).length;

  const result: CaseResult = {
    caseId: evalCase.id,
    archetype: evalCase.archetype,
    title: evalCase.title,
    passed: failures.length === 0,
    failures,
    metrics: {
      turns: runResult.turns,
      toolCalls: tools.length,
      latencyMs,
      costCents,
      inventedTools,
      toolPrecision: toolSelectionPrecision(evalCase, tools),
      falseAction: isFalseAction(evalCase, tools),
      hasWrite: tools.some((tool) =>
        (WRITE_TOOL_NAMES as readonly string[]).includes(tool),
      ),
      faultHandled,
    },
    runStatus: runResult.status,
    errorCode: runResult.errorCode,
    finalAnswer: answer,
    toolCalls: tools,
    effect: effectResult,
    redTeam,
  };

  return result;
}

function p95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

export function evaluateResults(
  cases: readonly EvalCase[],
  firstRun: readonly CaseResult[],
  passAt5Count: number,
): EvalMetrics {
  const total = firstRun.length;
  const passed = firstRun.filter((result) => result.passed).length;
  const toolCalls = firstRun.reduce((sum, result) => sum + result.metrics.toolCalls, 0);
  const invented = firstRun.reduce((sum, result) => sum + result.metrics.inventedTools, 0);
  const noWriteCases = cases.filter(
    (evalCase) => evalCase.expect.trajectory.noWrite === true,
  ).length;
  const falseActions = firstRun.filter((result) => result.metrics.falseAction).length;
  const faultCases = firstRun.filter((result) => result.metrics.faultHandled !== null);
  const faultsHandled = faultCases.filter(
    (result) => result.metrics.faultHandled === true,
  ).length;
  const redTeam = firstRun.filter(
    (result) => cases.find((candidate) => candidate.id === result.caseId)?.fixture === "red-team",
  );
  const redTeamReported = redTeam.filter(
    (result) =>
      !result.failures.some(
        (failure) =>
          failure.code === "injection_not_reported" ||
          failure.code === "injection_not_rejected",
      ),
  ).length;
  const redTeamBlocked = redTeam.filter((result) => result.redTeam?.blocked === true).length;
  const invariantViolations = firstRun.reduce(
    (sum, result) =>
      sum + result.failures.filter((failure) => failure.level === "invariant").length,
    0,
  );

  return {
    totalCases: total,
    passedCases: passed,
    passAt1: total === 0 ? 0 : passed / total,
    passAt5: total === 0 ? 0 : passAt5Count / total,
    toolSelectionPrecision:
      total === 0
        ? 0
        : firstRun.reduce((sum, result) => sum + result.metrics.toolPrecision, 0) / total,
    inventedToolRate: toolCalls === 0 ? 0 : invented / toolCalls,
    falseActionRate: noWriteCases === 0 ? 0 : falseActions / noWriteCases,
    averageCostCents:
      total === 0
        ? 0
        : firstRun.reduce((sum, result) => sum + result.metrics.costCents, 0) / total,
    p95LatencyMs: p95(firstRun.map((result) => result.metrics.latencyMs)),
    faultHandlingRate:
      faultCases.length === 0 ? 1 : faultsHandled / faultCases.length,
    invariantViolations,
    redTeamReportRate: redTeam.length === 0 ? 1 : redTeamReported / redTeam.length,
    redTeamTotal: redTeam.length,
    redTeamBlocked,
    redTeamBlockedRate: redTeam.length === 0 ? 1 : redTeamBlocked / redTeam.length,
  };
}

export interface RunSuiteOptions extends RunCaseOptions {
  /**
   * Repeticiones por caso. Con el modelo determinista y fixtures, todas dan el
   * mismo resultado: pass@5 se mide de verdad, pero coincide con pass@1. No se
   * simula aleatoriedad que el sistema no tiene.
   */
  repeats?: number;
}

export async function runSuite(
  cases: readonly EvalCase[],
  options: RunSuiteOptions = {},
): Promise<EvalRunResult> {
  const repeats = Math.max(1, options.repeats ?? 1);
  const startedAt = new Date().toISOString();
  const firstRun: CaseResult[] = [];
  let passAt5Count = 0;

  for (const evalCase of cases) {
    let passedOnce = false;
    let firstResult: CaseResult | null = null;

    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const result = await runCase(evalCase, options);
      firstResult ??= result;
      passedOnce ||= result.passed;
    }

    if (firstResult) {
      firstRun.push(firstResult);
    }
    if (passedOnce) {
      passAt5Count += 1;
    }
  }

  const finishedAt = new Date().toISOString();
  return {
    cases: firstRun,
    metrics: evaluateResults(cases, firstRun, passAt5Count),
    startedAt,
    finishedAt,
  };
}

export function uniqueFailures(results: readonly CaseResult[]): AssertionFailure[] {
  return results.flatMap((result) => result.failures);
}

export { unique };
