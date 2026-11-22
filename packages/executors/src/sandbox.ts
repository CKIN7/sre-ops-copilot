import { effectIdFromKey } from "@beacon/core/domain/idempotency";
import type {
  ActionExecutor,
  ActionResult,
  FlagCommand,
  RollbackCommand,
  SilenceCommand,
} from "@beacon/core/ports/action-executor";

import { NodeCommandRunner, type CommandResult, type CommandRunner } from "./command.js";
import {
  assertSandboxSupported,
  type SandboxConfig,
} from "./sandbox-config.js";

/** Nombre del ejecutor: queda en la fila del efecto y en el audit. */
export const SANDBOX_EXECUTOR_NAME = "sandbox";

const VERSION_ANNOTATION = "beacon.io/version";

export interface SandboxExecutorOptions {
  config: SandboxConfig;
  /** `set_flag` y `silence_alert` quedan fuera del sandbox: se delegan y se dice. */
  fallback: ActionExecutor;
  /** Inyectable en tests; por defecto ejecuta kubectl sin shell. */
  runner?: CommandRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Container {
  name: string;
  image: string;
}

interface PodTemplate {
  metadata?: { annotations?: Record<string, string> };
  spec?: { containers?: Container[] };
}

interface K8sDeployment {
  metadata?: {
    name?: string;
    generation?: number;
    annotations?: Record<string, string>;
  };
  spec?: { replicas?: number; template?: PodTemplate };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    unavailableReplicas?: number;
    conditions?: Array<{ type?: string; status?: string; reason?: string }>;
  };
}

interface K8sReplicaSet {
  metadata?: {
    name?: string;
    annotations?: Record<string, string>;
  };
  spec?: { template?: PodTemplate };
}

interface K8sList<T> {
  items?: T[];
}

