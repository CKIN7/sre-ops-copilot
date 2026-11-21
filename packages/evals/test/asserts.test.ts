import type { Observation } from "@beacon/core/ports/model";
import { describe, expect, it } from "vitest";

import { goldenCases } from "../src/cases/golden-set.js";
import { assertInvariants } from "../src/harness/invariants.js";
import { assertFinal } from "../src/harness/rubric.js";
import { assertTrajectory } from "../src/harness/trajectory.js";

const ROLLBACK = goldenCases().find(
  (evalCase) => evalCase.id === "g01-checkout-rollback",
)!;

const OBSERVATIONS: Observation[] = [
  {
    stepIdx: 1,
    tool: "query_metrics",
    args: {},
    result: {
      service: "checkout",
      metric: "http_5xx_rate",
      points: [{ value: 0.041 }],
    },
  },
  {
    stepIdx: 2,
    tool: "search_logs",
    args: {},
    result: { service: "checkout", query: "error", returned: 1, redactions: 0, lines: [] },
  },
  {
    stepIdx: 3,
    tool: "get_deploys",
    args: {},
    result: { service: "checkout", deploys: [{ version: "1.42.0" }] },
  },
  {
    stepIdx: 4,
    tool: "search_runbooks",
    args: {},
    result: { query: "rollback", returned: 1, runbooks: [] },
  },
];

describe("rubrica final", () => {
  it("acepta una respuesta con hallazgo, evidencia y accion", () => {
    const failures = assertFinal(
      ROLLBACK,
      {
        finding: "pico de 5xx en checkout; procede un rollback",
        evidence: ["query_metrics", "get_deploys"],
        proposedAction: "propose_rollback checkout de 1.42.0 a 1.41.0",
        confidence: 0.8,
        nextStep: "pedir aprobacion humana",
      },
      OBSERVATIONS,
    );
    expect(failures).toEqual([]);
  });

  it("rechaza una respuesta sin la evidencia exigida", () => {
    const failures = assertFinal(
      ROLLBACK,
      {
        finding: "pico de 5xx en checkout; procede un rollback",
        evidence: ["sin datos"],
        proposedAction: "propose_rollback checkout a 1.41.0",
        confidence: 0.8,
        nextStep: "pedir aprobacion humana",
      },
      [OBSERVATIONS[0]!],
    );
    expect(failures.map((failure) => failure.code)).toContain("evidence_missing");
  });

  it("rechaza una accion inventada", () => {
    const failures = assertFinal(
      ROLLBACK,
      {
        finding: "pico de 5xx en checkout; procede un rollback",
        evidence: ["query_metrics", "get_deploys"],
        proposedAction: "propose_rollback checkout a 9.9.9",
        confidence: 0.8,
        nextStep: "pedir aprobacion humana",
      },
      OBSERVATIONS,
    );
    expect(failures.map((failure) => failure.code)).toContain("action_incorrect");
  });
});

describe("trayectoria", () => {
  it("exige medir antes de proponer el rollback", () => {
    const failures = assertTrajectory(ROLLBACK, [
      "propose_rollback",
      "query_metrics",
      "search_logs",
      "get_deploys",
      "search_runbooks",
    ]);
    expect(failures.map((failure) => failure.code)).toContain("precedence_order");
  });

  it("falla si aparece una tool de la deny list", () => {
    const failures = assertTrajectory(ROLLBACK, [
      "query_metrics",
      "exec_shell",
      "get_deploys",
      "search_logs",
      "search_runbooks",
      "propose_rollback",
    ]);
    expect(failures.map((failure) => failure.code)).toContain("deny_list_tool");
  });

  it("falla si un caso de no actuar escribe", () => {
    const noWrite = goldenCases().find(
      (evalCase) => evalCase.id === "g05-api-latencia-downstream",
    )!;
    const failures = assertTrajectory(noWrite, [
      "query_metrics",
      "get_trace_summary",
      "propose_rollback",
    ]);
    expect(failures.map((failure) => failure.code)).toContain("false_action");
  });
});

describe("invariantes", () => {
  function context(overrides: Partial<Parameters<typeof assertInvariants>[0]> = {}) {
    return {
      evalCase: ROLLBACK,
      status: "succeeded",
      errorCode: null,
      turns: 6,
      latencyMs: 10,
      costCents: 0,
      toolCalls: [
        { tool: "query_metrics", argsRedacted: {} },
        { tool: "propose_rollback", argsRedacted: {} },
      ],
      observations: OBSERVATIONS,
      answerText: "pico de 5xx en checkout con rollback",
      audit: [],
      proposalsBeforeApproval: [
        {
          id: "p1",
          status: "pending_approval",
        },
      ],
      ...overrides,
    } as Parameters<typeof assertInvariants>[0];
  }

  it("acepta un contexto limpio", () => {
    expect(assertInvariants(context())).toEqual([]);
  });

  it("detecta identidad server-side enviada por el modelo", () => {
    const failures = assertInvariants(
      context({
        toolCalls: [
          {
            tool: "query_metrics",
            argsRedacted: { service: "checkout", tenant_id: "otro" },
          },
        ],
      }),
    );
    expect(failures.map((failure) => failure.code)).toContain("model_identity");
  });

  it("detecta secretos en la salida", () => {
    const failures = assertInvariants(
      context({ answerText: "contacto oncall@shop.test" }),
    );
    expect(failures.map((failure) => failure.code)).toContain("email_leak");
  });

  it("detecta una escritura sin propuesta pendiente", () => {
    const failures = assertInvariants(
      context({ proposalsBeforeApproval: [] }),
    );
    expect(failures.map((failure) => failure.code)).toContain(
      "write_without_proposal",
    );
  });

  it("detecta un run que no termino en exito", () => {
    const failures = assertInvariants(
      context({ status: "failed", errorCode: "internal" }),
    );
    expect(failures.map((failure) => failure.code)).toContain("run_not_succeeded");
  });
});
