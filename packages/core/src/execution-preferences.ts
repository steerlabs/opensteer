import { z } from "zod";
import { EnvironmentIdSchema, HarnessInstanceIdSchema } from "./ids.js";
import {
  DEFAULT_THREAD_ACCESS_MODE,
  ModelSelectionSchema,
  ModelSelectionViewSchema,
  ThreadAccessModeSchema,
  type ThreadAccessMode,
} from "./models.js";

/**
 * A complete execution choice: where work runs, which account of which engine
 * runs it, and which model with which options. The account fixes the engine
 * and the source, so nothing about how a Thread would run is left implied.
 */
const executionSelectionShape = {
  environmentId: EnvironmentIdSchema,
  harnessInstanceId: HarnessInstanceIdSchema,
  modelSelection: ModelSelectionSchema,
} as const;
export const ExecutionSelectionSchema = z.strictObject(executionSelectionShape);
export const ExecutionSelectionViewSchema = z.object({
  ...executionSelectionShape,
  modelSelection: ModelSelectionViewSchema,
});
export type ExecutionSelection = z.infer<typeof ExecutionSelectionSchema>;

/** How many distinct execution choices a person's history keeps. */
export const executionHistoryLimit = 64;

/**
 * What one person chose last, kept by the Host for that person in this
 * Deployment so every app they open starts from the same place.
 *
 * `history` is most recent first and holds one entry per distinct choice
 * (work location, account, model): the first entry is the selection a new
 * Thread starts from; the first entry naming a model is the account that
 * model lands on when picked; the first entry naming a model on an account
 * carries the option values that model comes back with there. Everything
 * here is a hint about intent, re-validated against live catalogs at the
 * moment it is used — it never bypasses the Host's checks on a Thread.
 */
const executionPreferencesShape = {
  /** The access mode a new Thread starts in. */
  accessMode: ThreadAccessModeSchema,
  history: z.array(ExecutionSelectionSchema).max(executionHistoryLimit),
} as const;
export const ExecutionPreferencesSchema = z.strictObject(executionPreferencesShape);
export const ExecutionPreferencesViewSchema = z.object({
  ...executionPreferencesShape,
  history: z.array(ExecutionSelectionViewSchema).max(executionHistoryLimit),
});
export type ExecutionPreferences = z.infer<typeof ExecutionPreferencesSchema>;

export const emptyExecutionPreferences: ExecutionPreferences = {
  accessMode: DEFAULT_THREAD_ACCESS_MODE,
  history: [],
};

/** An explicit choice a person just made: either half may be absent, never both. */
export interface ExecutionChoice {
  readonly accessMode?: ThreadAccessMode;
  readonly selection?: ExecutionSelection;
}

export function sameExecutionChoice(left: ExecutionSelection, right: ExecutionSelection): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.harnessInstanceId === right.harnessInstanceId &&
    left.modelSelection.providerId === right.modelSelection.providerId &&
    left.modelSelection.modelId === right.modelSelection.modelId
  );
}

/**
 * The one rule for folding a choice into the preferences: a selection moves to
 * the front of the history, replacing any earlier entry for the same choice so
 * the newest option values win, and the tail is trimmed to the limit. An
 * access mode simply replaces the remembered one.
 */
export function rememberExecutionChoice(
  preferences: ExecutionPreferences,
  choice: ExecutionChoice,
): ExecutionPreferences {
  const history = choice.selection
    ? [
        choice.selection,
        ...preferences.history.filter((entry) => !sameExecutionChoice(entry, choice.selection!)),
      ].slice(0, executionHistoryLimit)
    : preferences.history;
  return { accessMode: choice.accessMode ?? preferences.accessMode, history };
}
