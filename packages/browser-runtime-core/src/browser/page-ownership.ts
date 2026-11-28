import type { BrowserSurfaceId } from "@opensteer/protocol/browser";
import { randomUUID } from "node:crypto";
import type {
  BrowserContext,
  BrowserPage,
  KeepAwakeReason,
  PageGoneCause,
  RendererExit,
  RendererGoneCause,
} from "./backend.js";

/**
 * Where one native page is. A page asked to end stays `closing`, owned, until
 * its engine confirms it gone; nothing returns it to service.
 */
export type NativePageState = "provisional" | "live" | "closing" | "absent";

export type PageEndReason =
  | "person-closed"
  | "agent-closed"
  | "host-closed"
  | "slept"
  | "session-ended"
  | "profile-closed"
  | "host-retired"
  | "runtime-shutdown"
  | "open-failed"
  | "wake-failed"
  /** The engine ended the page unasked. */
  | "native-gone";

/** How an owner learns its page ended: whether anyone asked, and what the engine reported. */
export interface PageEnd {
  readonly requested: boolean;
  readonly confirmedBy: "page-event" | "context-end" | "closed-check";
}

/** A close attempt's rejection that says no later attempt can name this page either. */
export const pageUnnameableReason = "page-unnameable";

/** Why a page is not slept. A fixed set, so nothing from a page can reach a log. */
export type SleepBlocker =
  | KeepAwakeReason
  | "host-state"
  | "closing"
  | "closed"
  | "viewed"
  | "pinned"
  | "native"
  | "viewer"
  | "held-input"
  | "sign-in"
  | "operation"
  | "agent-input"
  | "agent-bound"
  | "recently-viewed"
  | "typed"
  | "quiet"
  | "suspended"
  | "dialog"
  | "loading"
  | "unrestorable"
  | "address"
  | "restore-version"
  | "opener"
  | "demanded"
  | "document-changed"
  | "protection-failed"
  | "capture-failed";

/**
 * V1: every protection, in one table. NEVER: not slept by any pass. LAST RESORT: slept only when
 * memory is still over the threshold with nothing else left (to keep the kernel's out-of-memory
 * killer away); the others are conditions of the tab or the sleep itself, never overridden.
 * `chromium` is the counterpart in Chromium's discard policy (discard_eligibility_policy.cc), which
 * chrome.tabs.discard bypasses entirely: Opensteer enforces each one itself.
 */
export const sleepProtections: Readonly<
  Record<
    SleepBlocker,
    {
      readonly kind: "never" | "last-resort" | "condition";
      readonly fact: string;
      readonly chromium: string | null;
    }
  >
