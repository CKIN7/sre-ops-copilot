import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ActionStateStore } from "@beacon/core/ports/action-state";

import { NodeCommandRunner, type CommandRunner } from "../command.js";
import { SimulatedExecutor } from "../simulated.js";
import { SandboxExecutor } from "../sandbox.js";
import { parseSandboxConfig, type SandboxConfig } from "../sandbox-config.js";

/**
 * Suite de contrato del executor real (docs/plan.md §8.6).
 *
 * Se ejecuta contra un cluster de `kind`/k3s, **no** contra el simulado. No entra en
 * el gate de PR: es nocturna o manual (`pnpm contract:sandbox`). Si no hay cluster,
 * falla con un mensaje explícito; no se publica 6/6 si solo se ejecutó el simulado.
 *
 * El caso 6 (flag) se ejecuta con el `SimulatedExecutor` porque `SandboxExecutor`
 * solo cubre rollback. La evidencia de ese caso lo dice; no se presenta como real.
 */

const SERVICE = "checkout";
const GOOD_VERSIONS = ["1.25.3", "1.26.3", "1.27.1"];
const BAD_VERSION = "1.24.0-bad";

export interface ContractCaseResult {
  id: string;
  name: string;
  passed: boolean;
  simulated: boolean;
  details: Record<string, unknown>;
  error?: string;
}

export interface ContractReport {
  startedAt: string;
  finishedAt: string;
  target: string;
  namespace: string;
  cases: ContractCaseResult[];
  passed: number;
  total: number;
  note: string;
}

/** Runner que cuenta los `rollout undo` reales: prueba de que un retry no reejecuta. */
class CountingRunner implements CommandRunner {
  readonly #inner: CommandRunner;
  undoCommands = 0;

  constructor(inner: CommandRunner) {
    this.#inner = inner;
  }

  async run(
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ) {
    if (command === "kubectl" && args[0] === "rollout" && args[1] === "undo") {
      this.undoCommands += 1;
    }
    return this.#inner.run(command, args, options);
  }
}

/** Estado en memoria para el caso de flag: deja claro que ese caso es simulado. */
class MemoryState implements ActionStateStore {
  readonly #documents = new Map<string, { target: string; version: number; state: unknown }>();

  async read(target: string) {
    return this.#documents.get(target) ?? null;
  }

  async write(target: string, expectedVersion: number, state: unknown) {
    const current = this.#documents.get(target);
    if ((current?.version ?? 0) !== expectedVersion) {
      return null;
    }
    const next = { target, version: expectedVersion + 1, state };
    this.#documents.set(target, next);
    return next;
  }
}

function identityArgs(config: SandboxConfig): string[] {
  const args = ["--namespace", config.namespace];
  if (config.context) {
    args.push("--context", config.context);
  }
  if (config.kubeconfig) {
    args.push("--kubeconfig", config.kubeconfig);
  }
  return args;
}

