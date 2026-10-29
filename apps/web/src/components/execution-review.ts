import type { ThreadAccessMode } from "@opensteer/core";
import {
  accessModeOptions,
  canContinueThreadOnPlacement,
  placementAccountTitle,
  type ExecutionSelection,
  type HostClient,
  type RunQueueEntry,
  type ThreadPlacementOption,
  type ThreadSummary,
} from "@opensteer/client/host";

/** What the reader agreed to when a session-ending choice was applied. */
export interface ReviewedContinuation {
  readonly expectedProviderSessionId: string | null;
  /** True when the reviewed choice was starting the same AI over again. */
  readonly fresh: boolean;
}

/** Everything a review settled before its choice is applied. */
export interface ReviewedChoice {
  /** Present when the choice ends the session the reader was looking at. */
  readonly continuation?: ReviewedContinuation;
  /**
   * Present when the engine cannot keep the conversation's access mode: the
   * mode the reader chose for it, applied before the engine changes.
   */
  readonly accessMode?: ThreadAccessMode;
}

/**
 * The target engine cannot keep the conversation's access mode. The Host keeps
 * a Thread's mode across a change of engine and refuses an engine that cannot
 * enforce it, so the reader picks one of the modes the engine can before the
 * change is applied — never one chosen for them.
 */
export interface AccessChange {
  readonly current: ThreadAccessMode;
  /** The modes the target engine enforces, in the order the product lists them. */
  readonly offered: readonly ThreadAccessMode[];
}

/**
 * What choosing an AI for a conversation would actually do, decided before
 * anything is applied.
 *
 * `unavailable` and `incompatible` are deliberately separate: one is "this
 * cannot run", the other is "this runs, and starts fresh". `fresh` is the same
 * consequence asked for deliberately on the AI already in use.
 */
export type ExecutionSwitchReview =
  | { readonly kind: "compatible" }
  | {
      /** The session continues; only the access mode has to change first. */
      readonly kind: "access";
      readonly access: AccessChange;
      readonly engineName: string;
    }
  | {
      readonly kind: "fresh" | "incompatible";
      /** Present when the engine it lands on cannot keep the conversation's access mode. */
      readonly access: AccessChange | null;
      /** The engine the conversation would start fresh on, as the reader knows it. */
      readonly engineName: string;
      /** The account behind that engine, so two accounts are never confused. */
      readonly accountName: string;
      /** The session the reader reviewed, sent back so a raced switch is refused. */
      readonly expectedProviderSessionId: string | null;
      /** The engine the conversation is on now, named by the Keep action. */
      readonly currentEngineName: string;
    }
  | { readonly kind: "busy"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly detail: string };

/** Why a change cannot be applied while the conversation is working. */
const busyReason = "Let this response finish, or stop it, and then choose.";

/**
 * A Run that has not reached a terminal state blocks every change, not only
 * one that would end the session: the Host refuses any execution change while
 * a Thread has work in its queue, admission-queued work included.
 */
function nonterminalRun(runQueue: readonly RunQueueEntry[], threadId: string): boolean {
  return runQueue.some((run) => run.threadId === threadId);
}

function accessChange(
  current: ThreadAccessMode,
  target: Pick<ThreadPlacementOption, "accessModes">,
): AccessChange | null {
  const enforced = target.accessModes;
  if (enforced === null || enforced.includes(current)) return null;
  return {
    current,
    offered: accessModeOptions.map(({ mode }) => mode).filter((mode) => enforced.includes(mode)),
  };
}

export function reviewExecutionSwitch(input: {
  readonly placements: readonly ThreadPlacementOption[];
  readonly runQueue: readonly RunQueueEntry[];
  readonly selection: ExecutionSelection;
  readonly thread: Pick<
    ThreadSummary,
    "accessMode" | "continuationIdentity" | "harnessInstanceId" | "id" | "providerSessionId"
  >;
}): ExecutionSwitchReview {
  const { placements, runQueue, selection, thread } = input;
  const target = placements.find(
    (placement) =>
      placement.environmentId === selection.environmentId &&
      placement.harnessInstanceId === selection.harnessInstanceId,
  );
  if (!target) {
    return { detail: "This AI is no longer offered on this work location.", kind: "unavailable" };
  }
  if (!target.available) return { detail: target.detail, kind: "unavailable" };
  // Asked before compatibility: the Host refuses a change of model on a busy
  // Thread too, so answering "compatible" there would offer an Apply that the
  // Host is certain to refuse.
  if (nonterminalRun(runQueue, thread.id)) return { kind: "busy", reason: busyReason };
  const access = accessChange(thread.accessMode, target);
  if (canContinueThreadOnPlacement(thread, target)) {
    return access
      ? { access, engineName: target.engineName, kind: "access" }
      : { kind: "compatible" };
  }
  const current =
    placements.find((placement) => placement.harnessInstanceId === thread.harnessInstanceId) ??
    null;
  return {
    access,
    accountName: placementAccountTitle(target),
    currentEngineName: current?.engineName ?? "the current AI",
    engineName: target.engineName,
    expectedProviderSessionId: thread.providerSessionId,
    kind: "incompatible",
  };
}