> = {
  "host-state": {
    kind: "never",
    fact: "the Home's session state, unknown or keep-awake",
    chromium: null,
  },
  closing: { kind: "condition", fact: "the session is closing", chromium: null },
  closed: { kind: "condition", fact: "the tab closed", chromium: null },
  viewed: { kind: "never", fact: "a person views it (Home state)", chromium: "kVisible" },
  pinned: {
    kind: "never",
    fact: "a pending request, or a tab woken for an agent not yet attached (Home pins)",
    chromium: "kPinnedTab",
  },
  native: { kind: "never", fact: "shown in the desktop app's own window", chromium: "kVisible" },
  viewer: { kind: "never", fact: "a viewer streams it (controller)", chromium: "kVisible" },
  "held-input": { kind: "never", fact: "a key or button is held in it", chromium: null },
  "sign-in": {
    kind: "never",
    fact: "a sign-in, passkey or person offer in it",
    chromium: "kFormInteractions",
  },
  operation: {
    kind: "never",
    fact: "an agent's or the runtime's operation runs on it (lease)",
    chromium: "kDevToolsOpen",
  },
  "agent-input": {
    kind: "never",
    fact: "an agent typed or clicked in it during a live Run",
    chromium: "kUserEdits",
  },
  "agent-bound": {
    kind: "last-resort",
    fact: "a live Run or connected agent is bound to it (Home agentTabs)",
    chromium: null,
  },
  "recently-viewed": {
    kind: "last-resort",
    fact: "a person saw it in the last ten minutes",
    chromium: "kRecentlyVisible",
  },
  typed: {
    kind: "last-resort",
    fact: "text was typed into it through Opensteer",
    chromium: "kUserEdits",
  },
  quiet: { kind: "last-resort", fact: "used in the last ten seconds", chromium: null },
  suspended: { kind: "condition", fact: "already asleep", chromium: "kAlreadyDiscarded" },
  dialog: { kind: "never", fact: "a JavaScript dialog is open", chromium: null },
  loading: { kind: "condition", fact: "its document is loading", chromium: null },
  unrestorable: {
    kind: "condition",
    fact: "an earlier capture failed",
    chromium: "kDiscardAttempted",
  },
  address: {
    kind: "condition",
    fact: "not an http(s) or blank page",
    chromium: "kNotWebOrInternal",
  },
  "restore-version": { kind: "condition", fact: "the session cannot restore tabs", chromium: null },
  opener: { kind: "never", fact: "a live page holds a script link to it", chromium: null },
  demanded: { kind: "condition", fact: "asked for during the sleep", chromium: null },
  "document-changed": {
    kind: "condition",
    fact: "its document changed during the sleep",
    chromium: null,
  },
  "protection-failed": {
    kind: "never",
    fact: "a protection read failed (this pass)",
    chromium: null,
  },
  "capture-failed": {
    kind: "never",
    fact: "its state could not be captured (this pass)",
    chromium: null,
  },
  upload: { kind: "never", fact: "an upload is in flight", chromium: null },
  post: {
    kind: "never",
    fact: "its document came from a form POST, which no reload repeats",
    chromium: null,
  },
  download: { kind: "never", fact: "a download is in flight", chromium: null },
  media: {
    kind: "never",
    fact: "it plays audio now (elements, native players, Web Audio)",
    chromium: "kAudible",
  },
  fullscreen: { kind: "never", fact: "it is fullscreen", chromium: "kVisible" },
  capturing: {
    kind: "never",
    fact: "it captures camera, microphone or screen",
    chromium: "kCapturingVideo/Audio/Window/Display",
  },
  "tab-helper": {
    kind: "condition",
    fact: "the browser's look for the tab helper has not ended",
    chromium: null,
  },
  device: {
    kind: "never",
    fact: "a USB device or Bluetooth server is connected",
    chromium: "kConnectedToUSB/Bluetooth",
  },
  "picture-in-picture": {
    kind: "never",
    fact: "it shows picture-in-picture (in view)",
    chromium: "kPictureInPicture",
  },
  "recently-audible": {
    kind: "last-resort",
    fact: "it was heard in the last minute",
    chromium: "kRecentlyAudible",
  },
  pdf: { kind: "last-resort", fact: "it shows a PDF", chromium: "kPdf" },
  notifications: {
    kind: "last-resort",
    fact: "the site may notify",
    chromium: "kNotificationsEnabled (proactive only)",
  },
  form: {
    kind: "last-resort",
    fact: "the person changed a form or edited the page",
    chromium: "kFormInteractions/kUserEdits",
  },
  beforeunload: {
    kind: "last-resort",
    fact: "it asks to be warned before it goes",
    chromium: null,
  },
  unknown: { kind: "never", fact: "a protection could not be read (this pass)", chromium: null },
};

/** V1: whether a protection gives way to the out-of-memory last resort. */
export function lastResortOnly(reason: SleepBlocker): boolean {
  return sleepProtections[reason].kind === "last-resort";
}

type Closing = {
  readonly page: string;
  readonly surface: BrowserSurfaceId | null;
  readonly reason: PageEndReason;
  readonly closingMs: number;
  readonly closeAttempts: number;
};

