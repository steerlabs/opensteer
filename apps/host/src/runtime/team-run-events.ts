import type { PersonalCommitReaction } from "@opensteer/database/personal-mutation";
import type { RunId, TeamStatusStepKindSchema } from "@opensteer/core";
import type { z } from "zod";
import { systemClock, type Clock } from "@opensteer/shared/clock";

const retryFloorMs = 1_000;
const retryCeilingMs = 5 * 60_000;

type StepKind = z.infer<typeof TeamStatusStepKindSchema>;
type Step = { readonly kind: StepKind; readonly count: number };
interface RunChanges {
  readonly counts: Map<StepKind, number>;
  dirty: boolean;
  terminal: boolean;
  sending: Promise<void> | null;
  /** A terminal publication not yet recorded as delivered: owed, with its next retry. */
  owed: boolean;
  retryMs: number;
  cancelRetry: (() => void) | undefined;
}

type TeamRunPublish = (runId: RunId, steps: readonly Step[]) => Promise<"pending" | void>;

export class TeamRunEvents {
  readonly #runs = new Map<RunId, RunChanges>();
  readonly #publish: TeamRunPublish;
  readonly #onError: () => void;
  readonly #clock: Clock;
  #closed = false;

  constructor(options: {
    /**
     * Publishes the Run's state. For a finished Run it answers "pending" while
     * the team request has not recorded its terminal state (a timed-out call on
     * a healthy link); that Run stays owed and is retried with backoff until it
     * is recorded or the link removes the request.
     */
    readonly publish: TeamRunPublish;
    readonly onError: () => void;
    readonly clock?: Clock;
  }) {
    this.#publish = options.publish;
    this.#onError = options.onError;
    this.#clock = options.clock ?? systemClock;
  }

  observe(
    change:
      | Extract<PersonalCommitReaction, { type: "requestChanged" | "runFinished" | "teamStep" }>
      | { readonly type: "runChanged"; readonly runId: RunId },
  ): void {
    if (this.#closed || !change.runId) return;
    const runId = change.runId;
    const run = this.#runs.get(runId) ?? {
      counts: new Map<StepKind, number>(),
      dirty: false,
      terminal: false,
      sending: null,
      owed: false,
      retryMs: retryFloorMs,
      cancelRetry: undefined,
    };
    this.#runs.set(runId, run);
    const kind =
      change.type === "requestChanged" && change.opened
        ? "asked_you"
        : change.type === "teamStep"
          ? stepKind(change.toolName, change.isIntegration)
          : null;
    if (kind)
      run.counts.set(kind, Math.min(Number.MAX_SAFE_INTEGER, (run.counts.get(kind) ?? 0) + 1));
    run.terminal ||= change.type === "runFinished";
    run.dirty = true;
    this.#schedule(runId, run);
  }

  #schedule(runId: RunId, run: RunChanges): void {
    run.cancelRetry?.();
    run.cancelRetry = undefined;
    run.sending ??= this.#drain(runId, run).finally(() => {
      run.sending = null;
      if (this.#closed) return;
      if (run.dirty) this.#schedule(runId, run);
      else if (run.terminal && run.owed) {
        run.cancelRetry = this.#clock.schedule(() => {
          run.cancelRetry = undefined;
          run.dirty = true;
          this.#schedule(runId, run);
        }, run.retryMs);
        run.retryMs = Math.min(run.retryMs * 2, retryCeilingMs);
      } else if (run.terminal) this.#runs.delete(runId);
    });
  }

  async #drain(runId: RunId, run: RunChanges): Promise<void> {
    while (run.dirty) {
      run.dirty = false;
      let delivered = true;
      try {
        delivered =
          (await this.#publish(
            runId,
            [...run.counts].map(([kind, count]) => ({ kind, count })),
          )) !== "pending";
      } catch {
        delivered = false;
        this.#onError();
      }
      run.owed = run.terminal && !delivered;
      if (!run.owed) run.retryMs = retryFloorMs;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const run of this.#runs.values()) run.cancelRetry?.();
    while ([...this.#runs.values()].some((run) => run.sending !== null))
      await Promise.all([...this.#runs.values()].map((run) => run.sending));
    this.#runs.clear();
  }
}

function stepKind(name: string, isIntegration: boolean): StepKind | null {
  if (isIntegration) return "used_integration";
  if (/^browser(?:_|$)/u.test(name)) return "browsed";
  if (name === "opensteer_team_read" || name === "opensteer_team_search") return "searched_team";
  if (name === "computer_use") return "used_integration";
  if (/^(?:Bash|PowerShell|exec_command|shell|shell_run|run_command|execute)$/u.test(name))
    return "ran_commands";
  if (/^(?:Read|read_file|read|Glob|Grep|glob|grep)$/u.test(name)) return "read_files";
  if (/^(?:Write|Edit|MultiEdit|write_file|edit_file|apply_patch)$/u.test(name))
    return "edited_files";
  return null;
}