async function kubectl(
  runner: CommandRunner,
  config: SandboxConfig,
  args: string[],
): Promise<string> {
  const result = await runner.run("kubectl", [...args, ...identityArgs(config)], {
    timeoutMs: config.commandTimeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `kubectl ${args.join(" ")} fallo: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
    );
  }
  return result.stdout;
}

function patchFor(version: string): string {
  const container = {
    name: "app",
    image: `nginx:${version}`,
    ports: [{ containerPort: 80 }],
    readinessProbe: {
      httpGet: { path: "/", port: 80 },
      initialDelaySeconds: 1,
      periodSeconds: 1,
    },
  };
  const template = {
    metadata: { labels: { app: SERVICE }, annotations: { "beacon.io/version": version } },
    spec: { containers: [container] },
  };
  return JSON.stringify({ spec: { template } });
}

/** Variante lenta: el rollout tarda en estar listo y se puede observar en curso. */
function slowPatch(version: string): string {
  const patch = JSON.parse(patchFor(version)) as {
    spec: { template: { spec: { containers: Array<Record<string, unknown>> } } };
  };
  const container = patch.spec.template.spec.containers[0];
  if (container) {
    container.readinessProbe = {
      httpGet: { path: "/", port: 80 },
      initialDelaySeconds: 15,
      periodSeconds: 2,
    };
  }
  return JSON.stringify(patch);
}

function badPatch(): string {
  return JSON.stringify({
    spec: {
      template: {
        metadata: {
          labels: { app: SERVICE },
          annotations: { "beacon.io/version": BAD_VERSION },
        },
        spec: {
          containers: [
            {
              name: "app",
              image: "nginx:1.24.0",
              // La readiness nunca pasa: el efecto se aplica pero no se verifica.
              command: ["sh", "-c", "sleep 3600"],
              ports: [{ containerPort: 80 }],
              readinessProbe: {
                httpGet: { path: "/", port: 80 },
                initialDelaySeconds: 1,
                periodSeconds: 1,
              },
            },
          ],
        },
      },
    },
  });
}

async function waitStable(
  runner: CommandRunner,
  config: SandboxConfig,
  timeoutSeconds = 90,
): Promise<void> {
  const result = await runner.run(
    "kubectl",
    [
      "rollout",
      "status",
      `deployment/${SERVICE}`,
      `--timeout=${timeoutSeconds}s`,
      ...identityArgs(config),
    ],
    { timeoutMs: (timeoutSeconds + 5) * 1_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `el workload sembrado no llego a estable: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
    );
  }
}

function deploymentJson(
  version: string,
  overrides: { bad?: boolean } = {},
): string {
  const container: Record<string, unknown> = {
    name: "app",
    image: `nginx:${overrides.bad ? "1.24.0" : version}`,
    ports: [{ containerPort: 80 }],
    readinessProbe: {
      httpGet: { path: "/", port: 80 },
      initialDelaySeconds: 1,
      periodSeconds: 1,
    },
  };
  if (overrides.bad) {
    // La readiness nunca pasa: el efecto se aplica pero no se verifica.
    container.command = ["sh", "-c", "sleep 3600"];
  }
  return JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: SERVICE, labels: { app: SERVICE } },
    spec: {
      replicas: 1,
      revisionHistoryLimit: 10,
      selector: { matchLabels: { app: SERVICE } },
      template: {
        metadata: {
          labels: { app: SERVICE },
          annotations: { "beacon.io/version": overrides.bad ? BAD_VERSION : version },
        },
        spec: { containers: [container] },
      },
    },
  });
}

/**
 * Siembra el deployment con cuatro revisiones: una mala (readiness imposible) y tres
 * buenas. La version se identifica por la anotacion `beacon.io/version`, que es la
 * misma que resuelve el executor en el historial de ReplicaSets.
 */
async function seedWorkload(runner: CommandRunner, config: SandboxConfig): Promise<void> {
  await runner.run(
    "kubectl",
    ["delete", "deployment", SERVICE, "--ignore-not-found", ...identityArgs(config)],
    { timeoutMs: config.commandTimeoutMs },
  );

  for (const [index, version] of GOOD_VERSIONS.entries()) {
    if (index === 0) {
      const manifestFile = join(tmpdir(), "beacon-sandbox-workload.json");
      await writeFile(manifestFile, deploymentJson(version), "utf8");
      await kubectl(runner, config, ["apply", "-f", manifestFile]);
    } else {
      await kubectl(runner, config, [
        "patch",
        "deployment",
        SERVICE,
        "--type=merge",
        "-p",
        patchFor(version),
      ]);
    }
    await waitStable(runner, config);
  }

  // Revision mala al final del historial para que el rollback del caso 4 la alcance.
  // No se espera a que este lista: su readiness es imposible por diseno.
  await kubectl(runner, config, [
    "patch",
    "deployment",
    SERVICE,
    "--type=merge",
    "-p",
    badPatch(),
  ]);
}

