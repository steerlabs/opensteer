/**
 * A Cloud Computer's browser sleeps when nobody uses it and wakes when someone does. This is
 * that browser's sleep as the clients show it, and the one place the Home's report of it
 * becomes what they show.
 *
 * Only a Cloud Computer's pooled browser has any of this. A person's own Mac and a self-hosted
 * Home never report it, and a browser without a report is `not-pooled`, which every client
 * draws exactly as it did before pooled browsers existed.
 *
 * The principle: the person sees the browser's sleep only when it costs them something they
 * can notice. A wake under `browserWakeQuietMs` shows nothing at all; past it, one calm line
 * that changes as the wait grows. A page that came back by reloading, or not at all, says so
 * once, in that page.
 */
import type { TabViewer } from "@opensteer/protocol";
import type { HostSnapshot } from "./client.js";

/* ------------------------------------------------------------------------- *
 * What the Home reports (with its browser placements; only a Home with a pooled browser)
 * ------------------------------------------------------------------------- */

/** Why a pooled browser started afresh instead of waking as it was. */
export type BrowserStartReason =
  /** Its saved state ran out: more than a day asleep. */
  | "expired"
  /** The pool host restarted, or the saved state would not load there. */
  | "host"
  /** A browser update, applied at a start that would have happened anyway. */
  | "update"
  /** A security update that could not wait for such a start. */
  | "security-update"
  /** The person chose Restart browser. */
  | "person";

/**
 * One Cloud Computer's pooled browser, as its Home would report it. Names follow
 * `browser-pool-core` where it has the fact (`browserPoolSlots.runnerId`, `.phase`;
 * `BrowserPoolDocument.surfaceId`, `.typed`; `BrowserPoolAdoptionOutcome.adopted`, `.lost`),
 * plus each note's id, which the client sends back once the note was seen; see
 * `browserSleepFromHome`.
 */
export interface BrowserPoolReport {
  /** `browserPoolSlots.runnerId`: the Cloud Computer, which is the tab's `computer.computerId`. */
  readonly runnerId: string;
  /**
   * `browserPoolSlots.phase` ("running", "preparing", "parked", "waking"), plus three it does not
   * have yet: "starting" (no saved state, so Chromium starts on the profile), "restarting" (the
   * person asked) and "failed" (neither the saved state nor a fresh start came up in time).
   */
  readonly phase:
    "running" | "preparing" | "parked" | "waking" | "starting" | "restarting" | "failed";
  /** When the phase began, as the Home's clock reads it. Kept for the record; see `since`. */
  readonly since: string;
  /** Why the last fresh start happened. Absent when the browser has only ever woken as it was. */
  readonly start?:
    | {
        readonly reason: BrowserStartReason;
        /** Identifies that start, so each note about it is said once. */
        readonly at: string;
      }
    | undefined;
  /** How many fresh starts in a row have failed, while `phase` is "failed". */
  readonly failures?: number | undefined;
  /**
   * The pages that did not come back as they were after the last start or wake, until the
   * person has seen them. Every other page came back exactly as it was.
   */
  readonly pages?:
    | readonly {
        /** `BrowserPoolDocument.surfaceId`: the tab. */
        readonly surfaceId: string;
        /** The Home's id for this note, sent back once the person has seen it. */
        readonly noticeId?: string | undefined;
        /** "reloaded": opened again from its address. "lost": could not be brought back. */
        readonly outcome: "reloaded" | "lost";
        /** Whether the page held typed text that was not sent: yes, no, or not known. */
        readonly typed: BrowserTabTyped;
      }[]
    | undefined;
}

/* ------------------------------------------------------------------------- *
 * What the clients show
 * ------------------------------------------------------------------------- */

/** The browser as a whole. */
export type BrowserSleep =
  /** A Mac's or a self-hosted Home's browser, or a Home that reports nothing: shown as before. */
  | { readonly kind: "not-pooled" }
  /** Running, or about to sleep: shown exactly like a browser that never sleeps. */
  | { readonly kind: "awake"; readonly computerId: string }
  /** Asleep: also shown exactly like a browser that never sleeps; the next look wakes it. */
  | { readonly kind: "asleep"; readonly computerId: string }
  /** Waking as it was. Pages come back exactly as they were. */
  | { readonly kind: "waking"; readonly computerId: string; readonly since: string }
  /** Starting afresh: pages will reload, so an old picture is dimmed from the start. */
  | {
      readonly kind: "starting";
      readonly computerId: string;
      readonly since: string;
      readonly reason: BrowserStartReason | null;
    }
  /** Restarting because the person asked. */
  | { readonly kind: "restarting"; readonly computerId: string; readonly since: string }
  /** Could not start. Tabs and sign-ins are kept. `repeated` from the second failure in a row. */
  | {
      readonly kind: "failed";
      readonly computerId: string;
      readonly since: string;
      readonly repeated: boolean;
    };