/** Ids, states, reasons, durations and counts only: never anything from a page. */
export type BrowserPageDiagnostic =
  | {
      readonly event: "browser.page.ended";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      /** What first asked the page to end, or `native-gone` when nothing did. */
      readonly reason: PageEndReason;
      readonly confirmedBy: "page-event" | "context-end" | "closed-check";
      /** The latest renderer loss seen before the end, if any. */
      readonly rendererGone: RendererGoneCause | null;
      readonly lifetimeMs: number;
      readonly closingMs: number | null;
      readonly closeAttempts: number;
    }
  /** One close request has not settled; the next one may start. */
  | ({ readonly event: "browser.page.closing.hung" } & Closing)
  /** Automatic requests are used up; only an explicit one asks again. */
  | ({ readonly event: "browser.page.closing.exhausted" } & Closing)
  | {
      readonly event: "browser.page.renderer.gone";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      readonly state: NativePageState;
      readonly cause: RendererGoneCause;
    }
  /** One sample of the last known main-frame renderer, taken after the page ended. */
  | {
      readonly event: "browser.page.renderer.sampled";
      readonly page: string;
      readonly sampledAfterMs: number;
      readonly outcome: RendererExit;
    }
  /** The sleeper skipped a page that was due, before asking it anything. */
  | {
      readonly event: "browser.page.sleep.blocked";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      readonly reason: SleepBlocker;
      readonly previous: SleepBlocker | null;
    }
  /** A sleep attempt was refused; repeats of the same reason are counted, not logged. */
  | {
      readonly event: "browser.page.sleep.refused";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      readonly reason: SleepBlocker;
      readonly previous: SleepBlocker | null;
      readonly previousAttempts: number;
    }
  /**
   * A page no session has admitted after a while: a slow admission, a raw
   * target nobody adopted, or a page a person opened in the browser itself.
   * It is never ended for its age.
   */
  | {
      readonly event: "browser.page.unadopted";
      readonly page: string;
      readonly attributed: boolean;
      readonly ageMs: number;
    }
  /** The engine cannot name this page to close it; it stays owned and asked, but no longer holds its tab. */
  | {
      readonly event: "browser.page.closing.unnameable";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      readonly closeAttempts: number;
    }
  /** Runtime shutdown finished with pages unconfirmed; they stay owned and asked. */
  | {
      readonly event: "browser.page.shutdown.incomplete";
      readonly states: PageCounts["states"];
    };

/**
 * What the registry has seen, not a complete account: renderer causes are the
 * engine's last report, and pages a session never sees are not here.
 */
export interface PageCounts {
  readonly states: Readonly<Record<Exclude<NativePageState, "absent">, number>>;
  readonly ended: Readonly<Partial<Record<PageEndReason, number>>>;
  /** Transitions into each blocker, counted when the sleeper looks. */
  readonly sleepBlocked: Readonly<Partial<Record<SleepBlocker, number>>>;
  /** Every refused sleep attempt, by reason. */
  readonly sleepRefused: Readonly<Partial<Record<SleepBlocker, number>>>;
}

/** Above the 18-second creation and registration budgets: past it, an unadmitted page is reported once. */
const unadoptedAfterMs = 30_000;
const hungCloseMs = 10_000;
const retryBaseMs = 1_000;
const retryCeilingMs = 30_000;
const automaticAttempts = 8;
const rendererSampleAfterMs = 3_000;

interface NativePage {
  readonly incarnation: string;
  readonly page: BrowserPage;
  readonly createdAt: number;
  readonly onGone: (cause?: PageGoneCause) => void;
  readonly settled: PromiseWithResolvers<void>;
  stopRenderer: (() => void) | undefined;
  state: NativePageState;
  /** The owning session; null only between handoff and attribution. */
  session: string | null;
  /** The tab this incarnation materializes, set once. */
  surfaceId: BrowserSurfaceId | null;
  /** The owner's one disposition for this incarnation's confirmation. */
  onConfirmed: ((incarnation: string, end: PageEnd) => void) | null;
  /** The context that handed it off, until confirmed. */
  context: BrowserContext | null;
  /** False once the engine says no attempt can name it: the tab no longer waits for it. */
  holdsTab: boolean;
  reason: PageEndReason | null;
  rendererGone: RendererGoneCause | null;
  closingSince: number;
  attempts: number;
  automatic: number;
  attempt: object | null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  retainClose: boolean;
  admitTimer: ReturnType<typeof setTimeout> | undefined;
  targetId: Promise<string> | undefined;
  blocked: SleepBlocker | null;
  refused: { reason: SleepBlocker; attempts: number } | null;
}

interface Creation {
  readonly session: string;
  readonly surfaceId: BrowserSurfaceId | null;
  readonly reason: PageEndReason;
  abandoned: boolean;
  /** Aborted with `abandoned`: the engine's own steps stop where they check it. */
  readonly abort: AbortController;
  page: BrowserPage | null;
}

/** Every way a creation stops being wanted goes through here, so its signal always aborts. */
function abandon(creation: Creation): void {
  creation.abandoned = true;
  creation.abort.abort();
}

/**
 * Every native page a runtime holds, one entry per materialization, from the
 * moment its engine has a handle. Each entry belongs to a session, which
 * admits it as a tab or ends it; only the engine's confirmation removes it.
 */
