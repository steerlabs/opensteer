import { totalmem } from "node:os";
import type { BrowserSurfaceId, BrowserSessionState } from "@opensteer/protocol/browser";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { BrowserMemoryPressure, BrowserRendererUsage } from "./backend.js";
import type { PageCounts, SleepBlocker } from "./page-ownership.js";
import type { SurfaceLedger, TabRecord } from "./surface-ledger.js";

const quietMs = 10_000;
/**
 * TS16: desktop Chrome protects a tab for ten minutes after it was last visible
 * (kRecentlyVisible, kNonVisiblePagesUrgentProtectionTime in Chromium 151).
 */
const recentlyViewedMs = 10 * 60_000;
const leftoverMs = 60_000;
const readIdleMs = 120_000;
const readKeep = 8;
const pageEstimateBytes = 100 * 1024 ** 2;
const processHostEstimateBytes = 150 * 1024 ** 2;
const budgetFloorBytes = 2 * 1024 ** 3;
const budgetCeilingBytes = 8 * 1024 ** 3;
const budgetShare = 0.25;
const budgetReleaseShare = 0.85;
/**
 * Linux memory-pressure thresholds (container working set `memory.current - inactive_file`
 * against `memory.max`, or bare-Linux `MemTotal - MemAvailable` against `MemTotal`).
 * Run 2 on 4 GiB Linux hit 3,247 MiB (79.3%) peak and 2,650 MiB (64.7%) settled across 70
 * live tabs; starting at 70% and stopping at 60% leaves headroom for a sudden 500 MiB spike
 * and scales down cleanly to 2 GiB pooled guests without premature sleeping.
 */
export const linuxMemorySleepStartRatio = 0.7;
export const linuxMemorySleepStopRatio = 0.6;
const linuxPressureSampleMs = 2_000;
const linuxPressureSettleMs = 500;
/** A reading taken as a page opens is bounded; a slow one is skipped, never waited out. */
const openPressureReadMs = 250;
/** Under pressure, how long an open waits for the sleeps it started. */
const openPressureWaitMs = 2_000;
/** How long a page goes on taking memory after it opens, while it loads. */
const pageGrowthMs = 5_000;
const restoreBudgetBytes = 64 * 1024 ** 2;
const sleepsPerPass = 8;
const concurrentSleeps = 4;
const rendererSampleMs = 30_000;
const pressureScanMs = 1_000;
const rendererSettleMs = 3_000;
const ineffectiveReclaimsBeforeBackoff = 3;
const minimumReclaimBytes = 16 * 1024 ** 2;
const reportMemoryChangeBytes = 64 * 1024 ** 2;
/** Refused attempts alone change the summary at most this often. */
const reportRefusalsMs = 60_000;

export interface TabSleepPass {
  readonly livePages: number;
  readonly rendererProcesses: number;
  readonly rendererResidentBytes: number | null;
  readonly unassignedRendererProcesses: number;
  /** The runtime's native pages, so a change in them is never throttled away. */
  readonly pages?: PageCounts;
  readonly underPressure: 0 | 1;
  readonly attempted: number;
  readonly slept: number;
}

export interface SleepHost {
  readonly key: string;
  readonly kind: "fresh" | "local";
  readonly lastUsed: number;
  readonly sessionIds: readonly string[];
  readonly blocked: boolean;
}
interface TabSleeperOptions {
  readonly scheduling?: boolean;
  readonly memoryBudgetBytes?: number | undefined;
  readonly memory?: () => { total: number; available: number };
  readonly hostCost?: "process" | "partition" | undefined;
  readonly hosts?: () => readonly SleepHost[];
  readonly retireHost?: (key: string) => Promise<void>;
  readonly rendererUsage?: (() => BrowserRendererUsage | Promise<BrowserRendererUsage>) | undefined;
  readonly memoryPressure?:
    (() => BrowserMemoryPressure | null | Promise<BrowserMemoryPressure | null>) | undefined;
  readonly onPass?: ((pass: TabSleepPass) => void) | undefined;
  readonly pageCounts?: (() => PageCounts) | undefined;
  /** Native pages with no live tab across the runtime, those of ended sessions included. */
  readonly untabbedPages?: (() => number) | undefined;
}

interface SleepSession {
  readonly ledger: SurfaceLedger;
  readonly restoreVersion?: 1 | undefined;
  readonly blocked: (id: BrowserSurfaceId) => SleepBlocker | null;
  /**
   * Null when the session's tabs may sleep now; otherwise when they may (its browser's look for the
   * tab helper after launch). A fact about the browser, not a tab: none of its tabs is probed
   * meanwhile, and its end is a pass (R4).
   */
  readonly sleepReady?: (() => Promise<void> | null) | undefined;
}
interface HeldSession extends SleepSession {
  hostState: BrowserSessionState | null;
  releasedAt: number;
  /** TS16: when each tab last stopped being viewed. */
  readonly viewedUntil: Map<BrowserSurfaceId, number>;
  stop(): void;
}

