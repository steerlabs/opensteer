import { type ModelSelection, type ThreadAccessMode } from "@opensteer/core";

/**
 * Readers of the person's remembered choices, as the Host keeps them
 * (`ExecutionPreferences` in `@opensteer/core`). The history is most recent
 * first, so every question here is answered by the first entry that matches.
 * Nothing is stored on this side: the snapshot carries the Host's record and
 * `HostClient.rememberExecution` is the only writer.
 *
 * Ids are plain strings here, as they are everywhere in this client's view
 * model: a placement's work location and account come from the Host's own
 * bootstrap, and re-parsing them into branded ids on the way back out would
 * assert something the projection never claimed. The Host re-validates every
 * one of them anyway.
 */
export interface ExecutionSelection {
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly modelSelection: ModelSelection;
}

/** An explicit choice a person just made: either half may be absent, never both. */
export interface ExecutionChoice {
  readonly accessMode?: ThreadAccessMode;
  readonly selection?: ExecutionSelection;
}

/** What the readers here need of a preferences record: its history, newest first. */
export interface ExecutionHistory {
  readonly history: readonly ExecutionSelection[];
}

/** The selection a new Thread starts from, or null when nothing was ever chosen. */
export function lastExecutionSelection(preferences: ExecutionHistory): ExecutionSelection | null {
  return preferences.history[0] ?? null;
}
