import type { RunTimeline } from "@beacon/core/domain/runs";
import type { RunResult } from "@beacon/orchestrator/orchestrator";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/main.js";
import { formatRunResult, formatTimeline } from "../src/cli/format.js";

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

const RUN: RunResult = {
  runId: RUN_ID,
  status: "succeeded",
  errorCode: null,
  turns: 2,
  answer: {
    finding: "checkout alcanza 6.1 en http_5xx_rate",
    evidence: ["query_metrics: max=6.1"],
    proposedAction: null,
    confidence: 0.6,
    nextStep: "seguir el runbook",
  },
};

const TIMELINE: RunTimeline = {
  run: {
    id: RUN_ID,
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    status: "succeeded",
    trigger: "cli",
    goal: "investiga el pico",
    startedAt: "2026-11-19T20:00:00.000Z",
    endedAt: "2026-11-19T20:00:01.000Z",
    costCents: 0,
    tokensIn: 0,
    tokensOut: 0,
    errorCode: null,
    createdAt: "2026-11-19T20:00:00.000Z",
  },
  steps: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      runId: RUN_ID,
      idx: 0,
      kind: "model",
      model: "mock",
      promptVersion: "m2-v0",
      latencyMs: 0,
      costCents: 0,
      payloadRef: null,
      createdAt: "2026-11-19T20:00:00.000Z",
      toolCalls: [],
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      runId: RUN_ID,
      idx: 1,
      kind: "tool",
      model: null,
      promptVersion: null,
      latencyMs: 0,
      costCents: 0,
      payloadRef: null,
      createdAt: "2026-11-19T20:00:00.500Z",
      toolCalls: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          stepId: "66666666-6666-4666-8666-666666666666",
          tool: "query_metrics",
          argsRedacted: { service: "checkout", metric: "http_5xx_rate" },
          resultHash: "abc",
          status: "ok",
          errorCode: null,
          idempotencyKey: null,
          createdAt: "2026-11-19T20:00:00.500Z",
          finishedAt: "2026-11-19T20:00:00.600Z",
        },
      ],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      write: (text: string) => {
        stdout += text;
      },
      writeError: (text: string) => {
        stderr += text;
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(run: RunResult, timeline: RunTimeline) {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init });

    if (url.endsWith("/runs") && init?.method === "POST") {
      return jsonResponse({ run });
    }
    if (url.endsWith(`/runs/${run.runId}`)) {
      return jsonResponse(timeline);
    }
    return jsonResponse({ error: { code: "not_found", message: "run not found" } }, 404);
  };

  return { calls, fetchImpl };
}

describe("formatRunResult / formatTimeline", () => {
  it("muestra la respuesta final y la timeline sin inventar datos", () => {
    const result = formatRunResult(RUN);
    expect(result).toContain(`run ${RUN_ID}: succeeded`);
    expect(result).toContain("checkout alcanza 6.1");
    expect(result).toContain("query_metrics: max=6.1");
    expect(result).toContain("confianza: 0.6");

    const timeline = formatTimeline(TIMELINE);
    expect(timeline).toContain(`timeline ${RUN_ID}: succeeded (trigger=cli)`);
    expect(timeline).toContain("model mock@m2-v0");
    expect(timeline).toContain("query_metrics ok");
  });
});

