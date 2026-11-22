import type { ActionExecutor, ActionResult } from "@beacon/core/ports/action-executor";
import { describe, expect, it } from "vitest";

import type { CommandResult, CommandRunner } from "../src/command.js";
import { SandboxExecutor } from "../src/sandbox.js";
import {
  assertSandboxSupported,
  parseDurationMs,
  parseSandboxConfig,
  type SandboxConfig,
} from "../src/sandbox-config.js";

const CONFIG: SandboxConfig = {
  target: "kind",
  namespace: "beacon-sandbox",
  context: null,
  kubeconfig: null,
  readinessTimeoutMs: 1_000,
  pollIntervalMs: 100,
  commandTimeoutMs: 1_000,
};

interface ClusterState {
  versions: string[];
  currentRevision: number;
  inProgress: boolean;
  pendingReadyPolls: number;
  undoCommands: number;
  undoFails: boolean;
  deploymentMissing: boolean;
  commandTimeout: boolean;
  undoTimeout: boolean;
}

function cluster(overrides: Partial<ClusterState> = {}): ClusterState {
  return {
    versions: ["1.40.0", "1.41.0", "1.42.0"],
    currentRevision: 3,
    inProgress: false,
    pendingReadyPolls: 0,
    undoCommands: 0,
    undoFails: false,
    deploymentMissing: false,
    commandTimeout: false,
    undoTimeout: false,
    ...overrides,
  };
}

function deploymentJson(state: ClusterState, generation: number): string {
  const version = state.versions[state.currentRevision - 1] ?? "";
  const ready = state.pendingReadyPolls === 0 && !state.inProgress;
  const replicas = 2;
  return JSON.stringify({
    metadata: { name: "checkout", generation },
    spec: {
      replicas,
      template: {
        metadata: { annotations: { "beacon.io/version": version } },
        spec: { containers: [{ name: "app", image: `beacon/checkout:${version}` }] },
      },
    },
    status: {
      observedGeneration: generation,
      replicas,
      updatedReplicas: state.inProgress ? 1 : replicas,
      readyReplicas: ready ? replicas : 0,
      availableReplicas: ready ? replicas : 0,
      unavailableReplicas: state.inProgress ? 1 : 0,
      conditions: state.inProgress
        ? [{ type: "Progressing", status: "True", reason: "ReplicaSetUpdated" }]
        : [],
    },
  });
}

class FakeClusterRunner implements CommandRunner {
  readonly state: ClusterState;
  readonly calls: string[][] = [];
  #generation = 1;

  constructor(state: ClusterState) {
    this.state = state;
  }

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    const argsList = [...args];

    if (argsList[0] === "version" || argsList[0] === "cluster-info") {
      return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
    }

    if (argsList[0] === "get" && argsList[1] === "deployment") {
      if (this.state.commandTimeout) {
        return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      }
      if (this.state.deploymentMissing) {
        return { exitCode: 1, stdout: "", stderr: 'Error from server (NotFound)', timedOut: false };
      }
      if (this.state.pendingReadyPolls > 0) {
        this.state.pendingReadyPolls -= 1;
      }
      return {
        exitCode: 0,
        stdout: deploymentJson(this.state, this.#generation),
        stderr: "",
        timedOut: false,
      };
    }

    if (argsList[0] === "get" && argsList[1] === "replicasets") {
      const items = this.state.versions.map((version, index) => ({
        metadata: {
          name: `checkout-${version.replaceAll(".", "")}`,
          annotations: { "deployment.kubernetes.io/revision": String(index + 1) },
        },
        spec: {
          template: {
            metadata: { annotations: { "beacon.io/version": version } },
            spec: {
              containers: [{ name: "app", image: `beacon/checkout:${version}` }],
            },
          },
        },
      }));
      return { exitCode: 0, stdout: JSON.stringify({ items }), stderr: "", timedOut: false };
    }

    if (argsList[0] === "rollout" && argsList[1] === "undo") {
      this.state.undoCommands += 1;
      if (this.state.undoTimeout) {
        return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      }
      if (this.state.undoFails) {
        return { exitCode: 1, stdout: "", stderr: "error: unable to find", timedOut: false };
      }
      const revision = Number(argsList.find((arg) => arg.startsWith("--to-revision="))?.split("=")[1]);
      this.state.currentRevision = revision;
      this.#generation += 1;
      this.state.inProgress = false;
      return { exitCode: 0, stdout: "deployment.apps/checkout rolled back", stderr: "", timedOut: false };
    }

    throw new Error(`comando no simulado: ${argsList.join(" ")}`);
  }
}

function fallbackExecutor(): ActionExecutor {
  const result: ActionResult = {
    effectId: "effect-fallback",
    status: "applied",
    observedState: { simulated: true },
    verified: true,
    durationMs: 1,
    evidence: ["simulado"],
  };
  return {
    rollback: async () => result,
    setFlag: async () => result,
    silenceAlert: async () => result,
  };
}

