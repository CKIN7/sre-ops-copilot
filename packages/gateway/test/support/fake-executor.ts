import type {
  ActionExecutor,
  ActionResult,
  FlagCommand,
  RollbackCommand,
  SilenceCommand,
} from "@beacon/core/ports/action-executor";

/**
 * Executor falso para los tests del gateway.
 *
 * `result` fija lo que devuelve; `calls` cuenta cuántas veces se ejecutó, que es
 * lo que demuestra que un rettento **no** vuelve a escribir.
 */
export class FakeExecutor implements ActionExecutor {
  readonly calls: Array<
    | { kind: "rollback"; command: RollbackCommand }
    | { kind: "set_flag"; command: FlagCommand }
    | { kind: "silence_alert"; command: SilenceCommand }
  > = [];

  result: ActionResult = {
    effectId: "eff_fake",
    status: "applied",
    observedState: { version: "v2.3.3" },
    verified: true,
    durationMs: 12,
    evidence: ["post-condicion verificada"],
  };

  /** Si es `true`, el executor lanza. */
  throws: Error | null = null;

  async rollback(command: RollbackCommand): Promise<ActionResult> {
    this.calls.push({ kind: "rollback", command });
    return this.#outcome();
  }

  async setFlag(command: FlagCommand): Promise<ActionResult> {
    this.calls.push({ kind: "set_flag", command });
    return this.#outcome();
  }

  async silenceAlert(command: SilenceCommand): Promise<ActionResult> {
    this.calls.push({ kind: "silence_alert", command });
    return this.#outcome();
  }

  #outcome(): ActionResult {
    if (this.throws) {
      throw this.throws;
    }
    return this.result;
  }
}