interface ObservedDeployment {
  name: string;
  version: string | null;
  generation: number;
  desired: number;
  updated: number;
  ready: number;
  available: number;
  unavailable: number;
  rolloutInProgress: boolean;
  readyAndStable: boolean;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function imageVersion(image: string): string | null {
  // `registry:5000/beacon/checkout:1.41.0` -> `1.41.0`; sin tag, `null`.
  const lastSlash = image.lastIndexOf("/");
  const tail = lastSlash >= 0 ? image.slice(lastSlash + 1) : image;
  const colon = tail.lastIndexOf(":");
  if (colon < 0) {
    return null;
  }
  const tag = tail.slice(colon + 1);
  return tag.length > 0 && tag !== "latest" ? tag : null;
}

function templateVersion(template: PodTemplate | undefined): string | null {
  const annotated = template?.metadata?.annotations?.[VERSION_ANNOTATION];
  if (annotated && annotated.length > 0) {
    return annotated;
  }
  const image = template?.spec?.containers?.[0]?.image;
  return image ? imageVersion(image) : null;
}

function observe(raw: K8sDeployment): ObservedDeployment {
  const status = raw.status ?? {};
  const desired = raw.spec?.replicas ?? 1;
  const generation = raw.metadata?.generation ?? 0;
  const observedGeneration = status.observedGeneration ?? 0;
  const updated = status.updatedReplicas ?? 0;
  const ready = status.readyReplicas ?? 0;
  const available = status.availableReplicas ?? 0;
  const unavailable = status.unavailableReplicas ?? 0;
  const progressing = (status.conditions ?? []).some(
    (condition) =>
      condition.type === "Progressing" &&
      condition.status === "True" &&
      condition.reason === "ReplicaSetUpdated",
  );
  const rolloutInProgress =
    desired > 0 &&
    (observedGeneration < generation ||
      updated < desired ||
      unavailable > 0 ||
      progressing);

  return {
    name: raw.metadata?.name ?? "",
    version: templateVersion(raw.spec?.template),
    generation,
    desired,
    updated,
    ready,
    available,
    unavailable,
    rolloutInProgress,
    readyAndStable:
      desired > 0 &&
      observedGeneration >= generation &&
      updated === desired &&
      ready === desired &&
      available === desired &&
      unavailable === 0,
  };
}

function stateOf(observed: ObservedDeployment | null): Record<string, unknown> | null {
  if (!observed) {
    return null;
  }
  return {
    deployment: observed.name,
    version: observed.version,
    desired_replicas: observed.desired,
    updated_replicas: observed.updated,
    ready_replicas: observed.ready,
    available_replicas: observed.available,
    rollout_in_progress: observed.rolloutInProgress,
  };
}

/**
 * `SandboxExecutor` real (docs/plan.md §6.2 y §8.6, ADR-015).
 *
 * **Cubre el rollback** contra un cluster de `kind`/k3s con `kubectl rollout undo`.
 * `set_flag` y `silence_alert` **no** tocan el cluster: se delegan al ejecutor
 * simulado y la evidencia lo dice de forma explicita. Presentarlo como un executor
 * completo seria mentir; el contrato de §8.6 lo deja escrito.
 *
 * La semantica de §6.3 se mantiene:
 *
 * - `effect_id` estable por `idempotency_key` (se deriva de la clave).
 * - Si la version pedida no existe en el historial de ReplicaSets: `conflict` con el
 *   estado observado, sin inventar una revision.
 * - Si hay un rollout en curso: `conflict`; se reconcilia esperando, no reintentando
 *   a ciegas.
 * - Si el rollout se aplica pero la readiness no llega en `READINESS_TIMEOUT`: se
 *   devuelve `applied` con `verified=false`; la politica lo convierte en `degraded`.
 *   No se usa `timeout` porque el resultado de la escritura si se conoce.
 * - Si el comando de kubectl agota su timeout: `timeout` con el estado **consultado**.
 */
export class SandboxExecutor implements ActionExecutor {
  readonly #config: SandboxConfig;
  readonly #fallback: ActionExecutor;
  readonly #runner: CommandRunner;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: SandboxExecutorOptions) {
    assertSandboxSupported(options.config);
    this.#config = options.config;
    this.#fallback = options.fallback;
    this.#runner = options.runner ?? new NodeCommandRunner();
    this.#now = options.now ?? (() => Date.now());
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async rollback(command: RollbackCommand): Promise<ActionResult> {
    const startedAt = this.#now();
    const effectId = effectIdFromKey(command.idempotencyKey);
    const durationMs = (): number => Math.max(0, this.#now() - startedAt);
    const baseEvidence = [`rollback de ${command.service} a ${command.toVersion}`];

    if (command.service.trim().length === 0 || command.toVersion.trim().length === 0) {
      return {
        effectId,
        status: "conflict",
        observedState: null,
        verified: false,
        durationMs: durationMs(),
        evidence: ["servicio o version vacios: no se ejecuto kubectl", ...baseEvidence],
      };
    }

    const before = await this.#readDeployment(command.service);
    if (!before) {
      return {
        effectId,
        status: "conflict",
        observedState: null,
        verified: false,
        durationMs: durationMs(),
        evidence: [
          `deployment ${command.service} no existe en ${this.#config.namespace}`,
          ...baseEvidence,
        ],
      };
    }

    // Retry/no-op: el estado ya es el pedido. No se vuelve a ejecutar kubectl.
    if (before.version === command.toVersion && before.readyAndStable) {
      return {
        effectId,
        status: "noop",
        observedState: stateOf(before),
        verified: true,
        durationMs: durationMs(),
        evidence: [
          "el deployment ya estaba en la version pedida; no se ejecuto un segundo rollback",
          ...baseEvidence,
        ],
      };
    }

    if (before.rolloutInProgress) {
      return {
        effectId,
        status: "conflict",
        observedState: stateOf(before),
        verified: false,
        durationMs: durationMs(),
        evidence: [
          "hay un rollout en curso: hay que reconciliar y esperar, no reintentar a ciegas",
          ...baseEvidence,
        ],
      };
    }

    const revision = await this.#resolveRevision(command.service, command.toVersion);
    if (revision === null) {
      return {
        effectId,
        status: "conflict",
        observedState: stateOf(before),
        verified: false,
        durationMs: durationMs(),
        evidence: [
          `la version ${command.toVersion} no existe en el historial de ${command.service}`,
          ...baseEvidence,
        ],
      };
    }

    const undo = await this.#kubectl(
      [
        "rollout",
        "undo",
        `deployment/${command.service}`,
        `--to-revision=${revision}`,
      ],
      this.#config.commandTimeoutMs,
    );

    if (undo.timedOut) {
      const observed = await this.#readDeployment(command.service);
      return {
        effectId,
        status: "timeout",
        observedState: stateOf(observed),
        verified: false,
        durationMs: durationMs(),
        evidence: [
          "kubectl rollout undo agoto el timeout; el estado se consulto en vez de asumir que no se aplico",
          ...baseEvidence,
        ],
      };
    }

    if (undo.exitCode !== 0) {
      const observed = await this.#readDeployment(command.service);
      return {
        effectId,
        status: "conflict",
        observedState: stateOf(observed),
        verified: false,
        durationMs: durationMs(),
        evidence: [
          `kubectl rechazo el rollback (exit ${String(undo.exitCode)}): ${undo.stderr.trim() || "sin stderr"}`,
          ...baseEvidence,
        ],
      };
    }

    const ready = await this.#waitForReadiness(command.service, command.toVersion);
    if (!ready.verified) {
      return {
        effectId,
        status: "applied",
        observedState: stateOf(ready.observed),
        verified: false,
        durationMs: durationMs(),
        evidence: [
          `la escritura se aplico pero la readiness no llego en ${this.#config.readinessTimeoutMs}ms: degraded, no exito`,
          ...baseEvidence,
        ],
      };
    }

    return {
      effectId,
      status: "applied",
      observedState: stateOf(ready.observed),
      verified: true,
      durationMs: durationMs(),
      evidence: [
        `readiness verificada: ${command.service} sirve la version ${command.toVersion}`,
        ...baseEvidence,
      ],
    };
  }

