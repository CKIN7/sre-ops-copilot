import { spawn } from "node:child_process";

/**
 * Ejecucion de comandos externos con timeout, aislada tras un puerto para que el
 * `SandboxExecutor` se pueda probar sin cluster ni kubectl (ADR-015).
 */
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** `true` si se agoto el timeout y el proceso se mato. */
  timedOut: boolean;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<CommandResult>;
}

/**
 * Runner de produccion. No usa shell: los argumentos van como array, asi que un
 * nombre de servicio no puede inyectar comandos.
 */
export class NodeCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: readonly string[],
    options: { timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timeoutMs = options.timeoutMs;
      const timer =
        timeoutMs === undefined
          ? null
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        reject(error);
      });
      child.on("close", (exitCode) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve({ exitCode, stdout, stderr, timedOut });
      });
    });
  }
}
