import type { BrowserSurfaceId } from "@opensteer/protocol/browser";
import { randomUUID } from "node:crypto";
import type { BrowserPage, RendererExit } from "./backend.js";

/**
 * Where one native page is. Destruction is irreversible: a page asked to end
 * stays `closing`, owned, until its engine confirms it is gone. A close that
 * resolves proves nothing.
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
  /** The renderer crashed, then the engine ended the page unasked. */
  | "crashed"
  /** The engine ended the page unasked, as a page's own `window.close()` does. */
  | "native-gone";

/** Ids, states, reasons, durations and counts only: never anything from a page. */
export type BrowserPageDiagnostic =
  | {
      readonly event: "browser.page.ended";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      readonly reason: PageEndReason;
      readonly lifetimeMs: number;
      readonly closingMs: number | null;
      readonly closeAttempts: number;
    }
  | {
      readonly event: "browser.page.closing.stuck";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      readonly reason: PageEndReason;
      readonly closingMs: number;
      readonly closeAttempts: number;
    }
  | {
      readonly event: "browser.page.renderer.crashed";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      readonly state: NativePageState;
    }
  | {
      readonly event: "browser.page.renderer.exit";
      readonly page: string;
      readonly outcome: RendererExit;
    }
  | {
      readonly event: "browser.page.sleep.refused";
      readonly page: string;
      readonly surface: BrowserSurfaceId | null;
      readonly reason: string;
      /** The reason this replaces, and how many refusals it covered. */
      readonly previous: string | null;
      readonly previousAttempts: number;
    };

export interface PageCounts {
  readonly states: Readonly<Record<Exclude<NativePageState, "absent">, number>>;
  readonly ended: Readonly<Partial<Record<PageEndReason, number>>>;
  readonly sleepRefusals: Readonly<Record<string, number>>;
}

const transitions: Readonly<Record<NativePageState, readonly NativePageState[]>> = {
  provisional: ["live", "closing", "absent"],
  live: ["closing", "absent"],
  closing: ["absent"],
  absent: [],
};

const stuckClosingMs = 10_000;
const retryBaseMs = 1_000;
const retryCeilingMs = 30_000;
const maxCloseAttempts = 8;
/** A renderer outlives its page briefly while Chromium tears it down. */
const rendererSettleMs = 3_000;

interface NativePage {
  readonly incarnation: string;
  readonly page: BrowserPage;
  readonly createdAt: number;
  readonly confirmed: PromiseWithResolvers<void>;
  readonly onGone: () => void;
  stopCrash: (() => void) | undefined;
  state: NativePageState;
  surfaceId: BrowserSurfaceId | null;
  reason: PageEndReason | null;
  crashed: boolean;
  retry: boolean;
  closingSince: number;
  attempts: number;
  inflight: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  stuckTimer: ReturnType<typeof setTimeout> | undefined;
  refusal: { reason: string; attempts: number } | null;
}

/**
 * Every native page a runtime holds, one entry per materialization. Callers
 * ask; only the engine's confirmation (`BrowserPage.onClose`/`isClosed`) ends
 * an entry. One instance serves a whole runtime so its counts are the
 * runtime's.
 */
export class PageOwnership {
  private readonly pages = new WeakMap<BrowserPage, NativePage>();
  private readonly held = new Set<NativePage>();
  private readonly ended: Partial<Record<PageEndReason, number>> = {};
  private readonly refusals: Record<string, number> = {};
  private readonly onDiagnostic: (diagnostic: BrowserPageDiagnostic) => void;
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

  /** Owns a page the runtime made or adopted. Idempotent; returns its incarnation. */
  track(page: BrowserPage): string {
    const existing = this.pages.get(page);
    if (existing) return existing.incarnation;
    const entry: NativePage = {
      incarnation: randomUUID(),
      page,
      createdAt: Date.now(),
      confirmed: Promise.withResolvers<void>(),
      onGone: () => this.confirm(entry),
      stopCrash: undefined,
      state: "provisional",
      surfaceId: null,
      reason: null,
      crashed: false,
      retry: false,
      closingSince: 0,
      attempts: 0,
      inflight: null,
      retryTimer: undefined,
      stuckTimer: undefined,
      refusal: null,
    };
    this.pages.set(page, entry);
    this.held.add(entry);
    page.onClose(entry.onGone);
    entry.stopCrash = page.onRendererGone?.(() => {
      entry.crashed = true;
      this.onDiagnostic({
        event: "browser.page.renderer.crashed",
        page: entry.incarnation,
        surface: entry.surfaceId,
        state: entry.state,
      });
    });
    if (page.isClosed()) this.confirm(entry);
    return entry.incarnation;
  }

  /** The page now backs a tab. A page already asked to end never becomes live again. */
  admit(page: BrowserPage, surfaceId: BrowserSurfaceId): void {
    const entry = this.pages.get(page);
    if (!entry) return;
    entry.surfaceId = surfaceId;
    if (entry.state === "provisional") this.move(entry, "live");
  }

