import type { PersonalCommitReaction } from "@opensteer/database/personal-mutation";
import type { RunId, TeamStatusStepKindSchema } from "@opensteer/core";
import type { z } from "zod";

type StepKind = z.infer<typeof TeamStatusStepKindSchema>;
type Step = { readonly kind: StepKind; readonly count: number };
interface RunChanges {
  readonly counts: Map<StepKind, number>;
  dirty: boolean;
  terminal: boolean;
  sending: Promise<void> | null;
}

export class TeamRunEvents {
  readonly #runs = new Map<RunId, RunChanges>();
  readonly #publish: (runId: RunId, steps: readonly Step[]) => Promise<void>;
  readonly #onError: () => void;
  #closed = false;

  constructor(options: {
    readonly publish: (runId: RunId, steps: readonly Step[]) => Promise<void>;
    readonly onError: () => void;
  }) {
    this.#publish = options.publish;
    this.#onError = options.onError;
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
    run.sending ??= this.#drain(runId, run).finally(() => {
      run.sending = null;
      if (run.dirty) this.#schedule(runId, run);
      else if (run.terminal) this.#runs.delete(runId);
    });
  }

  async #drain(runId: RunId, run: RunChanges): Promise<void> {
    while (run.dirty) {
      run.dirty = false;
      try {
        await this.#publish(
          runId,
          [...run.counts].map(([kind, count]) => ({ kind, count })),
        );
      } catch {
        this.#onError();
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    while ([...this.#runs.values()].some((run) => run.sending !== null))
      await Promise.all([...this.#runs.values()].map((run) => run.sending));
    this.#runs.clear();
  }
}

function stepKind(name: string, isIntegration: boolean): StepKind | null {
  if (isIntegration) return "used_integration";
  if (/^browser(?:_|$)/u.test(name)) return "browsed";
  if (name === "opensteer_team_read" || name === "opensteer_team_search") return "searched_team";
  if (/^(?:computer_use|integration_call)$/u.test(name)) return "used_integration";
  if (/^(?:Bash|PowerShell|exec_command|shell|shell_run|run_command|execute)$/u.test(name))
    return "ran_commands";
  if (/^(?:Read|read_file|read|Glob|Grep|glob|grep)$/u.test(name)) return "read_files";
  if (/^(?:Write|Edit|MultiEdit|write_file|edit_file|apply_patch)$/u.test(name))
    return "edited_files";
  return null;
}