/** Whether a page held typed text that was not sent: known yes, known no, or not known. */
export type BrowserTabTyped = "yes" | "no" | "unknown";

/** How one tab came back. */
export type BrowserTabReturn =
  | { readonly kind: "kept" }
  | {
      readonly kind: "reloaded";
      readonly typed: BrowserTabTyped;
      /** "tab-sleep": this tab alone was closed to free memory and opened again at its address. */
      readonly reason: BrowserStartReason | "tab-sleep" | null;
      /** The start this note is about; null when the Home did not say. */
      readonly startAt: string | null;
      /** The Home's id for this note, sent back once the person has seen it. */
      readonly noticeId?: string;
    }
  | {
      readonly kind: "lost";
      readonly typed: BrowserTabTyped;
      readonly startAt: string | null;
      readonly noticeId?: string;
    };

export interface BrowserSleepView {
  readonly browser: BrowserSleep;
  readonly tab: BrowserTabReturn;
}

const kept: BrowserTabReturn = { kind: "kept" };
export const browserNotPooled: BrowserSleepView = Object.freeze({
  browser: Object.freeze({ kind: "not-pooled" }),
  tab: kept,
});

/**
 * The one place the Home's report becomes what the clients show.
 *
 * A Home with a pooled browser reports it with its browser placements (`pools`), and the
 * client copies that into `browserPools` unchanged; every other Home sends nothing, so this
 * returns `browserNotPooled` for it. The report carries every phase, when it began, the last
 * fresh start's reason and id, the count of failed starts, and the pages not kept until seen.
 */
export function browserSleepFromHome(
  reports: HostSnapshot["browserPools"],
  computerId: string | null | undefined,
  tabId: string | null | undefined,
): BrowserSleepView {
  if (!computerId) return browserNotPooled;
  const report = reports?.find((candidate) => candidate.runnerId === computerId);
  if (!report) return browserNotPooled;
  return { browser: browserOf(report), tab: tabId ? tabOf(report, tabId) : kept };
}

function browserOf(report: BrowserPoolReport): BrowserSleep {
  const computerId = report.runnerId;
  const since = report.since;
  switch (report.phase) {
    case "running":
    case "preparing":
      return { kind: "awake", computerId };
    case "parked":
      return { kind: "asleep", computerId };
    case "waking":
      return { kind: "waking", computerId, since };
    case "starting":
      return { kind: "starting", computerId, since, reason: report.start?.reason ?? null };
    case "restarting":
      return { kind: "restarting", computerId, since };
    case "failed":
      return { kind: "failed", computerId, since, repeated: (report.failures ?? 1) > 1 };
  }
}

function tabOf(report: BrowserPoolReport, tabId: string): BrowserTabReturn {
  const page = report.pages?.find((candidate) => candidate.surfaceId === tabId);
  if (!page) return kept;
  const startAt = report.start?.at ?? null;
  const notice = page.noticeId ? { noticeId: page.noticeId } : {};
  return page.outcome === "reloaded"
    ? {
        kind: "reloaded",
        typed: page.typed,
        reason: report.start?.reason ?? null,
        startAt,
        ...notice,
      }
    : { kind: "lost", typed: page.typed, startAt, ...notice };
}

/**
 * TS7: a tab whose last wake opened it again at its address (the tab row's `reopenedAt`), on any
 * Home: it was put to sleep by closing, so its history, scroll and page state are gone, and it says
 * so once, as a page that reloaded after a browser restart does. A report's own note comes first.
 */
export function browserTabReturnOf(
  reported: BrowserTabReturn,
  reopenedAt: number | null | undefined,
): BrowserTabReturn {
  if (reported.kind !== "kept" || !reopenedAt) return reported;
  return {
    kind: "reloaded",
    typed: "no",
    reason: "tab-sleep",
    startAt: new Date(reopenedAt).toISOString(),
  };
}

/**
 * TS10: whether the viewer this device holds for a tab still stands. A page is shown only while
 * its tab is open: a tab this device looks at that is not open (it went to sleep before or under
 * the Home's answer) is asked for again, and asking wakes it. One rule for the web and the phone.
 */