function executor(state: ClusterState): SandboxExecutor {
  let now = 0;
  return new SandboxExecutor({
    config: CONFIG,
    fallback: fallbackExecutor(),
    runner: new FakeClusterRunner(state),
    now: () => {
      now += 100;
      return now;
    },
    sleep: async () => {
      // El reloj avanza en `now`; no se espera de verdad.
    },
  });
}

describe("SandboxExecutor", () => {
  it("aplica el rollback y verifica readiness", async () => {
    const state = cluster();
    const result = await executor(state).rollback({
      service: "checkout",
      toVersion: "1.41.0",
      reason: "pico de 5xx",
      idempotencyKey: "sandbox:case1",
    });

    expect(result.status).toBe("applied");
    expect(result.verified).toBe(true);
    expect(state.currentRevision).toBe(2);
    expect((result.observedState as Record<string, unknown>).version).toBe("1.41.0");
  });

  it("devuelve conflict con el estado observado si la version no existe", async () => {
    const state = cluster();
    const result = await executor(state).rollback({
      service: "checkout",
      toVersion: "9.9.9",
      reason: "prueba",
      idempotencyKey: "sandbox:case2",
    });

    expect(result.status).toBe("conflict");
    expect(result.verified).toBe(false);
    expect((result.observedState as Record<string, unknown>).version).toBe("1.42.0");
    expect(state.undoCommands).toBe(0);
  });

  it("reintenta con la misma key sin una segunda ejecucion", async () => {
    const state = cluster();
    const sandbox = executor(state);
    const first = await sandbox.rollback({
      service: "checkout",
      toVersion: "1.41.0",
      reason: "prueba",
      idempotencyKey: "sandbox:case3",
    });
    const second = await sandbox.rollback({
      service: "checkout",
      toVersion: "1.41.0",
      reason: "prueba",
      idempotencyKey: "sandbox:case3",
    });

    expect(first.effectId).toBe(second.effectId);
    expect(second.status).toBe("noop");
    expect(state.undoCommands).toBe(1);
  });

  it("no declara exito si la readiness no llega: applied con verified=false", async () => {
    const state = cluster({ pendingReadyPolls: 100 });
    const result = await executor(state).rollback({
      service: "checkout",
      toVersion: "1.41.0",
      reason: "prueba",
      idempotencyKey: "sandbox:case4",
    });

    expect(result.status).toBe("applied");
    expect(result.verified).toBe(false);
    expect(result.evidence.join(" ")).toContain("readiness no llego");
  });

  it("devuelve conflict durante un rollout en curso y reconcilia al reintentar", async () => {
    const state = cluster({ inProgress: true });
    const sandbox = executor(state);
    const first = await sandbox.rollback({
      service: "checkout",
      toVersion: "1.41.0",
      reason: "prueba",
      idempotencyKey: "sandbox:case5",
    });
    expect(first.status).toBe("conflict");
    expect(state.undoCommands).toBe(0);

    state.inProgress = false;
    const second = await sandbox.rollback({
      service: "checkout",
      toVersion: "1.41.0",
      reason: "prueba",
      idempotencyKey: "sandbox:case5b",
    });
    expect(second.status).toBe("applied");
    expect(second.verified).toBe(true);
  });

  it("devuelve timeout si kubectl agota el timeout y consulta el estado", async () => {
    const state = cluster({ undoTimeout: true });
    const result = await executor(state).rollback({
      service: "checkout",
      toVersion: "1.41.0",
      reason: "prueba",
      idempotencyKey: "sandbox:timeout",
    });

    expect(result.status).toBe("timeout");
    expect(result.verified).toBe(false);
    expect(result.observedState).not.toBeNull();
  });

  it("delega set_flag al simulado y lo dice en la evidencia", async () => {
    const state = cluster();
    const result = await executor(state).setFlag({
      flag: "checkout.new_flow",
      value: true,
      reason: "prueba",
      idempotencyKey: "sandbox:flag",
    });

    expect(result.status).toBe("applied");
    expect(result.evidence[0]).toContain("fuera del sandbox");
  });
});

describe("configuracion del sandbox", () => {
  it("parsea READINESS_TIMEOUT y falla cerrado con unidades desconocidas", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("2m")).toBe(120_000);
    expect(() => parseDurationMs("30")).toThrow(/invalido/);

    const config = parseSandboxConfig({
      SANDBOX_TARGET: "kind",
      READINESS_TIMEOUT: "45s",
      SANDBOX_POLL_INTERVAL: "1s",
      SANDBOX_COMMAND_TIMEOUT: "30s",
    });
    expect(config.readinessTimeoutMs).toBe(45_000);
  });

  it("rechaza compose hasta que exista su adaptador medido", () => {
    const config = parseSandboxConfig({ SANDBOX_TARGET: "compose" });
    expect(() => assertSandboxSupported(config)).toThrow(/compose/);
  });
});