  /**
   * Asks the engine to end a page. Resolves or rejects with that one attempt;
   * ownership ends only on confirmation. `retry` keeps asking, with backoff,
   * where nothing else would ever ask again.
   */
  destroy(page: BrowserPage, reason: PageEndReason, retry = true): Promise<void> {
    this.track(page);
    const entry = this.pages.get(page)!;
    if (entry.state === "absent") return Promise.resolve();
    entry.reason = reason;
    entry.retry ||= retry;
    if (entry.state !== "closing") {
      this.move(entry, "closing");
      entry.closingSince = Date.now();
      entry.stuckTimer = unref(
        setTimeout(() => {
          if (entry.state !== "closing") return;
          this.onDiagnostic({
            event: "browser.page.closing.stuck",
            page: entry.incarnation,
            surface: entry.surfaceId,
            reason: entry.reason!,
            closingMs: Date.now() - entry.closingSince,
            closeAttempts: entry.attempts,
          });
        }, stuckClosingMs),
      );
    }
    return this.attempt(entry);
  }

  /** True once the engine confirmed the page gone; an untracked page answers for itself. */
  gone(page: BrowserPage): boolean {
    const entry = this.pages.get(page);
    if (entry?.state === "absent") return true;
    if (!page.isClosed()) return false;
    if (entry) this.confirm(entry);
    return true;
  }

  /** Settles once the engine confirms the page gone. */
  confirmed(page: BrowserPage): Promise<void> {
    if (this.gone(page)) return Promise.resolve();
    return this.pages.get(page)?.confirmed.promise ?? Promise.resolve();
  }

  stateOf(page: BrowserPage): NativePageState | undefined {
    this.gone(page);
    return this.pages.get(page)?.state;
  }

  incarnationOf(page: BrowserPage): string | undefined {
    return this.pages.get(page)?.incarnation;
  }

  /** Records why a page was not slept; logs only when the reason changes. */
  refuseSleep(page: BrowserPage, reason: string): void {
    const entry = this.pages.get(page);
    if (!entry || entry.state === "absent") return;
    this.refusals[reason] = (this.refusals[reason] ?? 0) + 1;
    if (entry.refusal?.reason === reason) {
      entry.refusal.attempts++;
      return;
    }
    this.onDiagnostic({
      event: "browser.page.sleep.refused",
      page: entry.incarnation,
      surface: entry.surfaceId,
      reason,
      previous: entry.refusal?.reason ?? null,
      previousAttempts: entry.refusal?.attempts ?? 0,
    });
    entry.refusal = { reason, attempts: 1 };
  }

  counts(): PageCounts {
    const states = { provisional: 0, live: 0, closing: 0 };
    for (const entry of this.held) if (entry.state !== "absent") states[entry.state]++;
    return { states, ended: { ...this.ended }, sleepRefusals: { ...this.refusals } };
  }

  /** Stops timers at runtime shutdown; entries stay as they are. */
  stop(): void {
    this.stopped = true;
    for (const entry of this.held) {
      clearTimeout(entry.retryTimer);
      clearTimeout(entry.stuckTimer);
    }
  }

  private attempt(entry: NativePage): Promise<void> {
    if (entry.inflight) return entry.inflight;
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    entry.attempts++;
    let closing: Promise<void>;
    try {
      closing = Promise.resolve(entry.page.close());
    } catch (error) {
      closing = Promise.reject(error);
    }
    entry.inflight = closing;
    const settled = () => {
      entry.inflight = null;
      if (entry.state !== "closing" || this.gone(entry.page)) return;
      if (!entry.retry || this.stopped || entry.attempts >= maxCloseAttempts) return;
      entry.retryTimer = unref(
        setTimeout(
          () => {
            entry.retryTimer = undefined;
            if (entry.state === "closing" && !this.stopped)
              void this.attempt(entry).catch(() => undefined);
          },
          Math.min(retryCeilingMs, retryBaseMs * 2 ** (entry.attempts - 1)),
        ),
      );
    };
    void closing.then(settled, settled);
    return closing;
  }

  private confirm(entry: NativePage): void {
    if (entry.state === "absent") return;
    const reason =
      entry.state === "closing" && entry.reason
        ? entry.reason
        : entry.crashed
          ? "crashed"
          : "native-gone";
    const closingMs = entry.state === "closing" ? Date.now() - entry.closingSince : null;
    this.move(entry, "absent");
    entry.reason = reason;
    clearTimeout(entry.retryTimer);
    clearTimeout(entry.stuckTimer);
    entry.page.offClose(entry.onGone);
    entry.stopCrash?.();
    this.held.delete(entry);
    this.ended[reason] = (this.ended[reason] ?? 0) + 1;
    this.onDiagnostic({
      event: "browser.page.ended",
      page: entry.incarnation,
      surface: entry.surfaceId,
      reason,
      lifetimeMs: Date.now() - entry.createdAt,
      closingMs,
      closeAttempts: entry.attempts,
    });
    entry.confirmed.resolve();
    const exit = entry.page.rendererExit?.bind(entry.page);
    if (exit && !this.stopped)
      unref(
        setTimeout(() => {
          let outcome: RendererExit | null = null;
          try {
            outcome = exit();
          } catch {
            return;
          }
          if (outcome)
            this.onDiagnostic({
              event: "browser.page.renderer.exit",
              page: entry.incarnation,
              outcome,
            });
        }, rendererSettleMs),
      );
  }

  private move(entry: NativePage, to: NativePageState): void {
    if (!transitions[entry.state].includes(to))
      throw new Error(`A native page cannot go from ${entry.state} to ${to}.`);
    entry.state = to;
  }
}

function unref<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  timer.unref?.();
  return timer;
}