describe("runCli", () => {
  it("hace POST /runs, lee la timeline y sale con 0", async () => {
    const { calls, fetchImpl } = fakeFetch(RUN, TIMELINE);
    const output = capture();

    const exitCode = await runCli({
      argv: ["run", "--goal", "investiga el pico"],
      env: {
        BEACON_API_URL: "http://api.test",
        BEACON_TOKEN: "operator-token",
      },
      fetch: fetchImpl,
      io: output.io,
    });

    expect(exitCode).toBe(0);
    const { stdout, stderr } = output.read();
    expect(stderr).toBe("");
    expect(stdout).toContain("run " + RUN_ID + ": succeeded");
    expect(stdout).toContain("timeline " + RUN_ID);

    expect(calls.map((call) => call.url)).toEqual([
      "http://api.test/runs",
      `http://api.test/runs/${RUN_ID}`,
    ]);
    const post = calls[0];
    expect(post?.init?.method).toBe("POST");
    expect(post?.init?.body).toBe(
      JSON.stringify({ goal: "investiga el pico", trigger: "cli" }),
    );
    expect((post?.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer operator-token",
    );
  });

  it("emite JSON con --json", async () => {
    const { fetchImpl } = fakeFetch(RUN, TIMELINE);
    const output = capture();

    const exitCode = await runCli({
      argv: ["run", "--goal", "investiga", "--json"],
      env: { BEACON_API_URL: "http://api.test/", BEACON_TOKEN: "operator-token" },
      fetch: fetchImpl,
      io: output.io,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output.read().stdout) as {
      run: RunResult;
      timeline: RunTimeline;
    };
    expect(parsed.run.runId).toBe(RUN_ID);
    expect(parsed.timeline.run.id).toBe(RUN_ID);
  });

  it("sale con 1 si el run no termina en succeeded", async () => {
    const failed: RunResult = {
      ...RUN,
      status: "failed",
      errorCode: "loop_detected",
      answer: null,
    };
    const { fetchImpl } = fakeFetch(failed, {
      ...TIMELINE,
      run: { ...TIMELINE.run, status: "failed", errorCode: "loop_detected" },
    });
    const output = capture();

    const exitCode = await runCli({
      argv: ["run", "--goal", "investiga"],
      env: { BEACON_TOKEN: "operator-token" },
      fetch: fetchImpl,
      io: output.io,
    });

    expect(exitCode).toBe(1);
    expect(output.read().stderr).toContain("terminó en failed");
  });

  it("sale con 1 sin token y no llama a la API", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return jsonResponse({});
    };
    const output = capture();

    const exitCode = await runCli({
      argv: ["run", "--goal", "investiga"],
      env: {},
      fetch: fetchImpl,
      io: output.io,
    });

    expect(exitCode).toBe(1);
    expect(output.read().stderr).toContain("BEACON_TOKEN");
    expect(calls).toEqual([]);
  });

  it("sale con 2 si falta --goal", async () => {
    const { fetchImpl, calls } = fakeFetch(RUN, TIMELINE);
    const output = capture();

    const exitCode = await runCli({
      argv: ["run"],
      env: { BEACON_TOKEN: "operator-token" },
      fetch: fetchImpl,
      io: output.io,
    });

    expect(exitCode).toBe(2);
    expect(output.read().stderr).toContain("falta --goal");
    expect(calls).toEqual([]);
  });

  it("muestra una timeline existente con el comando timeline", async () => {
    const { calls, fetchImpl } = fakeFetch(RUN, TIMELINE);
    const output = capture();

    const exitCode = await runCli({
      argv: ["timeline", RUN_ID, "--json"],
      env: { BEACON_API_URL: "http://api.test", BEACON_TOKEN: "operator-token" },
      fetch: fetchImpl,
      io: output.io,
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://api.test/runs/${RUN_ID}`);
    expect(JSON.parse(output.read().stdout)).toMatchObject({ run: { id: RUN_ID } });
  });

  it("traduce el error de la API y sale con 1", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({ error: { code: "not_found", message: "run not found" } }, 404);
    const output = capture();

    const exitCode = await runCli({
      argv: ["timeline", RUN_ID],
      env: { BEACON_TOKEN: "operator-token" },
      fetch: fetchImpl,
      io: output.io,
    });

    expect(exitCode).toBe(1);
    expect(output.read().stderr).toContain("404 not_found: run not found");
  });

  it("rechaza un comando desconocido con 2", async () => {
    const { fetchImpl } = fakeFetch(RUN, TIMELINE);
    const output = capture();

    const exitCode = await runCli({
      argv: ["deploy"],
      env: { BEACON_TOKEN: "operator-token" },
      fetch: fetchImpl,
      io: output.io,
    });

    expect(exitCode).toBe(2);
    expect(output.read().stderr).toContain("comando desconocido: deploy");
  });
});