  async setFlag(command: FlagCommand): Promise<ActionResult> {
    const result = await this.#fallback.setFlag(command);
    return {
      ...result,
      evidence: [
        "set_flag queda fuera del sandbox: delegado al ejecutor simulado (estado en Postgres)",
        ...result.evidence,
      ],
    };
  }

  async silenceAlert(command: SilenceCommand): Promise<ActionResult> {
    const result = await this.#fallback.silenceAlert(command);
    return {
      ...result,
      evidence: [
        "silence_alert queda fuera del sandbox: delegado al ejecutor simulado (estado en Postgres)",
        ...result.evidence,
      ],
    };
  }

  async #readDeployment(service: string): Promise<ObservedDeployment | null> {
    const result = await this.#kubectl(
      ["get", "deployment", service, "-o", "json"],
      this.#config.commandTimeoutMs,
    );
    if (result.exitCode !== 0) {
      if (/NotFound|not found/i.test(result.stderr)) {
        return null;
      }
      throw new Error(
        `kubectl get deployment ${service} fallo: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
      );
    }
    const parsed = parseJson<K8sDeployment>(result.stdout);
    if (!parsed) {
      throw new Error(`kubectl devolvio un deployment ilegible para ${service}`);
    }
    return observe(parsed);
  }

  /** Revision del ReplicaSet cuya version coincide con `toVersion`. */
  async #resolveRevision(service: string, toVersion: string): Promise<number | null> {
    const result = await this.#kubectl(
      ["get", "replicasets", "-o", "json"],
      this.#config.commandTimeoutMs,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `kubectl get replicasets fallo: ${result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
      );
    }
    const parsed = parseJson<K8sList<K8sReplicaSet>>(result.stdout);
    if (!parsed) {
      throw new Error("kubectl devolvio una lista de ReplicaSets ilegible");
    }

    let best: number | null = null;
    for (const item of parsed.items ?? []) {
      const name = item.metadata?.name ?? "";
      if (!name.startsWith(`${service}-`)) {
        continue;
      }
      if (templateVersion(item.spec?.template) !== toVersion) {
        continue;
      }
      const revision = Number(
        item.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? "",
      );
      if (!Number.isInteger(revision) || revision <= 0) {
        continue;
      }
      if (best === null || revision > best) {
        best = revision;
      }
    }
    return best;
  }

  async #waitForReadiness(
    service: string,
    toVersion: string,
  ): Promise<{ verified: boolean; observed: ObservedDeployment | null }> {
    const deadline = this.#now() + this.#config.readinessTimeoutMs;
    let observed = await this.#readDeployment(service);

    while (true) {
      if (observed && observed.version === toVersion && observed.readyAndStable) {
        return { verified: true, observed };
      }
      if (this.#now() >= deadline) {
        return { verified: false, observed };
      }
      await this.#sleep(this.#config.pollIntervalMs);
      observed = await this.#readDeployment(service);
    }
  }

  async #kubectl(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    const identity: string[] = ["--namespace", this.#config.namespace];
    if (this.#config.context) {
      identity.push("--context", this.#config.context);
    }
    if (this.#config.kubeconfig) {
      identity.push("--kubeconfig", this.#config.kubeconfig);
    }
    return this.#runner.run("kubectl", [...args, ...identity], { timeoutMs });
  }
}

/**
 * Comprobacion de arranque del sandbox: kubectl presente y contexto alcanzable.
 * Devuelve un error legible en vez de dejar que el primer rollback lo descubra.
 */
export async function checkSandboxAvailable(
  config: SandboxConfig,
  runner: CommandRunner,
): Promise<void> {
  assertSandboxSupported(config);
  const args = ["version", "--client", "--output", "json"];
  if (config.kubeconfig) {
    args.push("--kubeconfig", config.kubeconfig);
  }
  const client = await runner.run("kubectl", args, {
    timeoutMs: config.commandTimeoutMs,
  });
  if (client.exitCode !== 0) {
    throw new Error(`kubectl no esta disponible: ${client.stderr.trim()}`);
  }
  const clusterArgs = ["cluster-info"];
  if (config.context) {
    clusterArgs.push("--context", config.context);
  }
  if (config.kubeconfig) {
    clusterArgs.push("--kubeconfig", config.kubeconfig);
  }
  const cluster = await runner.run("kubectl", clusterArgs, {
    timeoutMs: config.commandTimeoutMs,
  });
  if (cluster.exitCode !== 0) {
    throw new Error(
      `no hay cluster alcanzable (${config.target}): ${cluster.stderr.trim()}`,
    );
  }
}