/**
 * Starting the AI already in use over again, on purpose: the recovery for a
 * native session whose start is uncertain or whose state has gone. It keeps the
 * account, model and options exactly as they are, so the only thing reviewed is
 * the loss of native context.
 */
export function reviewFreshStart(input: {
  readonly placements: readonly ThreadPlacementOption[];
  readonly runQueue: readonly RunQueueEntry[];
  readonly thread: Pick<ThreadSummary, "harnessInstanceId" | "id" | "providerSessionId">;
}): ExecutionSwitchReview {
  const { placements, runQueue, thread } = input;
  const current =
    placements.find((placement) => placement.harnessInstanceId === thread.harnessInstanceId) ??
    null;
  if (!current) {
    return { detail: "This AI is no longer offered on this work location.", kind: "unavailable" };
  }
  if (!current.available) return { detail: current.detail, kind: "unavailable" };
  if (nonterminalRun(runQueue, thread.id)) return { kind: "busy", reason: busyReason };
  return {
    access: null,
    accountName: placementAccountTitle(current),
    currentEngineName: current.engineName,
    engineName: current.engineName,
    expectedProviderSessionId: thread.providerSessionId,
    kind: "fresh",
  };
}

/** What is kept and what starts fresh. */
export function switchConsequence(
  review: Extract<ExecutionSwitchReview, { kind: "fresh" | "incompatible" }>,
): string {
  return `Your messages stay here. ${review.engineName} starts fresh, with recent messages, your shared notes, and access to earlier conversation.`;
}

/**
 * What the next authorized work will run on, or nothing at all when the queue
 * makes that claim false. A paused queue or waiting inputs mean the next turn
 * is not the reader's next message, so no promise is made about it.
 */
export function nextTurnNote(input: {
  readonly engineName: string;
  readonly queuedCount: number;
  readonly paused: boolean;
}): string | null {
  if (input.paused) {
    return input.queuedCount > 0
      ? `Paused · ${input.queuedCount} ${input.queuedCount === 1 ? "message" : "messages"} waiting`
      : "Paused";
  }
  if (input.queuedCount > 0) {
    return `${input.queuedCount} ${input.queuedCount === 1 ? "message is" : "messages are"} already waiting to run`;
  }
  return `Your next message will use ${input.engineName}.`;
}

/**
 * The one way a Thread's execution changes: a plain pick, a reviewed fresh
 * start, or a reviewed move that needs another access mode. The Host keeps a
 * Thread's mode across a change of engine and refuses an engine that cannot
 * enforce it, so a mode chosen in the review lands first — but only after the
 * review is asked again of the live Thread, so one that went stale while the
 * reader read it changes nothing. If the engine change is then refused, the
 * error says the mode did change.
 */
export async function applyThreadExecution(input: {
  readonly hostClient: Pick<HostClient, "updateThreadAccess" | "updateThreadExecution">;
  /** The review of this selection against the Thread as it is now. */
  readonly recheck: () => ExecutionSwitchReview;
  readonly reviewed?: ReviewedChoice | undefined;
  readonly selection: ExecutionSelection;
  readonly threadId: string;
}): Promise<void> {
  const { hostClient, recheck, reviewed, selection, threadId } = input;
  const change = {
    harnessInstanceId: selection.harnessInstanceId,
    modelSelection: selection.modelSelection,
  };
  const continuation = reviewed?.continuation;
  const accessMode = reviewed?.accessMode;
  if (accessMode) {
    const live = recheck();
    if (live.kind === "busy") throw new Error(live.reason);
    if (live.kind === "unavailable") throw new Error(live.detail);
    const stillAsReviewed =
      live.kind !== "compatible" &&
      live.access?.offered.includes(accessMode) === true &&
      (live.kind === "access"
        ? continuation === undefined
        : continuation?.expectedProviderSessionId === live.expectedProviderSessionId);
    if (!stillAsReviewed) {
      throw new Error("This conversation changed while you were choosing. Choose again.");
    }
    await hostClient.updateThreadAccess(threadId, accessMode);
  }
  try {
    await (continuation
      ? hostClient.updateThreadExecution(threadId, change, {
          expectedProviderSessionId: continuation.expectedProviderSessionId,
        })
      : hostClient.updateThreadExecution(threadId, change));
  } catch (error) {
    if (!accessMode) throw error;
    const label = accessModeOptions.find((option) => option.mode === accessMode)?.label;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason} Its access is now ${label ?? accessMode}.`);
  }
}