/** Runtime-wide scheduling; the ledger alone commits page transitions. */
export class TabSleeper {
  private readonly sessions = new Map<string, HeldSession>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly nextProbe = new WeakMap<TabRecord, number>();
  private running = false;
  private closed = false;
  private rendererUsage: BrowserRendererUsage | null = null;
  private nextRendererSample = 0;
  private samplingRenderers = false;
  /** When the last memory reading was taken, and when a tab last went to sleep (TS12). */
  private memorySampledAt = Number.NEGATIVE_INFINITY;
  private lastSleptAt = Number.NEGATIVE_INFINITY;
  private memoryPressureState: {
    readonly known: boolean;
    readonly reading: BrowserMemoryPressure | null;
  } = {
    known: false,
    reading: null,
  };
  private nextPressureSample = 0;
  private samplingPressure = false;
  private pendingAsyncPressurePass = false;
  /** An open over the threshold asked for a pass: it runs past a backoff, never past a settle. */
  private openAsked = false;
  /** TS13: the turn of the last open admitted over the threshold; it ends once its page exists. */
  private openTurn: Promise<void> = Promise.resolve();
  /**
   * TS8: sessions whose look for the tab helper ended over the threshold. The next pass sleeps
   * their tabs through any backoff, once; only a reclaim still settling holds it.
   */
  private readonly readyUnderPressure = new Set<SleepSession>();
  /** Looks already watched, so each one's end asks for one pass. */
  private readonly watchedLooks = new WeakSet<Promise<void>>();
  /** Sleeps a pass has started and not finished: their memory is on its way back (M4). */
  private reclaimInFlight = 0;
  private readonly passWaiters: Array<() => void> = [];
  private declined = new WeakSet<TabRecord>();
  private reclaimFrom: {
    usage: BrowserRendererUsage | null;
    pressureUsedBytes: number | null;
    settledAt: number;
    /** When it began: pages opened shortly before or since still grow, and confound it. */
    startedAt: number;
    /** Its sample waits once, for the slept pages' confirmation or a cutoff. */
    waiting: boolean;
  } | null = null;
  /** When the last open went ahead past the pressure gate. */
  private lastOpenAt = Number.NEGATIVE_INFINITY;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private ineffectiveReclaims = 0;
  private pressureBackoffUntil = 0;
  private lastReportedPass: TabSleepPass | null = null;
  private lastReportedAt = 0;