export class PageOwnership {
  private readonly pages = new WeakMap<BrowserPage, NativePage>();
  private readonly held = new Set<NativePage>();
  private readonly creations = new Set<Creation>();
  /** Adopted contexts: their handoff, pages still held, attached sessions, and whether released. */
  private readonly contexts = new Map<
    BrowserContext,
    { unsubscribe: () => void; pages: number; released: boolean; sessions: Set<string> }
  >();
  private readonly ended = new Set<string>();
  private readonly lookups = new Set<() => void>();
  private readonly drains = new Set<() => void>();
  private readonly endings: Partial<Record<PageEndReason, number>> = {};
  private readonly blockings: Partial<Record<SleepBlocker, number>> = {};
  private readonly refusals: Partial<Record<SleepBlocker, number>> = {};
  private readonly onDiagnostic: (diagnostic: BrowserPageDiagnostic) => void;
  private shuttingDown = false;
  private stopped = false;

  constructor(
    options: { onDiagnostic?: ((diagnostic: BrowserPageDiagnostic) => void) | undefined } = {},
  ) {
    const sink = options.onDiagnostic;
    this.onDiagnostic = (diagnostic) => {
      try {
        sink?.(diagnostic);
      } catch {
        // Reporting cannot change page ownership.
      }
    };
  }

  /** Takes every page `context` hands off, now and later; a popup belongs to its opener's session. */
  adopt(context: BrowserContext): void {
    if (this.contexts.has(context)) return;
    const adopted: {
      unsubscribe: () => void;
      pages: number;
      released: boolean;
      sessions: Set<string>;
    } = {
      unsubscribe: () => undefined,
      pages: 0,
      released: false,
      sessions: new Set(),
    };
    this.contexts.set(context, adopted);
    adopted.unsubscribe = context.handOff((page, opener, inferred = false) => {
      const entry = this.track(page);
      if (!entry.context && entry.state !== "absent") {
        entry.context = context;
        adopted.pages++;
      }
      const session = opener ? this.pages.get(opener)?.session : null;
      if (
        entry.session === null &&
        session &&
        (!inferred || this.singleSessionIn(context, session))
      )
        this.attribute(entry, session);
    });
  }

  /** Records a session attached to `context` even while all its tabs are asleep. */
  attachSession(context: BrowserContext, session: string): void {
    this.adopt(context);
    this.contexts.get(context)?.sessions.add(session);
  }

  /** Removes a detached session from `context`'s membership set. */
  detachSession(context: BrowserContext, session: string): void {
    this.contexts.get(context)?.sessions.delete(session);
  }

  private singleSessionIn(context: BrowserContext, session: string): boolean {
    const adopted = this.contexts.get(context);
    if (adopted) {
      for (const attached of adopted.sessions) {
        if (attached !== session) return false;
      }
    }
    for (const entry of this.held) {
      if (entry.context === context && entry.session !== null && entry.session !== session)
        return false;
    }
    return true;
  }

  /** The context has ended: its handoff is dropped once none of its pages remain held. */
  release(context: BrowserContext): void {
    const adopted = this.contexts.get(context);
    if (!adopted) return;
    adopted.released = true;
    if (adopted.pages === 0) this.forget(context);
  }

  /** The session ended: every page it holds, admitted or not, is asked to end. */
  endSession(session: string, reason: PageEndReason): Promise<void> {
    this.ended.add(session);
    for (const adopted of this.contexts.values()) adopted.sessions.delete(session);
    for (const creation of this.creations) if (creation.session === session) abandon(creation);
    const ending = [...this.held].filter((entry) => entry.session === session);
    for (const entry of ending) this.request(entry, reason);
    return Promise.all(ending.map((entry) => entry.settled.promise)).then(() => undefined);
  }

  /**
   * What this ledger holds of a session now: its pages (each until the engine confirms it gone)
   * and its page creations under way. A session holds nothing only when both are zero.
   */
  holdingsOf(session: string): {
    readonly pages: number;
    readonly creations: number;
    /** Of its pages, those whose close is being asked of the engine right now. */
    readonly closing: number;
  } {
    let pages = 0;
    let closing = 0;
    for (const entry of this.held)
      if (entry.session === session) {
        pages++;
        if (entry.state === "closing" && entry.attempt) closing++;
      }
    let creations = 0;
    for (const creation of this.creations) if (creation.session === session) creations++;
    return { pages, creations, closing };
  }

