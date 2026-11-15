import { computerAppIdentityKey, type MachineSummary } from "@opensteer/protocol";
import type { PlaceEnteredEventView } from "@opensteer/core";
import type { BrowserSessionSummary } from "./client.js";

export interface RunPageMemory {
  readonly folded: boolean;
  readonly run: {
    readonly runId: string;
    readonly intent: "undecided" | "open" | "closed";
    readonly paged: boolean;
  } | null;
}

export const freshRunPageMemory: RunPageMemory = { folded: false, run: null };

export interface RunPageMoment {
  readonly visible: boolean;
  readonly picture: boolean;
  readonly cellular: boolean | null;
  readonly scrolledUp: boolean;
  readonly typing: boolean;
}

export function runPageConsidered(
  memory: RunPageMemory,
  runId: string | null,
  moment: RunPageMoment,
): RunPageMemory {
  if (runId === null) return memory.run === null ? memory : { ...memory, run: null };
  const run =
    memory.run?.runId === runId
      ? memory.run
      : { runId, intent: "undecided" as const, paged: false };
  let intent = run.intent;
  if (intent === "undecided") {
    if (memory.folded) intent = "closed";
    else if (moment.visible && moment.picture && !moment.typing && moment.cellular !== null)
      intent = moment.scrolledUp || moment.cellular ? "closed" : "open";
  }
  if (memory.run === run && intent === run.intent) return memory;
  return { ...memory, run: intent === run.intent ? run : { ...run, intent } };
}

export function runPageFolded(memory: RunPageMemory): RunPageMemory {
  if (memory.folded && (memory.run === null || memory.run.intent === "closed")) return memory;
  return { ...memory, folded: true, run: memory.run && { ...memory.run, intent: "closed" } };
}

export function runPageOpened(runId: string, memory = freshRunPageMemory): RunPageMemory {
  if (!memory.folded && memory.run?.runId === runId && memory.run.intent === "open") return memory;
  return {
    folded: false,
    run: { runId, intent: "open", paged: memory.run?.runId === runId && memory.run.paged },
  };
}

export function runPagePaged(memory: RunPageMemory, runId: string): RunPageMemory {
  if (memory.run?.runId !== runId || memory.run.intent !== "open" || memory.run.paged)
    return memory;
  return { ...memory, run: { ...memory.run, paged: true } };
}

export type RunPageShown = "none" | "folded" | "row" | "page";

export function runPageShown(
  memory: RunPageMemory,
  runId: string | null,
  fits: boolean,
  options: { readonly picture: boolean; readonly headHasRoom?: boolean } = { picture: true },
): RunPageShown {
  if (runId === null) return "none";
  if (memory.run?.runId === runId && memory.run.intent === "open" && fits)
    return options.picture || memory.run.paged ? "page" : "row";
  return options.headHasRoom === false ? "row" : "folded";
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