  private releasing = false;
  private readonly options: TabSleeperOptions;
  constructor(options: TabSleeperOptions = {}) {
    this.options = options;
  }
  private memory() {
    return (
      this.options.memory?.() ?? {
        total: process.constrainedMemory() || totalmem(),
        available: process.availableMemory(),
      }
    );
  }
  private budget(): number {
    return (
      this.options.memoryBudgetBytes ??
      Math.max(budgetFloorBytes, Math.min(budgetCeilingBytes, this.memory().total * budgetShare))
    );
  }
  /** Pages without a live tab still use the browser until their engine confirms them gone. */
  private untabbedPages(): number {
    if (this.options.untabbedPages) return this.options.untabbedPages();
    let pages = 0;
    for (const session of this.sessions.values()) pages += session.ledger.untabbedPages();
    return pages;
  }
  private estimate(): number {
    let pages = this.untabbedPages();
    for (const session of this.sessions.values())
      for (const record of session.ledger.policyRecords()) if (record.live) pages++;
    return (
      pages * pageEstimateBytes +
      (this.options.hostCost === "process"
        ? (this.options.hosts?.().length ?? 0) * processHostEstimateBytes
        : 0)
    );
  }
  private usesLinuxMemoryPressure(): boolean {
    return (
      this.options.memoryBudgetBytes === undefined && this.options.memoryPressure !== undefined
    );
  }
  private overBudget(pendingPages = 0): boolean {
    if (this.usesLinuxMemoryPressure()) {
      const pressure = this.memoryPressureState.reading;
      if (pressure && pressure.limitBytes > 0) {
        const ratio = pressure.usedBytes / pressure.limitBytes;
        if (ratio > linuxMemorySleepStartRatio) this.releasing = true;
        if (ratio <= linuxMemorySleepStopRatio) this.releasing = false;
        return this.releasing;
      }
      // Memory pressure reading is unknown/unavailable: fall back to the page estimate for this pass.
      const estimate = this.estimate() - pendingPages * pageEstimateBytes;
      const budget = this.budget();
      if (estimate > budget) this.releasing = true;
      if (estimate <= budget * budgetReleaseShare) this.releasing = false;
      return this.releasing;
    }
    const estimate =
      this.rendererUsage?.bytes ?? this.estimate() - pendingPages * pageEstimateBytes;
    const budget = this.budget();
    if (estimate > budget) this.releasing = true;
    if (estimate <= budget * budgetReleaseShare) this.releasing = false;
    return this.releasing;
  }
  private trimRestore(): void {
    const records = [...this.sessions.values()]
      .flatMap((session) =>
        [...session.ledger.policyRecords()].map((record) => ({ session, record })),
      )
      .filter(({ record }) => record.lease.state === "suspended" && record.restore?.engine != null);
    let bytes = records.reduce((sum, { record }) => sum + (record.restore?.bytes ?? 0), 0);
    for (const { session, record } of records.sort((a, b) => a.record.usedAt - b.record.usedAt)) {
      if (bytes <= restoreBudgetBytes) break;
      bytes -= record.restore!.bytes;
      session.ledger.releaseRestore(record);
    }
  }
  private canRetire(host: SleepHost): boolean {
    return (
      host.kind === "fresh" &&
      !host.blocked &&
      host.sessionIds.every((id) => {
        const session = this.sessions.get(id);
        const state = session?.hostState;
        return (
          session &&
          state &&
          !state.keepAwake &&
          state.runs === 0 &&
          state.viewed.length === 0 &&
          state.pinned.length === 0 &&
          // A page still closing keeps its process: retirement waits for confirmed release.
          session.ledger.untabbedPages() === 0 &&
          [...session.ledger.policyRecords()].every(
            (record) => !record.live && !session.blocked(record.id),
          )
        );
      })
    );
  }
  canRetireHost(key: string): boolean {
    return this.retirementCandidates().some((host) => host.key === key);
  }
  private retirementCandidates(): readonly SleepHost[] {
    const memory = this.memory();
    if (
      this.options.hostCost !== "process" ||
      !this.options.retireHost ||
      this.estimate() <= this.budget() ||
      memory.available >= memory.total * 0.1
    )
      return [];
    return (this.options.hosts?.() ?? [])
      .filter((host) => this.canRetire(host))
      .sort((a, b) => a.lastUsed - b.lastUsed);
  }
  private category(session: HeldSession, record: TabRecord): number {
    if (session.hostState?.runs === 0 && record.origin === "agent" && !record.personUsed) return 0;
    if (!record.personUsed && !record.agentActed) return 1;
    return 2;
  }
  private readCutoff(session: HeldSession): number {
    const runs = session.hostState?.runs ?? 0;
    if (runs === 0) return -Infinity;
    return (
      [...session.ledger.policyRecords()].map((record) => record.usedAt).sort((a, b) => b - a)[
        readKeep * runs - 1
      ] ?? -Infinity
    );
  }
  private deadline(
    session: HeldSession,
    record: TabRecord,
    cutoff = this.readCutoff(session),
  ): number {
    const runs = session.hostState?.runs;
    if (runs === undefined) return Infinity;
    if (runs === 0 && this.category(session, record) === 0)
      return Math.max(record.usedAt, session.releasedAt) + leftoverMs;
    if (runs > 0 && !record.personUsed && !record.agentActed) {
      if (record.usedAt < cutoff) return record.usedAt + readIdleMs;
    }
    return Infinity;
  }
  add(id: string, session: SleepSession): void {
    this.remove(id);
    const stopPolicy = session.ledger.onPolicyChanged(() => this.poke());
    this.sessions.set(id, {
      ...session,
      hostState: null,
      releasedAt: Date.now(),
      viewedUntil: new Map(),
      stop: () => {
        stopPolicy();
      },
    });
    this.poke();
  }
  remove(id: string): void {
    this.sessions.get(id)?.stop();
    this.sessions.delete(id);
    this.poke();
  }
  resetSessionState(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.hostState = null;
    this.poke();
  }
  poolState(id: string): BrowserSessionState | null {
    return this.sessions.get(id)?.hostState ?? null;
  }
  setSessionState(id: string, state: BrowserSessionState): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (
      state.runs === 0 &&
      (session.hostState === null ||
        session.hostState.runs > 0 ||
        (session.hostState.keepAwake && !state.keepAwake))
    )
      session.releasedAt = Date.now();
    const now = Date.now();
    for (const surfaceId of session.hostState?.viewed ?? [])
      if (!state.viewed.includes(surfaceId)) session.viewedUntil.set(surfaceId, now);
    session.hostState = state;
    for (const surfaceId of state.personUsed) session.ledger.markPersonUsed(surfaceId);
    this.poke();
  }
  private openerLinks(session: SleepSession): ReadonlySet<BrowserSurfaceId> {
    const records = [...session.ledger.policyRecords()];
    const live = new Set(records.filter((record) => record.live).map((record) => record.id));
    const linked = new Set<BrowserSurfaceId>();
    for (const record of records)
      if (
        record.live &&
        !record.live.page.hasOpenerAccess &&
        record.openerId &&
        live.has(record.openerId)
      ) {
        linked.add(record.id);
        linked.add(record.openerId);
      }
    return linked;
  }
  /**
   * Why a page may not sleep now, or null. With `young`, the quiet period is not asked: under
   * memory pressure it is a preference, while every other blocker (the page being in use) stays.
   */
  blocked(
    id: string,
    record: TabRecord,
    now: number,
    links?: ReadonlySet<BrowserSurfaceId>,
    young = false,
    /** The last resort under pressure: a tab a live agent is bound to may sleep (TS12). */
    lastResort = false,
    /** As if the session's look for the tab helper had ended (TS13). */
    afterLook = false,
  ): SleepBlocker | null {
    const session = this.sessions.get(id);
    const state = session?.hostState;
    if (!session || !state || state.keepAwake) return "host-state";
    if (session.ledger.closing) return "closing";
    if (!afterLook && this.lookOf(session)) return "tab-helper";
    if (state.viewed.includes(record.id)) return "viewed";
    if (state.pinned.includes(record.id)) return "pinned";
    const external = session.blocked(record.id);
    if (external) return external;
    if (record.lease.busy || !["live", "sleeping"].includes(record.lease.state)) return "operation";
    if (state.runs > 0 && record.agentActed) return "agent-input";
    // TS12: a tab a live Run or connected agent's session works in is slept last, only when nothing
    // else is left and memory is still over the threshold; an agent that comes back finds it as
    // it left it.
    if (!lastResort && state.runs > 0 && state.agentTabs?.includes(record.id)) return "agent-bound";
    // TS16: what desktop Chrome protects (kRecentlyVisible), slept only as a last resort: a tab a
    // person saw in the last ten minutes.
    if (!lastResort && now - (session.viewedUntil.get(record.id) ?? -Infinity) < recentlyViewedMs)
      return "recently-viewed";
    if (record.typed) return "typed";
    if (!young && now - record.usedAt < quietMs) return "quiet";
    const live = record.live;
    if (!live) return "suspended";
    if (live.dialog) return "dialog";
    if (live.loading || live.pendingNavigations.size) return "loading";
    if (record.unrestorable) return "unrestorable";
    if (
      !["http:", "https:", "about:blank"].some((scheme) =>
        scheme === "about:blank" ? record.url === scheme : record.url.startsWith(scheme),
      )
    )
      return "address";
    if (session.restoreVersion !== 1) return "restore-version";
    if ((links ?? this.openerLinks(session)).has(record.id)) return "opener";
    return null;
  }
  poke(minimumDelay = 0): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.running || this.options.scheduling === false) return;
    this.trimRestore();
    const now = Date.now();
    // The reclaim waiting on confirmation is sampled as soon as that arrives.
    if (this.reclaimFrom?.waiting && this.untabbedPages() === 0) {
      this.reclaimFrom.settledAt = Math.min(this.reclaimFrom.settledAt, now);
      this.nextRendererSample = Math.min(this.nextRendererSample, now);
      this.nextPressureSample = Math.min(this.nextPressureSample, now);
    }
    const pressureDriven = this.usesLinuxMemoryPressure();
    const budget =
      (!this.options.rendererUsage && !pressureDriven && this.overBudget()) ||
      (this.pendingAsyncPressurePass &&
        this.releasing &&
        now >= this.pressureHoldUntil(this.readyUnderPressure));
    let earliest = Infinity;
    for (const [id, session] of this.sessions) {
      const links = this.openerLinks(session);
      const cutoff = this.readCutoff(session);
      for (const record of session.ledger.policyRecords()) {
        if (!record.live) continue;
        if (this.options.rendererUsage) earliest = Math.min(earliest, this.nextRendererSample);
        if (pressureDriven) earliest = Math.min(earliest, this.nextPressureSample);
        const reason = this.blocked(id, record, now, links);
        // Explains a page that is due, or that Host facts keep from ever coming due.
        session.ledger.noteSleepBlocker(
          record.id,
          reason === "host-state" ||
            (reason &&
              reason !== "quiet" &&
              (budget || this.releasing || this.deadline(session, record, cutoff) <= now))
            ? reason
            : null,
        );
        // A protection that ends by time is looked at again when it ends.
        if (reason === "recently-viewed")
          earliest = Math.min(
            earliest,
            Math.max(
              session.viewedUntil.get(record.id)! + recentlyViewedMs,
              this.deadline(session, record, cutoff),
            ),
          );
        if (reason && reason !== "quiet") continue;
        // Under pressure a tab only quiet-blocked is a candidate now: the quiet period is a
        // preference there, not a protection.
        const young =
          reason === "quiet" &&
          budget &&
          pressureDriven &&
          this.blocked(id, record, now, links, true) === null;
        earliest = Math.min(
          earliest,
          Math.max(
            budget ? now : this.deadline(session, record, cutoff),
            young ? now : record.usedAt + quietMs,
            this.nextProbe.get(record) ?? 0,
          ),
        );
      }
    }
    if (this.retirementCandidates().length) earliest = Math.min(earliest, now);
    if (!Number.isFinite(earliest)) {
      // Nothing will run: every page is blocked or not due. Summarize that state anyway.
      if (this.options.onPass && this.sessions.size) this.reportPass(this.summary(0, 0));
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.pass();
      },
      Math.max(minimumDelay, earliest - now),
    );
    this.timer.unref();
  }
  /**
   * The Linux pressure rule, evaluated as a page is about to open instead of waiting for its
   * timer: same reading, same thresholds. Over the start threshold, the open waits (bounded) for
   * the pass that sheds other tabs, so a burst is paced by sleeping rather than by the kernel.
   */
  async beforePageOpen(): Promise<() => void> {
    const nothing = () => undefined;
    if (!this.options.memoryPressure || !this.usesLinuxMemoryPressure() || this.closed)
      return nothing;
    // TS13: over the threshold, opens go one at a time: each waits, within its own bound, for the
    // open before it to have made its page, then reads memory afresh.
    let done: () => void = nothing;
    if (this.releasing) {
      const previous = this.openTurn;
      const turn = Promise.withResolvers<void>();
      this.openTurn = turn.promise;
      done = () => turn.resolve();
      await withTimeout(previous, openPressureWaitMs, {
        timeoutError: () => new Error("The open before this one did not finish."),
      }).catch(() => undefined);
    }
    try {
      await this.admitOpen(this.options.memoryPressure);
    } catch (error) {
      done();
      throw error;
    } finally {
      this.lastOpenAt = Date.now();
    }
    return done;
  }

  /**
   * A page arrived that no open of ours made (a popup, a new-tab link): it grows as it loads, and
   * over the threshold with a tab that can sleep the pass is asked for now, not at the next tick.
   * Its time only makes a reclaim overlapping that growth unmeasured; it never holds a pass back.
   */
  notePageArrived(): void {
    const now = Date.now();
    this.lastOpenAt = now;
    if (this.closed || !this.usesLinuxMemoryPressure() || !this.releasing) return;
    if (!this.canShedNow(now)) return;
    this.pendingAsyncPressurePass = true;
    this.poke();
  }

  private async admitOpen(
    measure: () => BrowserMemoryPressure | null | Promise<BrowserMemoryPressure | null>,
  ): Promise<void> {
    /** A fresh reading: true while the open is at or over the start threshold. */
    const over = async (): Promise<boolean> => {
      let reading: BrowserMemoryPressure | null;
      try {
        reading = await withTimeout(Promise.resolve(measure()), openPressureReadMs, {
          timeoutError: () => new Error("Memory pressure reading timed out."),
        });
      } catch {
        return false;
      }
      if (this.closed || reading === null) return false;
      this.applyMemoryPressureSample(reading, Date.now());
      return (
        this.releasing &&
        reading.limitBytes > 0 &&
        reading.usedBytes / reading.limitBytes > linuxMemorySleepStartRatio
      );
    };
    if (!(await over())) {
      if (this.releasing) {
        this.pendingAsyncPressurePass = true;
        this.poke();
      }
      return;
    }
    const now = Date.now();
    // M4: an open over the threshold waits, within its own bound, while a reclaim is in flight
    // (a tab detached, its memory not yet back) or settling (memory on its way down, which the
    // open would hide), or while some tab can sleep for it, asking for that pass even through a
    // backoff. Each time it is released it reads again and goes on once under the threshold. It
    // goes on when scheduling is off, or nothing can sleep and nothing is reclaiming: there is no
    // hard ceiling.
    const until = now + openPressureWaitMs;
    for (let first = true; ; first = false) {
      if (this.closed || (!first && !(await over()))) return;
      this.pendingAsyncPressurePass = true;
      const at = Date.now();
      const settleUntil =
        this.reclaimInFlight > 0
          ? until
          : this.reclaimFrom !== null && at < this.reclaimFrom.settledAt
            ? this.reclaimFrom.settledAt
            : 0;
      const canShed = this.canShedNow(at);
      // R4: no tab can sleep yet only because a browser's look for the tab helper is still
      // running: the open waits for it, within its own bound, then reads again.
      const look = canShed || settleUntil > at ? null : this.pendingLook();
      if (look && this.options.scheduling !== false && at < until) {
        await withTimeout(look, until - at, {
          timeoutError: () => new Error("The tab helper's look did not end."),
        }).catch(() => undefined);
        continue;
      }
      if (this.options.scheduling === false || (settleUntil <= at && !canShed) || at >= until) {
        this.poke();
        return;
      }
      if (canShed) this.openAsked = true;
      let release: () => void = () => undefined;
      const settled = new Promise<void>((resolve) => {
        release = resolve;
        this.passWaiters.push(resolve);
      });
      this.poke();
      // Waiting on a reclaim alone ends with it; waiting for a pass, within the open's bound.
      const bound = (canShed ? until : Math.min(until, settleUntil)) - at;
      await withTimeout(settled, Math.max(1, bound), {
        timeoutError: () => new Error("Pressure pass did not settle."),
      }).catch(() => {
        // A waiter that timed out leaves; it does not stay until some later pass ends.
        const index = this.passWaiters.indexOf(release);
        if (index >= 0) this.passWaiters.splice(index, 1);
      });
    }
  }

  /**
   * Until when a pressure pass sleeps nothing: a reclaim still settling always holds it; a backoff
   * after ineffective reclaims holds only the sleeper's own background passes (K9 corrected).
   */
  private pressureHoldUntil(ready: ReadonlySet<SleepSession> = new Set()): number {
    const settling = this.reclaimFrom?.settledAt ?? 0;
    // An open waiting, or a context that became ready under pressure (TS8), goes through a backoff.
    return this.openAsked || ready.size > 0
      ? settling
      : Math.max(this.pressureBackoffUntil, settling);
  }

  /**
   * The session's pending look for the tab helper, watched: its end asks for a pass at once
   * (under pressure through any backoff), instead of a probe on a clock.
   */
  private lookOf(session: SleepSession): Promise<void> | null {
    const look = session.sleepReady?.() ?? null;
    if (look && !this.watchedLooks.has(look)) {
      this.watchedLooks.add(look);
      void look
        .catch(() => undefined)
        .then(() => {
          if (this.closed) return;
          if (this.releasing) {
            this.pendingAsyncPressurePass = true;
            this.readyUnderPressure.add(session);
          }
          this.poke();
        });
    }
    return look;
  }

  /**
   * A pending look of a session with a tab that could sleep once it ends, for an open over the
   * threshold to wait on (TS13): a context whose every tab is protected sheds nothing for it.
   */
  private pendingLook(now = Date.now()): Promise<void> | null {
    const looks = [...this.sessions]
      .filter(([id, session]) => this.lookOf(session) && this.sheddableAfterLook(id, session, now))
      .map(([, session]) => this.lookOf(session)!);
    return looks.length ? Promise.race(looks) : null;
  }
  private sheddableAfterLook(id: string, session: HeldSession, now: number): boolean {
    const links = this.openerLinks(session);
    for (const record of session.ledger.policyRecords())
      if (record.live && this.blocked(id, record, now, links, true, false, true) === null)
        return true;
    return false;
  }

  /** Whether some page may sleep right now, whatever a backoff or a settle holds back. */
  private canShedNow(now: number): boolean {
    if (this.options.scheduling === false) return false;
    for (const [id, session] of this.sessions) {
      const links = this.openerLinks(session);
      for (const record of session.ledger.policyRecords()) {
        if (!record.live || (this.nextProbe.get(record) ?? 0) > now) continue;
        if (this.blocked(id, record, now, links, true, true) === null) return true;
      }
    }
    return false;
  }

  private releasePassWaiters(): void {
    for (const resolve of this.passWaiters.splice(0)) resolve();
  }

  private sampleMemoryPressure(): void {
    if (!this.usesLinuxMemoryPressure() || this.samplingPressure) return;
    const measure = this.options.memoryPressure;
    if (!measure) return;
    const now = Date.now();
    if (now < this.nextPressureSample) return;
    this.nextPressureSample =
      now + (this.releasing ? linuxPressureSettleMs : linuxPressureSampleMs);
    const result = measure();
    if (
      result &&
      typeof (result as PromiseLike<BrowserMemoryPressure | null>).then === "function"
    ) {
      this.samplingPressure = true;
      void Promise.resolve(result).then(
        (reading) => {
          this.samplingPressure = false;
          if (this.closed) return;
          this.applyMemoryPressureSample(reading, Date.now());
          if (this.releasing) this.pendingAsyncPressurePass = true;
          this.poke();
        },
        () => {
          this.samplingPressure = false;
          if (this.closed) return;
          this.applyMemoryPressureSample(null, Date.now());
          if (this.releasing) this.pendingAsyncPressurePass = true;
          this.poke();
        },
      );
      return;
    }
    this.applyMemoryPressureSample(result as BrowserMemoryPressure | null, now);
  }

  private applyMemoryPressureSample(reading: BrowserMemoryPressure | null, now: number): void {
    if (reading !== null) this.memorySampledAt = now;
    this.memoryPressureState = { known: reading !== null, reading };
    if (reading === null) {
      // Not known: the page estimate decides this pass, and nothing is recorded as a reclaim
      // that worked or did not, so no failure count or backoff is reset (Rule C).
      this.overBudget();
      return;
    }
    if (!this.overBudget()) {
      this.reclaimFrom = null;
      this.ineffectiveReclaims = 0;
      this.pressureBackoffUntil = 0;
      return;
    }
    this.nextPressureSample = Math.min(this.nextPressureSample, now + linuxPressureSettleMs);
    const reclaim = this.reclaimFrom;
    if (!reclaim || now < reclaim.settledAt) return;
    if (!reclaim.waiting && this.untabbedPages() > 0) {
      reclaim.waiting = true;
      reclaim.settledAt = now + linuxPressureSampleMs;
      return;
    }
    this.reclaimFrom = null;
    // A reclaim with no sample before it is unmeasured, never ineffective (K9).
    if (reclaim.pressureUsedBytes === null) return;
    // A page keeps taking memory for seconds after it opens, while it loads. A reclaim whose
    // window overlaps that growth is unmeasured, never ineffective: it may well have worked.
    if (this.lastOpenAt >= reclaim.startedAt - pageGrowthMs) return;
    if (reclaim.pressureUsedBytes - reading.usedBytes >= minimumReclaimBytes) {
      this.ineffectiveReclaims = 0;
    } else if (++this.ineffectiveReclaims >= ineffectiveReclaimsBeforeBackoff) {
      // The count stays until a reclaim works (Rule C): each further ineffective one backs off.
      this.pressureBackoffUntil = now + rendererSampleMs;
    }
  }

  private sampleRenderers(): void {
    this.sampleMemoryPressure();
    const measure = this.options.rendererUsage;
    if (!measure || this.samplingRenderers) return;
    const now = Date.now();
    if (now < this.nextRendererSample) return;
    this.nextRendererSample = now + rendererSampleMs;
    const result = measure();
    if (result && typeof (result as PromiseLike<BrowserRendererUsage>).then === "function") {
      this.samplingRenderers = true;
      void Promise.resolve(result).then(
        (usage) => {
          this.samplingRenderers = false;
          if (this.closed) return;
          this.applyRendererSample(usage, Date.now());
          if (this.releasing && !this.usesLinuxMemoryPressure())
            this.pendingAsyncPressurePass = true;
          this.poke();
        },
        () => {
          this.samplingRenderers = false;
        },
      );
      return;
    }
    this.applyRendererSample(result as BrowserRendererUsage, now);
  }

  private applyRendererSample(usage: BrowserRendererUsage, now: number): void {
    this.rendererUsage = usage;
    if (this.usesLinuxMemoryPressure()) {
      // Under Linux memory-pressure mode, rendererUsage is kept for reporting only.
      return;
    }
    if (!this.overBudget()) {
      this.reclaimFrom = null;
      this.ineffectiveReclaims = 0;
      this.pressureBackoffUntil = 0;
      return;
    }
    const reclaim = this.reclaimFrom;
    if (!reclaim || now < reclaim.settledAt) return;
    // A sleep is a request: its memory is judged once its pages are confirmed gone, or once at a cutoff.
    if (!reclaim.waiting && this.untabbedPages() > 0) {
      reclaim.waiting = true;
      reclaim.settledAt = now + rendererSampleMs;
      return;
    }
    this.reclaimFrom = null;
    if (
      (reclaim.usage && usage.processes < reclaim.usage.processes) ||
      (usage.bytes !== null &&
        reclaim.usage?.bytes !== null &&
        reclaim.usage !== null &&
        reclaim.usage.bytes - usage.bytes >= minimumReclaimBytes)
    ) {
      this.ineffectiveReclaims = 0;
    } else if (++this.ineffectiveReclaims >= ineffectiveReclaimsBeforeBackoff) {
      this.ineffectiveReclaims = 0;
      this.pressureBackoffUntil = now + rendererSampleMs;
    }
  }

  private reportPass(pass: TabSleepPass): void {
    const last = this.lastReportedPass;
    const unchanged =
      last &&
      !pass.slept &&
      last.livePages === pass.livePages &&
      last.underPressure === pass.underPressure &&
      !this.countChanged(last.rendererProcesses, pass.rendererProcesses) &&
      !this.countChanged(last.unassignedRendererProcesses, pass.unassignedRendererProcesses) &&
      sameStructure(last.pages, pass.pages) &&
      (last.rendererResidentBytes === pass.rendererResidentBytes ||
        (last.rendererResidentBytes !== null &&
          pass.rendererResidentBytes !== null &&
          Math.abs(last.rendererResidentBytes - pass.rendererResidentBytes) <
            Math.max(reportMemoryChangeBytes, last.rendererResidentBytes / 10)));
    if (unchanged && sameRefusals(last.pages, pass.pages)) return;
    const wait = this.lastReportedAt + reportRefusalsMs - Date.now();
    if (unchanged && wait > 0) {
      // Refusals alone report at most once a minute, and the last of them is never dropped.
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        if (!this.closed && this.options.onPass) this.reportPass(this.summary(0, 0));
      }, wait);
      this.flushTimer.unref?.();
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.lastReportedPass = pass;
    this.lastReportedAt = Date.now();
    this.options.onPass?.(pass);
  }

  private summary(attempted: number, slept: number): TabSleepPass {
    let livePages = 0;
    for (const session of this.sessions.values())
      for (const record of session.ledger.policyRecords()) if (record.live) livePages++;
    return {
      livePages,
      rendererProcesses: this.rendererUsage?.processes ?? 0,
      rendererResidentBytes: this.rendererUsage?.bytes ?? null,
      unassignedRendererProcesses: this.rendererUsage?.unassignedProcesses ?? 0,
      underPressure: this.releasing ? 1 : 0,
      attempted,
      slept,
      ...(this.options.pageCounts ? { pages: this.options.pageCounts() } : {}),
    };
  }

  private countChanged(previous: number, next: number): boolean {
    return Math.abs(previous - next) >= Math.max(1, Math.ceil(previous / 10));
  }

  private async pass(): Promise<void> {
    this.running = true;
    let attempted = 0;
    let slept = 0;
    let livePages = 0;
    const pending = new Set<Promise<void>>();
    // TS8: the sessions that became ready under pressure, let through any backoff by this pass.
    const ready = new Set(this.readyUnderPressure);
    this.readyUnderPressure.clear();
    const holdUntil = (session: SleepSession) =>
      this.pressureHoldUntil(ready.has(session) ? ready : undefined);
    try {
      this.pendingAsyncPressurePass = false;
      this.sampleRenderers();
      const candidates = [...this.sessions].flatMap(([id, session]) =>
        [...session.ledger.policyRecords()]
          .filter((record) => record.live)
          .map((record) => ({ id, session, record })),
      );
      livePages = candidates.length;
      // Whether this pass's candidates were weighed over the threshold (a reading can land later
      // in the pass): a bound tab is never the last resort of a pass that skipped the others.
      const releasingAtStart = this.releasing;
      // TS13: while a context with tabs to spare is still looking for its helper, a ready context
      // gives up to pressure only its least valuable class: an agent's leftover no person used.
      const looking = this.pendingLook() !== null;
      const spared = (session: HeldSession, record: TabRecord) =>
        looking && this.category(session, record) > 0;
      candidates.sort(
        (a, b) =>
          Number(this.declined.has(a.record)) - Number(this.declined.has(b.record)) ||
          this.category(a.session, a.record) - this.category(b.session, b.record) ||
          a.record.usedAt - b.record.usedAt,
      );
      for (const { id, session, record } of candidates) {
        if (pending.size >= concurrentSleeps) await Promise.race(pending);
        if (attempted >= sleepsPerPass || this.closed) break;
        let deadline = this.deadline(session, record);
        const pressureDriven = this.usesLinuxMemoryPressure();
        const measuredPressure = pressureDriven
          ? this.memoryPressureState.known
          : this.rendererUsage !== null;
        if (measuredPressure && deadline > Date.now()) {
          if (!this.releasing || Date.now() < holdUntil(session)) continue;
          if (spared(session, record)) continue;
          // In single-step Electron renderer mode, finish pending sleeps before deciding the next one.
          if (!pressureDriven && pending.size) await Promise.all(pending);
          if (this.closed) break;
          // The Host's facts may have changed during that wait (finding 10).
          deadline = this.deadline(session, record);
        }
        if (
          this.sessions.get(id) !== session ||
          (this.nextProbe.get(record) ?? 0) > Date.now() ||
          this.blocked(id, record, Date.now())
        )
          continue;
        if (
          deadline > Date.now() &&
          // Electron pages can share a process, so measure again after 1 sleep; Linux pressure
          // mode sheds up to concurrentSleeps site-isolated tabs per fast settle cycle.
          ((!pressureDriven && this.rendererUsage && slept > 0) ||
            (pressureDriven &&
              this.memoryPressureState.known &&
              slept + pending.size >= concurrentSleeps) ||
            !this.overBudget(pending.size))
        )
          continue;
        this.reclaimInFlight++;
        const sleeping = session.ledger
          .sleep(record.id, (next) => this.blocked(id, next, Date.now()))
          .then((committed) => {
            if (committed) {
              slept++;
              this.lastSleptAt = Date.now();
            } else {
              this.declined.add(record);
              this.nextProbe.set(record, Date.now() + quietMs);
            }
            this.trimRestore();
          })
          .finally(() => {
            this.reclaimInFlight--;
            pending.delete(sleeping);
          });
        pending.add(sleeping);
        attempted++;
      }
      await Promise.all(pending);
      // Over the start threshold with no tab past its quiet period able to sleep, the least
      // recently used tab that is not in use sleeps, whatever its age: a renderer the kernel
      // kills loses more than a tab put to sleep. One per pass; the next sample decides again.
      if (
        !this.closed &&
        attempted === 0 &&
        this.usesLinuxMemoryPressure() &&
        this.memoryPressureState.known &&
        this.releasing &&
        Date.now() >= this.pressureHoldUntil(ready)
      ) {
        const now = Date.now();
        const lastResort = (reason: SleepBlocker, bound: boolean) =>
          candidates
            .filter(
              ({ id, session, record }) =>
                this.sessions.get(id) === session &&
                now >= holdUntil(session) &&
                !spared(session, record) &&
                (this.nextProbe.get(record) ?? 0) <= now &&
                this.blocked(id, record, now) === reason &&
                this.blocked(id, record, now, undefined, true, bound) === null,
            )
            .sort((a, b) => a.record.usedAt - b.record.usedAt)[0];
        // A young tab first; then one desktop Chrome protects (TS16); a tab a live agent is bound
        // to only when no other is left (TS12).
        const young = lastResort("quiet", false);
        // A protected tab only on a reading taken after the last sleep had settled: memory still
        // over.
        const freshReading =
          releasingAtStart && this.memorySampledAt > this.lastSleptAt + linuxPressureSettleMs;
        const youngest =
          young ??
          (freshReading
            ? (lastResort("recently-viewed", true) ?? lastResort("agent-bound", true))
            : undefined);
        if (youngest) {
          const { id, session, record } = youngest;
          const bound = !young;
          attempted++;
          this.reclaimInFlight++;
          const committed = await session.ledger
            .sleep(record.id, (next) => this.blocked(id, next, Date.now(), undefined, true, bound))
            .finally(() => this.reclaimInFlight--);
          if (committed) {
            slept++;
            this.lastSleptAt = Date.now();
          } else {
            this.declined.add(record);
            this.nextProbe.set(record, Date.now() + quietMs);
          }
          this.trimRestore();
        }
      }
      // Opens waiting on this pass go once its sleeps are done and their settle is set, so each
      // checks again against it (M4); none waits on a host retiring.
      this.establishSettle(slept);
      this.releasePassWaiters();
      if (!this.closed && attempted < sleepsPerPass) {
        for (const host of this.retirementCandidates()) {
          if (this.closed || this.estimate() <= this.budget()) break;
          if (this.canRetire(host)) await this.options.retireHost!(host.key);
        }
      }
    } finally {
      this.running = false;
      this.openAsked = false;
      if (attempted < sleepsPerPass) this.declined = new WeakSet();
      const pressureDriven = this.usesLinuxMemoryPressure();
      this.establishSettle(slept);
      if ((pressureDriven || this.rendererUsage) && this.releasing) {
        const now = Date.now();
        const settleMs = pressureDriven ? linuxPressureSettleMs : rendererSettleMs;
        if (attempted >= sleepsPerPass) {
          this.nextRendererSample = Math.min(this.nextRendererSample, now + pressureScanMs);
          if (pressureDriven) {
            this.nextPressureSample = Math.min(this.nextPressureSample, now + settleMs);
          }
        }
        if (this.reclaimFrom) {
          if (pressureDriven) {
            this.nextPressureSample = Math.min(this.nextPressureSample, this.reclaimFrom.settledAt);
          } else {
            this.nextRendererSample = Math.min(this.nextRendererSample, this.reclaimFrom.settledAt);
          }
        }
      }
      this.releasePassWaiters();
      this.poke(attempted >= sleepsPerPass ? pressureScanMs : 0);
      if (this.options.onPass) this.reportPass({ ...this.summary(attempted, slept), livePages });
    }
  }

  /** After a pass slept something under pressure: its reclaim settles from now. */
  private establishSettle(slept: number): void {
    const pressureDriven = this.usesLinuxMemoryPressure();
    if (slept === 0 || !(pressureDriven || this.rendererUsage) || !this.releasing) return;
    const settledAt = Date.now() + (pressureDriven ? linuxPressureSettleMs : rendererSettleMs);
    this.reclaimFrom ??= {
      usage: this.rendererUsage,
      pressureUsedBytes: this.memoryPressureState.reading?.usedBytes ?? null,
      settledAt,
      startedAt: Date.now(),
      waiting: false,
    };
    this.reclaimFrom.settledAt = settledAt;
    this.reclaimFrom.waiting = false;
  }

  close(): void {
    this.closed = true;
    this.releasePassWaiters();
    clearTimeout(this.flushTimer);
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}

function sameStructure(left: PageCounts | undefined, right: PageCounts | undefined): boolean {
  const { sleepRefused: _left, ...a } = left ?? ({} as Partial<PageCounts>);
  const { sleepRefused: _right, ...b } = right ?? ({} as Partial<PageCounts>);
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameRefusals(left: PageCounts | undefined, right: PageCounts | undefined): boolean {
  return JSON.stringify(left?.sleepRefused) === JSON.stringify(right?.sleepRefused);
}