async function runCase(
  id: string,
  name: string,
  body: () => Promise<Record<string, unknown>>,
  options: { simulated?: boolean } = {},
): Promise<ContractCaseResult> {
  const started = Date.now();
  try {
    const details = await body();
    return {
      id,
      name,
      passed: true,
      simulated: options.simulated ?? false,
      details: { ...details, duration_ms: Date.now() - started },
    };
  } catch (error) {
    return {
      id,
      name,
      passed: false,
      simulated: options.simulated ?? false,
      details: { duration_ms: Date.now() - started },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runSandboxContract(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContractReport> {
  const config = parseSandboxConfig(env);
  const counting = new CountingRunner(new NodeCommandRunner());
  const startedAt = new Date().toISOString();

  // Falla cerrado y con un mensaje util si no hay cluster real.
  const client = await counting
    .run("kubectl", ["version", "--client", "--output", "json"], {
      timeoutMs: config.commandTimeoutMs,
    })
    .catch((error: unknown) => {
      throw new Error(
        `kubectl no esta disponible: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  if (client.exitCode !== 0) {
    throw new Error(`kubectl no esta disponible: ${client.stderr.trim()}`);
  }
  const clusterInfo = await counting.run("kubectl", ["cluster-info"], {
    timeoutMs: config.commandTimeoutMs,
  });
  if (clusterInfo.exitCode !== 0) {
    throw new Error(
      `no hay cluster ${config.target} alcanzable: ${clusterInfo.stderr.trim()}. ` +
        "Crea uno con infra/kind/bootstrap.sh antes de pedir 6/6.",
    );
  }

  const memory = new MemoryState();
  const simulated = new SimulatedExecutor({ state: memory });
  const sandbox = new SandboxExecutor({
    config,
    fallback: simulated,
    runner: counting,
  });

  const cases: ContractCaseResult[] = [];
  const latest = GOOD_VERSIONS[GOOD_VERSIONS.length - 1] ?? "1.27.1";

  const reset = async (): Promise<void> => {
    // Setup de la suite: se fuerza el workload a un estado estable con kubectl
    // directo. El executor rechaza el rollback durante un rollout en curso a
    // proposito, asi que usarlo aqui impediria recuperarse de los casos 4 y 5.
    // Esto no relaja ninguna asercion: solo prepara el escenario.
    await kubectl(counting, config, [
      "patch",
      "deployment",
      SERVICE,
      "--type=merge",
      "-p",
      patchFor(latest),
    ]);
    await waitStable(counting, config);
  };

  await seedWorkload(counting, config);

  cases.push(
    await runCase("1", "rollback aplicado y readiness OK", async () => {
      await reset();
      const result = await sandbox.rollback({
        service: SERVICE,
        toVersion: "1.25.3",
        reason: "contrato 1",
        idempotencyKey: "contract:case1",
      });
      assert(result.status === "applied", `status ${result.status}`);
      assert(result.verified, "readiness no verificada");
      return { status: result.status, verified: result.verified, observed: result.observedState };
    }),
  );

  cases.push(
    await runCase("2", "version inexistente devuelve conflict", async () => {
      const before = await sandbox.rollback({
        service: SERVICE,
        toVersion: latest,
        reason: "reset",
        idempotencyKey: `reset:${Date.now()}`,
      });
      assert(before.status === "applied" || before.status === "noop", "reset fallo");
      const result = await sandbox.rollback({
        service: SERVICE,
        toVersion: "9.9.9",
        reason: "contrato 2",
        idempotencyKey: "contract:case2",
      });
      assert(result.status === "conflict", `status ${result.status}`);
      assert(result.observedState !== null, "sin estado observado");
      return { status: result.status, observed: result.observedState };
    }),
  );

  cases.push(
    await runCase("3", "misma key no reejecuta", async () => {
      await reset();
      const key = `contract:case3:${Date.now()}`;
      const undosBefore = counting.undoCommands;
      const first = await sandbox.rollback({
        service: SERVICE,
        toVersion: "1.25.3",
        reason: "contrato 3",
        idempotencyKey: key,
      });
      const undosAfterFirst = counting.undoCommands;
      const second = await sandbox.rollback({
        service: SERVICE,
        toVersion: "1.25.3",
        reason: "contrato 3",
        idempotencyKey: key,
      });
      assert(first.status === "applied", `primero ${first.status}`);
      assert(second.status === "noop", `segundo ${second.status}`);
      assert(first.effectId === second.effectId, "effect_id distinto");
      assert(
        counting.undoCommands === undosAfterFirst,
        `hubo ${counting.undoCommands - undosAfterFirst} rollouts extra`,
      );
      return {
        first: first.status,
        second: second.status,
        effect_id: first.effectId,
        undo_commands: undosAfterFirst - undosBefore,
      };
    }),
  );

  cases.push(
    await runCase("4", "timeout de readiness no es exito", async () => {
      await reset();
      const result = await sandbox.rollback({
        service: SERVICE,
        toVersion: BAD_VERSION,
        reason: "contrato 4",
        idempotencyKey: "contract:case4",
      });
      assert(result.status === "applied", `status ${result.status}`);
      assert(!result.verified, "se declaro verificado sin readiness");
      return {
        status: result.status,
        verified: result.verified,
        proposal_status: result.verified ? "applied" : "degraded",
        observed: result.observedState,
      };
    }),
  );

  cases.push(
    await runCase("5", "rollout en curso devuelve conflict reconciliable", async () => {
      await reset();
      // Provoca un rollout nuevo y pide el rollback antes de que termine.
      await kubectl(counting, config, [
        "patch",
        "deployment",
        SERVICE,
        "--type=merge",
        "-p",
        slowPatch("1.28.0"),
      ]);
      const during = await sandbox.rollback({
        service: SERVICE,
        toVersion: "1.25.3",
        reason: "contrato 5",
        idempotencyKey: "contract:case5",
      });
      assert(during.status === "conflict", `status ${during.status}`);
      await waitStable(counting, config);
      const after = await sandbox.rollback({
        service: SERVICE,
        toVersion: "1.25.3",
        reason: "contrato 5 reconciliado",
        idempotencyKey: "contract:case5:retry",
      });
      assert(after.status === "applied" || after.status === "noop", `retry ${after.status}`);
      assert(after.verified, "retry sin readiness");
      return { during: during.status, after: after.status, verified: after.verified };
    }),
  );

  cases.push(
    await runCase(
      "6",
      "flag aplicada y revertida deja estado coherente (simulada, fuera del sandbox)",
      async () => {
        const keyA = `contract:flag:on:${Date.now()}`;
        const keyB = `contract:flag:off:${Date.now()}`;
        const first = await sandbox.setFlag({
          flag: "checkout.new_flow",
          value: true,
          reason: "contrato 6",
          idempotencyKey: keyA,
        });
        const second = await sandbox.setFlag({
          flag: "checkout.new_flow",
          value: false,
          reason: "contrato 6",
          idempotencyKey: keyB,
        });
        assert(first.status === "applied" && first.verified, "flag on no aplicada");
        assert(second.status === "applied" && second.verified, "flag off no aplicada");
        assert(
          first.evidence[0]?.includes("fuera del sandbox"),
          "el caso 6 no se declaro simulado",
        );
        const observed = second.observedState as Record<string, unknown>;
        assert(observed.value === "false", `estado final ${String(observed.value)}`);
        return { status: second.status, observed, simulated: true };
      },
      { simulated: true },
    ),
  );

  const passed = cases.filter((item) => item.passed).length;
  const report: ContractReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: config.target,
    namespace: config.namespace,
    cases,
    passed,
    total: cases.length,
    note:
      "Casos 1-5 usan kubectl real. El caso 6 (flag) es simulado porque el " +
      "SandboxExecutor solo cubre rollback; la evidencia lo etiqueta.",
  };

  const artifactsDir = env.SANDBOX_CONTRACT_ARTIFACTS ?? "artifacts";
  const file = `${artifactsDir}/sandbox-contract-${report.startedAt.replaceAll(":", "-")}.json`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return report;
}