export function tabViewerStands(
  viewer: TabViewer | null,
  tabState: "open" | "asleep" | "unavailable" | undefined,
): boolean {
  if (viewer === null) return false;
  if (viewer.kind === "page") return tabState === "open";
  if (viewer.kind === "app") return true;
  return viewer.view.state !== "closed" && viewer.view.state !== "expired";
}

/**
 * V8: one ask for a tab's viewer, as the web and the phone hold it. An ask has an identity (the
 * caller's own), and what comes after it is decided by its answer and the tab's row, never by a
 * timer.
 */
export interface TabAsk {
  /** The tab's state as the Home read it after this ask's activation; null when it did not say. */
  readonly answeredState: "open" | "asleep" | "unavailable" | null;
  /** The tab's row this device held when the answer came (the store's own object). */
  readonly rowAtAnswer: unknown;
}

/**
 * What follows an answered ask:
 * - `show`: the tab is open, or the answer found it open and the row has said nothing since (the
 *   answer is the newer word);
 * - `ask-again`: the answer found it open and the row has since said it is not: it slept under
 *   the view, and one new ask (with its own identity) wakes it;
 * - `asleep`: the answer itself found it asleep (it slept again under the answer): the tab's
 *   status with Try again, and nothing is asked by itself.
 * A window or phone view stands until it is closed or expired, as `tabViewerStands` says.
 */
export function tabAskStep(
  viewer: TabViewer,
  ask: TabAsk,
  row: { readonly state: "open" | "asleep" | "unavailable" } | undefined,
): "show" | "ask-again" | "asleep" {
  if (viewer.kind !== "page") return tabViewerStands(viewer, row?.state) ? "show" : "ask-again";
  if (row === undefined || row.state !== "asleep") return "show";
  if (ask.answeredState === "asleep") return "asleep";
  return row === ask.rowAtAnswer ? "show" : "ask-again";
}

/**
 * V10: what the stage says while a sleeping tab wakes, above its address: never an empty stage,
 * and never the browser starting (only the browser itself starts).
 */
export const tabWakingWords = "Waking this tab…";

/** The words for a tab still asleep after its answer; it is shown with Try again. */
export const tabAsleepAfterAnswer = "This tab went back to sleep before it opened.";

/** Whether this is a Cloud Computer's pooled browser, which alone offers Restart browser. */
export function browserIsPooled(browser: BrowserSleep): boolean {
  return browser.kind !== "not-pooled";
}

/* ------------------------------------------------------------------------- *
 * The wait: one line that changes as it grows
 * ------------------------------------------------------------------------- */

/**
 * Under this a wake shows nothing: the picture stays as it was, undimmed. It is the moment a
 * stalled picture already dims on every client (`.browser-stale` on the web, `dim` on the
 * phone), so a slow wake looks exactly like a slow network.
 */
export const browserWakeQuietMs = 400;
/** From here the line names the wait. */
export const browserWakeSlowMs = 2_000;
/** From here it says the wait is unusual. */
export const browserWakeLongMs = 8_000;
/** The moments the line can change, so a view re-renders only then. */
export const browserWakeSteps = [browserWakeQuietMs, browserWakeSlowMs, browserWakeLongMs] as const;

export interface BrowserWakeLine {
  /** The one line. Shown on the picture's chip, or alone where there is no picture. */
  readonly text: string;
  /** Dim the picture at once: the page that comes back will not match it. */
  readonly dimNow: boolean;
}

/**
 * The line for a wait, or null when nothing is shown. `picture`: this device holds a picture of
 * the page. `refused`: the person tapped or typed on it meanwhile, which was not sent.
 */