  /** For a planned relay restart, keep only the person's live page incarnations. */
  endOtherPages(
    session: string,
    keep: ReadonlySet<BrowserPage>,
    withinMs: number,
    reason: PageEndReason = "session-ended",
  ): Promise<boolean> {
    const shouldEnd = (entry: NativePage) => entry.session === session && !keep.has(entry.page);
    for (const creation of this.creations) if (creation.session === session) abandon(creation);
    for (const entry of this.held) if (shouldEnd(entry)) this.request(entry, reason);
    return this.until(
      () =>
        [...this.held].some(shouldEnd) ||
        [...this.creations].some((creation) => creation.session === session),
      withinMs,
    );
  }

  /** Makes `page` this session's, if it is unowned or already its own and may still be admitted. */
  claim(page: BrowserPage, session: string): boolean {
    const entry = this.track(page);
    if (entry.session === null) this.attribute(entry, session);
    return entry.session === session && admissible(entry);
  }

  sessionOf(page: BrowserPage): string | null {
    return this.pages.get(page)?.session ?? null;
  }

  /**
   * Starts one native creation for a session's tab. The tab counts as busy
   * until the creation settles, whether or not a page came of it; a page that
   * arrives after `abandon`, or with a failed creation, is ended.
   */
  create(
    session: string,
    surfaceId: BrowserSurfaceId | null,
    reason: PageEndReason,
    start: (own: (page: BrowserPage) => void, signal: AbortSignal) => Promise<BrowserPage>,
  ): { readonly page: Promise<BrowserPage>; abandon(): void } {
    const creation: Creation = {
      session,
      surfaceId,
      reason,
      abandoned: false,
      abort: new AbortController(),
      page: null,
    };
    this.creations.add(creation);
    const own = (page: BrowserPage) => {
      if (creation.page === page) return;
      creation.page = page;
      const entry = this.track(page);
      entry.surfaceId ??= surfaceId;
      if (entry.session === null) this.attribute(entry, session);
      if (creation.abandoned || entry.session !== session) this.request(entry, reason);
    };
    let created: Promise<BrowserPage>;
    try {
      created = start(own, creation.abort.signal);
    } catch (error) {
      created = Promise.reject(error);
    }
    const page = created.then(
      (page) => {
        own(page);
        this.creations.delete(creation);
        this.notify(this.drains);
        this.stopIfDrained();
        return page;
      },
      (error: unknown) => {
        abandon(creation);
        if (creation.page) this.request(this.track(creation.page), reason);
        this.creations.delete(creation);
        this.notify(this.drains);
        this.stopIfDrained();
        throw error;
      },
    );
    return {
      page,
      abandon: () => {
        abandon(creation);
        if (creation.page) this.request(this.track(creation.page), reason);
      },
    };
  }

  /**
   * Commits a provisional page as a tab's live page, once: never a page of
   * another session, a page asked to end, or a second tab. Returns its
   * incarnation, or null when it may not be admitted.
   */
  admit(
    page: BrowserPage,
    session: string,
    surfaceId: BrowserSurfaceId,
    onConfirmed: (incarnation: string, end: PageEnd) => void,
  ): string | null {
    const entry = this.pages.get(page);
    if (
      !entry ||
      entry.state !== "provisional" ||
      entry.session !== session ||
      (entry.surfaceId !== null && entry.surfaceId !== surfaceId) ||
      this.gone(entry)
    )
      return null;
    entry.surfaceId = surfaceId;
    entry.onConfirmed = onConfirmed;
    entry.state = "live";
    clearTimeout(entry.admitTimer);
    return entry.incarnation;
  }

  /**
   * Asks the engine to end a page. Every request asks again unless one is
   * still fresh, and renews the automatic retries; the first reason stays.
   */
  destroy(page: BrowserPage, reason: PageEndReason): void {
    this.request(this.track(page), reason);
  }

  /** True once the engine confirms `page` gone, false if it has not by `withinMs`. */
  confirmed(page: BrowserPage, withinMs: number): Promise<boolean> {
    const entry = this.pages.get(page);
    if (!entry) return Promise.resolve(page.isClosed());
    return this.within([entry], withinMs);
  }

  retainTabClose(session: string, surfaceId: BrowserSurfaceId): void {
    for (const entry of this.held)
      if (entry.session === session && entry.surfaceId === surfaceId) entry.retainClose = true;
  }

  /** The pages this session's tab may still have: earlier incarnations and creations under way. */
  tabPages(session: string, surfaceId: BrowserSurfaceId): BrowserPage[] {
    return [...this.held]
      .filter((entry) => entry.session === session && entry.surfaceId === surfaceId)
      .map((entry) => entry.page);
  }

