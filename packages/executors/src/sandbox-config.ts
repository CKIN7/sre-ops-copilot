/**
 * Configuracion del `SandboxExecutor` (docs/plan.md §6.2, ADR-005 y ADR-015).
 *
 * Se valida al arrancar y falla cerrado: un valor desconocido o una unidad que no
 * existe impide crear el ejecutor. Es preferible no arrancar a ejecutar un rollback
 * con un timeout que nadie pretendia.
 */

export const SANDBOX_TARGETS = ["kind", "compose"] as const;
export type SandboxTarget = (typeof SANDBOX_TARGETS)[number];

export const EXECUTOR_NAMES = ["simulated", "sandbox"] as const;
export type ExecutorName = (typeof EXECUTOR_NAMES)[number];

export interface SandboxConfig {
  /** Objetivo declarado. Hoy solo `kind` tiene adaptador real (k3s usa el mismo kubectl). */
  target: SandboxTarget;
  /** Namespace del workload sembrado. */
  namespace: string;
  /** Contexto de kubeconfig; `null` usa el contexto activo. */
  context: string | null;
  /** Ruta a kubeconfig; `null` usa `$KUBECONFIG` o el default. */
  kubeconfig: string | null;
  /** Espera maxima de readiness tras el rollback. */
  readinessTimeoutMs: number;
  /** Intervalo de sondeo de readiness. */
  pollIntervalMs: number;
  /** Timeout de cada comando de kubectl. */
  commandTimeoutMs: number;
}

const DURATION = /^([1-9][0-9]{0,5})(ms|s|m)$/;

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000 } as const;

/** Convierte `30s`, `2m` o `500ms` a milisegundos. */
export function parseDurationMs(raw: string, name = "duration"): number {
  const match = DURATION.exec(raw.trim());
  if (!match) {
    throw new Error(`${name} invalido: "${raw}" (esperado <n>ms|<n>s|<n>m)`);
  }
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_MS;
  return amount * UNIT_MS[unit];
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Lee la configuracion del entorno. `EXECUTOR` lo valida ademas la API; aqui solo se
 * valida la parte del sandbox para que el ejecutor se pueda construir en tests.
 */
export function parseSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const target = (env.SANDBOX_TARGET ?? "kind").trim();
  if (!(SANDBOX_TARGETS as readonly string[]).includes(target)) {
    throw new Error(
      `SANDBOX_TARGET invalido: "${target}" (esperado ${SANDBOX_TARGETS.join("|")})`,
    );
  }

  const namespace = nonEmpty(env.SANDBOX_NAMESPACE) ?? "beacon-sandbox";

  const readinessRaw = nonEmpty(env.READINESS_TIMEOUT) ?? "30s";
  const readinessTimeoutMs = parseDurationMs(readinessRaw, "READINESS_TIMEOUT");
  if (readinessTimeoutMs < 1_000 || readinessTimeoutMs > 600_000) {
    throw new Error("READINESS_TIMEOUT debe estar entre 1s y 10m");
  }

  const pollRaw = nonEmpty(env.SANDBOX_POLL_INTERVAL) ?? "2s";
  const pollIntervalMs = parseDurationMs(pollRaw, "SANDBOX_POLL_INTERVAL");
  if (pollIntervalMs < 100 || pollIntervalMs > readinessTimeoutMs) {
    throw new Error("SANDBOX_POLL_INTERVAL debe estar entre 100ms y READINESS_TIMEOUT");
  }

  const commandRaw = nonEmpty(env.SANDBOX_COMMAND_TIMEOUT) ?? "60s";
  const commandTimeoutMs = parseDurationMs(commandRaw, "SANDBOX_COMMAND_TIMEOUT");
  if (commandTimeoutMs < 1_000 || commandTimeoutMs > 900_000) {
    throw new Error("SANDBOX_COMMAND_TIMEOUT debe estar entre 1s y 15m");
  }

  return {
    target: target as SandboxTarget,
    namespace,
    context: nonEmpty(env.SANDBOX_CONTEXT),
    kubeconfig: nonEmpty(env.SANDBOX_KUBECONFIG),
    readinessTimeoutMs,
    pollIntervalMs,
    commandTimeoutMs,
  };
}

/**
 * Un `compose` real exige otro adaptador (no kubectl). Hasta que exista una medicion
 * contra compose, el ejecutor falla cerrado en vez de fingir que hace el rollback.
 */
export function assertSandboxSupported(config: SandboxConfig): void {
  if (config.target === "compose") {
    throw new Error(
      "SANDBOX_TARGET=compose no tiene adaptador real todavia; " +
        "usa kind (o k3s con kubectl) o EXECUTOR=simulated",
    );
  }
}