export function browserWakeLine(
  browser: BrowserSleep,
  elapsedMs: number,
  options: { readonly picture: boolean; readonly refused?: boolean },
): BrowserWakeLine | null {
  const { picture } = options;
  const refused = picture && options.refused === true;
  const lead = refused ? browserSleepWords.notSent : browserSleepWords.lastPicture;
  const withLead = (words: string) => `${lead} · ${words}`;
  const long = elapsedMs >= browserWakeLongMs;
  switch (browser.kind) {
    case "waking": {
      if (refused)
        return {
          text: withLead(long ? browserSleepWords.longer : browserSleepWords.waking),
          dimNow: false,
        };
      if (elapsedMs < browserWakeQuietMs) return null;
      const words =
        elapsedMs < browserWakeSlowMs
          ? null
          : long
            ? browserSleepWords.longer
            : browserSleepWords.waking;
      if (picture) return { text: words ? withLead(words) : lead, dimNow: false };
      return { text: words ?? browserSleepWords.opening, dimNow: false };
    }
    case "starting": {
      const words = long ? browserSleepWords.longer : browserSleepWords.starting;
      if (picture) return { text: withLead(words), dimNow: true };
      if (elapsedMs < browserWakeQuietMs) return null;
      return { text: words, dimNow: true };
    }
    case "restarting": {
      // The person just asked for it, so it answers at once.
      const words = long ? browserSleepWords.longer : browserSleepWords.restarting;
      return { text: picture ? withLead(words) : words, dimNow: true };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------- *
 * Words
 * ------------------------------------------------------------------------- */

/** Every sentence a person reads about the browser's sleep, in one place. */
export const browserSleepWords = {
  lastPicture: "Last picture",
  notSent: "Not sent",
  opening: "Opening…",
  waking: "Waking browser…",
  starting: "Starting browser…",
  restarting: "Restarting browser…",
  longer: "Taking longer than usual…",

  failedTitle: "Your browser couldn’t start",
  failedDetail: "Your tabs and sign-ins are kept. Try again in a moment.",
  failedRepeatedDetail:
    "Your tabs and sign-ins are kept. If this keeps happening, contact support.",
  tryAgain: "Try again",
  trying: "Trying…",
  contactSupport: "Contact support",

  restart: "Restart browser",
  restartDetail: "Closes every page and starts it fresh",
  restartTitle: "Restart browser?",
  restartBody:
    "Every page in your Cloud Computer’s browser closes and opens again from its address. Your tabs and sign-ins stay. Anything typed and not sent may be lost.",
  restartConfirm: "Restart browser",
  restartCancel: "Cancel",
  restartRefusedTitle: "Couldn’t restart your browser",
  restartRefused: "Your Cloud Computer can’t restart its browser yet. Nothing was changed.",
  restartFailed: "Your browser wasn’t restarted. Try again in a moment.",

  dismiss: "Dismiss",
} as const;

/** What a tab that did not come back as it was says, once. */
export interface BrowserTabNote {
  /** A short heading, where the client has room for two lines (the phone). */
  readonly title: string;
  /** The sentence under it. */
  readonly detail: string;
  /** Both in one sentence, where the client has one line (the web and desktop). */
  readonly line: string;
}

/**
 * The note for a tab, or null for one that came back exactly. `reasonSaid`: the reason for this
 * start was already given in another tab's note, so this one gives the plain sentence.
 */
export function browserTabNote(
  tab: BrowserTabReturn,
  options: { readonly reasonSaid?: boolean } = {},
): BrowserTabNote | null {
  if (tab.kind === "kept") return null;
  // Firm only when the page is known to have held unsent text; a soft word when it is not known.
  if (tab.kind === "lost")
    return {
      title: "This page couldn’t be restored",
      detail:
        tab.typed === "yes"
          ? "It didn’t come back as you left it, and text you hadn’t sent is gone. Reload to open it again."
          : tab.typed === "unknown"
            ? "It didn’t come back as you left it. Check anything you were typing, then reload to open it again."
            : "It didn’t come back as you left it. Reload to open it again.",
      line:
        tab.typed === "yes"
          ? "This page couldn’t be restored, and text you hadn’t sent is gone. Reload to open it again."
          : tab.typed === "unknown"
            ? "This page couldn’t be restored as you left it. Check anything you were typing."
            : "This page couldn’t be restored as you left it. Reload to open it again.",
    };
  if (tab.reason === "tab-sleep")
    return {
      title: "This page reloaded",
      detail: "It was closed to free memory and opened again from its address.",
      line: "This page reloaded because it was closed to free memory.",
    };
  const reason = options.reasonSaid ? null : tab.reason;
  // Why, said once: only a reason the person would not otherwise know or expect is named.
  const restarted =
    reason === "person"
      ? { subject: "You restarted your browser", because: "you restarted your browser" }
      : reason === "security-update"
        ? {
            subject: "Your browser restarted for a security update",
            because: "your browser restarted for a security update",
          }
        : { subject: "Your browser restarted", because: "your browser restarted" };
  return {
    title: "This page reloaded",
    detail:
      tab.typed === "yes"
        ? `${restarted.subject}, and text you hadn’t sent is gone.`
        : tab.typed === "unknown"
          ? `${restarted.subject}, so text you hadn’t sent may be gone.`
          : `${restarted.subject}.`,
    line:
      tab.typed === "yes"
        ? `This page reloaded because ${restarted.because}. Text you hadn’t sent is gone.`
        : tab.typed === "unknown"
          ? `This page reloaded because ${restarted.because}. Check anything you were typing.`
          : `This page reloaded because ${restarted.because}.`,
  };
}

/** What a browser that could not start says in place of its page. */
export function browserStartFailure(browser: BrowserSleep): {
  readonly title: string;
  readonly detail: string;
  readonly contactSupport: boolean;
} | null {
  if (browser.kind !== "failed") return null;
  return {
    title: browserSleepWords.failedTitle,
    detail: browser.repeated
      ? browserSleepWords.failedRepeatedDetail
      : browserSleepWords.failedDetail,
    contactSupport: browser.repeated,
  };
}

/* ------------------------------------------------------------------------- *
 * Notes leave once seen
 * ------------------------------------------------------------------------- */

/**
 * The tab notes this device has shown and the person has seen (dismissed, touched the page, or
 * left the tab), and the starts whose reason has been given. Each seen note the Home gave an id
 * is sent back to it, so it leaves the report and every other client of the person drops it.
 */
export class BrowserReturnNotes {
  readonly #seen = new Set<string>();
  readonly #reasons = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #version = 0;
  readonly #tell: BrowserNoticeClient["browserNoticeSeen"] | undefined;

  /** `tell` lets the Home know a note was seen, so every client of the person drops it. */
  constructor(tell?: BrowserNoticeClient["browserNoticeSeen"]) {
    this.#tell = tell;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  readonly version = (): number => this.#version;

  /** The note this tab shows now, or null. */
  note(computerId: string, tabId: string, tab: BrowserTabReturn): BrowserTabNote | null {
    if (tab.kind === "kept" || this.#seen.has(noteKey(computerId, tabId, tab))) return null;
    const reasonSaid =
      tab.kind === "reloaded" && this.#reasons.has(JSON.stringify([computerId, tab.startAt]));
    return browserTabNote(tab, { reasonSaid });
  }

  /** The person has seen this tab's note: it does not show again, nor does its reason. */
  seen(computerId: string, tabId: string, tab: BrowserTabReturn): void {
    if (tab.kind === "kept") return;
    const key = noteKey(computerId, tabId, tab);
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    // The Home is told only of a note it gave an id; a failure leaves the note to the Home.
    if (tab.noticeId) void this.#tell?.(computerId, tabId, tab.noticeId).catch(() => undefined);
    if (tab.kind === "reloaded") this.#reasons.add(JSON.stringify([computerId, tab.startAt]));
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}

/** One note: a later loss of the same tab has its own notice id, so it is a new note. */
export function noteKey(computerId: string, tabId: string, tab: BrowserTabReturn): string {
  return JSON.stringify([
    computerId,
    tabId,
    tab.kind,
    tab.kind === "kept" ? null : tab.startAt,
    tab.kind === "kept" ? null : (tab.noticeId ?? null),
  ]);
}

const notesByClient = new WeakMap<object, BrowserReturnNotes>();

/** This client's notes, one set per Host client. */
export function browserReturnNotes(hostClient: object): BrowserReturnNotes {
  let notes = notesByClient.get(hostClient);
  if (!notes) {
    const tell = (hostClient as Partial<BrowserNoticeClient>).browserNoticeSeen;
    notes = new BrowserReturnNotes(tell?.bind(hostClient));
    notesByClient.set(hostClient, notes);
  }
  return notes;
}

/** What a Host client offers so the Home learns a note was seen. */
export interface BrowserNoticeClient {
  browserNoticeSeen(computerId: string, tabId: string, noticeId: string): Promise<void>;
}

/* ------------------------------------------------------------------------- *
 * Restart browser
 * ------------------------------------------------------------------------- */

/** The Home cannot restart this browser: nothing was changed. */
export class BrowserRestartUnavailable extends Error {
  readonly title = browserSleepWords.restartRefusedTitle;
  constructor() {
    super(browserSleepWords.restartRefused);
    this.name = "BrowserRestartUnavailable";
  }
}

/**
 * What a refused or failed restart says, in fixed words: never the failure's own text. Nothing
 * was changed when the Home refused; anything else may not have reached it.
 */
export function browserRestartFailure(error: unknown): string {
  return error instanceof BrowserRestartUnavailable
    ? browserSleepWords.restartRefused
    : browserSleepWords.restartFailed;
}

/**
 * Asks the Home to close every page of this Cloud Computer's browser and start it fresh. No
 * Home can yet, so this is refused with `BrowserRestartUnavailable` and changes nothing.
 */
export function restartPooledBrowser(
  hostClient: { readonly restartPooledBrowser?: (computerId: string) => Promise<void> },
  computerId: string,
): Promise<void> {
  return hostClient.restartPooledBrowser
    ? hostClient.restartPooledBrowser(computerId)
    : Promise.reject(new BrowserRestartUnavailable());
}