  /**
   * Asks every earlier incarnation of a tab to end again and waits, bounded,
   * until none may still live and no creation for it is under way.
   */
  async tabSettled(
    session: string,
    surfaceId: BrowserSurfaceId,
    reason: PageEndReason,
    withinMs: number,
    includeDetached = false,
  ): Promise<boolean> {
    const busy = () =>
      [...this.held].some(
        (entry) =>
          entry.session === session &&
          entry.surfaceId === surfaceId &&
          (includeDetached || entry.holdsTab),
      ) ||
      [...this.creations].some(
        (creation) => creation.session === session && creation.surfaceId === surfaceId,
      );
    for (const page of this.tabPages(session, surfaceId)) this.destroy(page, reason);
    return this.until(busy, withinMs);
  }

  /**
   * A page of this session, or unowned, whose target is `targetId`. A page
   * asked to end is never found, and no page's metadata delays another's.
   */
  findTarget(targetId: string, session: string, withinMs: number): Promise<BrowserPage | null> {
    return new Promise((resolve) => {
      const asked = new Set<NativePage>();
      const finish = (page: BrowserPage | null) => {
        clearTimeout(timer);
        this.lookups.delete(look);
        resolve(page);
      };
      const look = () => {
        for (const entry of this.held) {
          if (asked.has(entry) || !findable(entry, session)) continue;
          asked.add(entry);
          entry.targetId ??= Promise.resolve().then(() => entry.page.targetId());
          void entry.targetId.then(
            (id) => {
              if (id === targetId && findable(entry, session) && this.lookups.has(look))
                finish(entry.page);
            },
            () => undefined,
          );
        }
      };
      const timer = setTimeout(() => finish(null), withinMs);
      timer.unref?.();
      this.lookups.add(look);
      look();
    });
  }

  /** The sleeper's view of a due page: logs only when its blocker changes. */
  noteSleepBlocker(page: BrowserPage, reason: SleepBlocker | null): void {
    const entry = this.pages.get(page);
    if (!entry || entry.state === "absent" || entry.blocked === reason) return;
    const previous = entry.blocked;
    entry.blocked = reason;
    if (!reason) return;
    // A blocked page is not attempted, so a later refusal is a new transition.
    entry.refused = null;
    this.blockings[reason] = (this.blockings[reason] ?? 0) + 1;
    this.onDiagnostic({
      event: "browser.page.sleep.blocked",
      page: entry.incarnation,
      surface: entry.surfaceId,
      reason,
      previous,
    });
  }

  /** One sleep attempt's outcome: a refusal logs when its reason changes; null clears it. */
  noteSleepRefusal(page: BrowserPage | null, reason: SleepBlocker | null): void {
    if (reason) this.refusals[reason] = (this.refusals[reason] ?? 0) + 1;
    const entry = page ? this.pages.get(page) : undefined;
    if (!entry || entry.state === "absent") return;
    if (!reason) {
      entry.refused = null;
      return;
    }
    if (entry.refused?.reason === reason) {
      entry.refused.attempts++;
      return;
    }
    this.onDiagnostic({
      event: "browser.page.sleep.refused",
      page: entry.incarnation,
      surface: entry.surfaceId,
      reason,
      previous: entry.refused?.reason ?? null,
      previousAttempts: entry.refused?.attempts ?? 0,
    });
    entry.refused = { reason, attempts: 1 };
  }

  counts(): PageCounts {
    const states = { provisional: 0, live: 0, closing: 0 };
    for (const entry of this.held) if (entry.state !== "absent") states[entry.state]++;
    return {
      states,
      ended: { ...this.endings },
      sleepBlocked: { ...this.blockings },
      sleepRefused: { ...this.refusals },
    };
  }

  /** Pages of this session that exist natively without a live tab: still being admitted, or closing. */
  untabbed(session: string): number {
    let count = 0;
    for (const entry of this.held)
      if (entry.session === session && entry.state !== "live" && entry.state !== "absent") count++;
    return count;
  }

  /**
   * Runtime shutdown: asks every page that remains, and any handed off from
   * now on, to end, then waits, bounded, for every one to be confirmed. An
   * incomplete drain is reported and leaves recovery running; it never fails
   * the shutdown, so the engine's own last-resort teardown still runs.
   */
  async shutdown(withinMs: number): Promise<boolean> {
    this.shuttingDown = true;
    for (const creation of this.creations) abandon(creation);
    for (const entry of this.held) this.request(entry, "runtime-shutdown");
    await this.until(() => !this.drained(), withinMs);
    // Recovery stops only when nothing is held at this moment, a page handed off late included.
    this.stopIfDrained();
    if (!this.stopped)
      this.onDiagnostic({
        event: "browser.page.shutdown.incomplete",
        states: this.counts().states,
      });
    return this.stopped;
  }

