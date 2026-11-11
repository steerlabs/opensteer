import { computerAppIdentityKey, type MachineSummary } from "@opensteer/protocol";
import type { PlaceEnteredEventView } from "@opensteer/core";
import type { BrowserSessionSummary } from "./client.js";

/**
 * What a person has done with a conversation's live page, held in memory for
 * that conversation only: open or folded is presentation, never a route.
 */
export interface RunPageMemory {
  /** The person folded it here, and it stays folded until they open it. */
  readonly folded: boolean;
  /** The Run whose page stands open. */
  readonly openRunId: string | null;
  /** The Run whose first action was already decided, so it opens at most once by itself. */
  readonly decidedRunId: string | null;
}

export const freshRunPageMemory: RunPageMemory = {
  folded: false,
  openRunId: null,
  decidedRunId: null,
};

/** What the person was doing when the agent first acted. */
export interface RunPageMoment {
  readonly cellular: boolean | null;
  readonly scrolledUp: boolean;
  readonly typing: boolean;
}

/**
 * The agent acted in a place for this Run. The first time, the page opens by
 * itself unless the person folded it here, is reading back, is typing, or is
 * on cellular, where a large picture costs their data.
 */
export function runPageActed(
  memory: RunPageMemory,
  runId: string,
  moment: RunPageMoment,
): RunPageMemory {
  if (moment.cellular === null) return memory;
  if (memory.decidedRunId === runId) return memory;
  const opens = !memory.folded && !moment.scrolledUp && !moment.typing && !moment.cellular;
  return { ...memory, decidedRunId: runId, openRunId: opens ? runId : null };
}

export function runPageFolded(memory: RunPageMemory): RunPageMemory {
  return { ...memory, folded: true, openRunId: null };
}

export function runPageOpened(runId: string): RunPageMemory {
  return { folded: false, openRunId: runId, decidedRunId: runId };
}

/** `none` while no Run of this conversation is in a place; it ends with the Run. */
export type RunPageShown = "none" | "open" | "folded";

/** `runId` is the conversation's Run, only while it is in a place; `fits` is whether `runPageSize` found room. */
export function runPageShown(
  memory: RunPageMemory,
  runId: string | null,
  fits: boolean,
): RunPageShown {
  if (runId === null) return "none";
  return memory.openRunId === runId && fits ? "open" : "folded";
}

/** Below this a page is too small to read and folds instead. */
export const runPageLeast = 140;

/**
 * The page's size: its own shape, never resized, at the width it is given and
 * no taller than the room allows. The page and the conversation share the
 * room between the bar and the dock, so the page takes at most half of it and
 * always leaves `transcript`. Null when that would leave it too small to
 * read: then it folds by itself.
 */
export function runPageSize(input: {
  /** The page's own width over its height. */
  readonly aspect: number;
  /** From under the bar to the top of the dock, keyboard and all. */
  readonly room: number;
  /** The least the conversation keeps below the page. */
  readonly transcript: number;
  readonly width: number;
}): { readonly height: number; readonly width: number } | null {
  if (!(input.aspect > 0) || input.width <= 0) return null;
  const natural = input.width / input.aspect;
  const cap = input.room - Math.max(input.transcript, input.room / 2);
  const height = Math.min(natural, cap);
  if (height < Math.min(natural, runPageLeast)) return null;
  return {
    height: Math.floor(height),
    width: Math.floor(Math.min(input.width, height * input.aspect)),
  };
}

/**
 * Whether this conversation's agent is acting in its Run's place right now. A
 * tab is shared, so it counts only when this conversation is the one acting
 * there; a Mac app or phone session is the Run's own.
 */
export function runPlaceActing(
  entry: PlaceEnteredEventView,
  snapshot: {
    readonly browserSessions: readonly BrowserSessionSummary[];
    readonly machines: readonly MachineSummary[];
  },
  threadId: string,
): boolean {
  const place = entry.data.place;
  if (place.kind === "browser")
    return snapshot.browserSessions.some(
      (session) =>
        session.state === "ready" &&
        session.browserTabs
          ?.sessionTab(session.id, place.surfaceId)
          ?.occupants.some((occupant) => occupant.acting && occupant.threadId === threadId) ===
          true,
    );
  const session = snapshot.machines
    .find((machine) => machine.id === place.machineId)
    ?.computerUse?.sessions.find((session) => session.runId === entry.runId);
  if (session === undefined) return false;
  return place.kind === "phone"
    ? session.actingDisplay === true
    : session.actingAppKeys.includes(place.appKey) &&
        session.apps.some((app) => computerAppIdentityKey(app) === place.appKey);
}