  private drained(): boolean {
    return this.held.size === 0 && this.creations.size === 0;
  }

  /** After shutdown began, the moment the registry empties is the moment it stops. */
  private stopIfDrained(): void {
    if (this.shuttingDown && !this.stopped && this.drained()) this.stop();
  }

  private forget(context: BrowserContext): void {
    this.contexts.get(context)?.unsubscribe();
    this.contexts.delete(context);
  }

  private stop(): void {
    this.stopped = true;
    for (const context of this.contexts.keys()) this.forget(context);
    for (const entry of this.held) {
      clearTimeout(entry.retryTimer);
      clearTimeout(entry.admitTimer);
    }
  }

  private track(page: BrowserPage): NativePage {
    const existing = this.pages.get(page);
    if (existing) return existing;
    const entry: NativePage = {
      incarnation: randomUUID(),
      page,
      createdAt: Date.now(),
      onGone: (cause) => this.confirm(entry, cause === "context" ? "context-end" : "page-event"),
      settled: Promise.withResolvers<void>(),
      stopRenderer: undefined,
      state: "provisional",
      session: null,
      surfaceId: null,
      onConfirmed: null,
      context: null,
      holdsTab: true,
      reason: null,
      rendererGone: null,
      closingSince: 0,
      attempts: 0,
      automatic: 0,
      attempt: null,
      retryTimer: undefined,
      retainClose: false,
      admitTimer: undefined,
      targetId: undefined,
      blocked: null,
      refused: null,
    };
    this.pages.set(page, entry);
    this.held.add(entry);
    page.onClose(entry.onGone);
    entry.stopRenderer = page.onRendererGone?.((cause) => {
      entry.rendererGone = cause;
      this.onDiagnostic({
        event: "browser.page.renderer.gone",
        page: entry.incarnation,
        surface: entry.surfaceId,
        state: entry.state,
        cause,
      });
    });
    if (page.isClosed()) {
      this.confirm(entry, "closed-check");
      return entry;
    }
    if (this.shuttingDown) {
      this.request(entry, "runtime-shutdown");
      return entry;
    }
    // Only a creation known to be abandoned ends; an unknown origin is reported, never ended by age.
    entry.admitTimer = setTimeout(() => {
      if (entry.state !== "provisional") return;
      this.onDiagnostic({
        event: "browser.page.unadopted",
        page: entry.incarnation,
        attributed: entry.session !== null,
        ageMs: Date.now() - entry.createdAt,
      });
    }, unadoptedAfterMs);
    entry.admitTimer.unref?.();
    this.notify(this.lookups);
    return entry;
  }

  private attribute(entry: NativePage, session: string): void {
    entry.session = session;
    if (this.ended.has(session)) this.request(entry, "session-ended");
  }

  private request(entry: NativePage, reason: PageEndReason): void {
    if (entry.state === "absent" || this.gone(entry)) return;
    entry.reason ??= reason;
    clearTimeout(entry.admitTimer);
    if (entry.state !== "closing") {
      entry.state = "closing";
      entry.closingSince = Date.now();
    }
    entry.automatic = 0;
    this.attempt(entry);
  }

  private attempt(entry: NativePage): void {
    if (entry.attempt || this.stopped) return;
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    entry.attempts++;
    entry.automatic++;
    const attempt = {};
    entry.attempt = attempt;
    const hung = setTimeout(() => {
      if (entry.attempt !== attempt || entry.state !== "closing") return;
      this.onDiagnostic({ event: "browser.page.closing.hung", ...this.closing(entry) });
      // The engine may never answer; the slot frees so a later request can ask again.
      next();
    }, hungCloseMs);
    hung.unref?.();
    const next = () => {
      clearTimeout(hung);
      if (entry.attempt !== attempt) return;
      entry.attempt = null;
      if (entry.state !== "closing" || this.gone(entry) || this.stopped) return;
      if (!entry.retainClose && entry.automatic >= automaticAttempts) {
        this.onDiagnostic({ event: "browser.page.closing.exhausted", ...this.closing(entry) });
        return;
      }
      entry.retryTimer = setTimeout(
        () => this.attempt(entry),
        Math.min(retryCeilingMs, retryBaseMs * 2 ** (entry.automatic - 1)),
      );
      entry.retryTimer.unref?.();
    };
    let closing: Promise<void>;
    try {
      closing = Promise.resolve(
        entry.reason ? entry.page.close({ reason: entry.reason }) : entry.page.close(),
      );
    } catch (error) {
      closing = Promise.reject(error);
    }
    void closing.then(next, (error: unknown) => {
      if (
        entry.holdsTab &&
        error instanceof Error &&
        "reason" in error &&
        error.reason === pageUnnameableReason
      ) {
        // Still owned and asked, but the tab may start a new page: this one is unreachable.
        entry.holdsTab = false;
        this.onDiagnostic({
          event: "browser.page.closing.unnameable",
          page: entry.incarnation,
          surface: entry.surfaceId,
          closeAttempts: entry.attempts,
        });
        this.notify(this.drains);
      }
      next();
    });
  }

  /** The engine's confirmation is the only way out of the registry. */
  private gone(entry: NativePage): boolean {
    if (entry.state === "absent") return true;
    if (!entry.page.isClosed()) return false;
    this.confirm(entry, "closed-check");
    return true;
  }

  private confirm(
    entry: NativePage,
    confirmedBy: "page-event" | "context-end" | "closed-check",
  ): void {
    if (entry.state === "absent") return;
    const reason = entry.state === "closing" && entry.reason ? entry.reason : "native-gone";
    const closingMs = entry.state === "closing" ? Date.now() - entry.closingSince : null;
    entry.state = "absent";
    entry.reason = reason;
    entry.attempt = null;
    clearTimeout(entry.retryTimer);
    clearTimeout(entry.admitTimer);
    entry.page.offClose(entry.onGone);
    entry.stopRenderer?.();
    this.held.delete(entry);
    const context = entry.context;
    entry.context = null;
    const adopted = context ? this.contexts.get(context) : undefined;
    if (context && adopted && --adopted.pages === 0 && adopted.released) this.forget(context);
    this.endings[reason] = (this.endings[reason] ?? 0) + 1;
    this.onDiagnostic({
      event: "browser.page.ended",
      page: entry.incarnation,
      surface: entry.surfaceId,
      reason,
      confirmedBy,
      rendererGone: entry.rendererGone,
      lifetimeMs: Date.now() - entry.createdAt,
      closingMs,
      closeAttempts: entry.attempts,
    });
    try {
      entry.onConfirmed?.(entry.incarnation, {
        requested: reason !== "native-gone",
        confirmedBy,
      });
    } catch {
      // An owner's disposition cannot keep a confirmed page in the registry.
    }
    entry.settled.resolve();
    this.notify(this.drains);
    this.stopIfDrained();
    const sample = entry.page.rendererExit?.bind(entry.page);
    if (sample && !this.stopped) {
      const timer = setTimeout(() => {
        let outcome: RendererExit | null = null;
        try {
          outcome = sample();
        } catch {
          return;
        }
        if (outcome)
          this.onDiagnostic({
            event: "browser.page.renderer.sampled",
            page: entry.incarnation,
            sampledAfterMs: rendererSampleAfterMs,
            outcome,
          });
      }, rendererSampleAfterMs);
      timer.unref?.();
    }
  }

  private closing(entry: NativePage): Closing {
    return {
      page: entry.incarnation,
      surface: entry.surfaceId,
      reason: entry.reason ?? "native-gone",
      closingMs: Date.now() - entry.closingSince,
      closeAttempts: entry.attempts,
    };
  }

  private within(entries: readonly NativePage[], withinMs: number): Promise<boolean> {
    return this.until(() => entries.some((entry) => !this.gone(entry)), withinMs);
  }

  /** Resolves true once `busy` is false, false at `withinMs`. */
  private until(busy: () => boolean, withinMs: number): Promise<boolean> {
    if (!busy()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const check = () => {
        if (busy()) return;
        finish(true);
      };
      const finish = (drained: boolean) => {
        clearTimeout(timer);
        this.drains.delete(check);
        resolve(drained);
      };
      const timer = setTimeout(() => finish(!busy()), withinMs);
      timer.unref?.();
      this.drains.add(check);
    });
  }

  private notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of listeners) listener();
  }
}

function admissible(entry: NativePage): boolean {
  return (entry.state === "provisional" || entry.state === "live") && !entry.page.isClosed();
}

function findable(entry: NativePage, session: string): boolean {
  return admissible(entry) && (entry.session === null || entry.session === session);
}
