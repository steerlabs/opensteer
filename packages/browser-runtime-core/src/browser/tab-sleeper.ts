import { totalmem } from "node:os";
import type { BrowserSurfaceId, BrowserSessionState } from "@opensteer/protocol/browser";
import type { BrowserRendererUsage } from "./backend.js";
import type { PageCounts, SleepBlocker } from "./page-ownership.js";
import type { SurfaceLedger, TabRecord } from "./surface-ledger.js";

const quietMs = 10_000;
const leftoverMs = 60_000;
const readIdleMs = 120_000;
const readKeep = 8;
const pageEstimateBytes = 100 * 1024 ** 2;
const processHostEstimateBytes = 150 * 1024 ** 2;
const budgetFloorBytes = 2 * 1024 ** 3;
const budgetCeilingBytes = 8 * 1024 ** 3;
const budgetShare = 0.25;
const budgetReleaseShare = 0.85;
const restoreBudgetBytes = 64 * 1024 ** 2;
const sleepsPerPass = 8;
const concurrentSleeps = 4;
const rendererSampleMs = 30_000;
const pressureScanMs = 1_000;
const rendererSettleMs = 3_000;
const ineffectiveReclaimsBeforeBackoff = 3;
const maxProbeDelayMs = 60_000;
const zeroProgressBackoffBaseMs = 30_000;
const zeroProgressBackoffMaxMs = 300_000;
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
  readonly memoryBudgetBytes?: number | undefined;
  readonly memory?: () => { total: number; available: number };
  readonly hostCost?: "process" | "partition" | undefined;
  readonly hosts?: () => readonly SleepHost[];
  readonly retireHost?: (key: string) => Promise<void>;
  readonly rendererUsage?: (() => BrowserRendererUsage) | undefined;
  readonly onPass?: ((pass: TabSleepPass) => void) | undefined;
  readonly pageCounts?: (() => PageCounts) | undefined;
  /** Native pages with no live tab across the runtime, those of ended sessions included. */
  readonly untabbedPages?: (() => number) | undefined;
}

interface SleepSession {
  readonly ledger: SurfaceLedger;
  readonly restoreVersion?: 1 | undefined;
  readonly blocked: (id: BrowserSurfaceId) => SleepBlocker | null;
}
interface HeldSession extends SleepSession {
  hostState: BrowserSessionState | null;
  releasedAt: number;
  blockerEpoch: number;
  stop(): void;
}

/** Runtime-wide scheduling; the ledger alone commits page transitions. */
export class TabSleeper {
  private readonly sessions = new Map<string, HeldSession>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly nextProbe = new WeakMap<TabRecord, number>();
  private readonly refusalCount = new WeakMap<TabRecord, number>();
  private running = false;
  private closed = false;
  private rendererUsage: BrowserRendererUsage | null = null;
  private nextRendererSample = 0;
  private declined = new WeakSet<TabRecord>();
  private reclaimFrom: {
    usage: BrowserRendererUsage;
    settledAt: number;
    /** Its sample waits once, for the slept pages' confirmation or a cutoff. */
    waiting: boolean;
  } | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private ineffectiveReclaims = 0;
  private zeroProgressRotations = 0;
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
  private overBudget(pendingPages = 0): boolean {
    const estimate =
      this.rendererUsage?.bytes ?? this.estimate() - pendingPages * pageEstimateBytes;
    const budget = this.budget();
    if (estimate > budget) this.releasing = true;
    if (estimate <= budget * budgetReleaseShare) this.releasing = false;
    return this.releasing;
  }
  private trimRestore(): void {
    const records = [...this.sessions.values()]
      .flatMap((session) => [...session.ledger.policyRecords()])
      .filter((record) => record.lease.state === "suspended" && record.restore?.engine != null);
    let bytes = records.reduce((sum, record) => sum + (record.restore?.bytes ?? 0), 0);
    for (const record of records.sort((a, b) => a.usedAt - b.usedAt)) {
      if (bytes <= restoreBudgetBytes) break;
      bytes -= record.restore!.bytes;
      record.restore!.engine = null;
      record.restore!.bytes = 0;
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
      blockerEpoch: 0,
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
  setSessionState(id: string, state: BrowserSessionState): void {
    const session = this.sessions.get(id);
    if (!session) return;
    const previous = session.hostState;
    const blockerCleared =
      previous === null ||
      state.runs < previous.runs ||
      (Boolean(previous.keepAwake) && !state.keepAwake) ||
      previous.viewed.some((surfaceId) => !state.viewed.includes(surfaceId)) ||
      previous.pinned.some((surfaceId) => !state.pinned.includes(surfaceId));
    if (
      state.runs === 0 &&
      (previous === null || previous.runs > 0 || (previous.keepAwake && !state.keepAwake))
    )
      session.releasedAt = Date.now();
    session.hostState = state;
    for (const surfaceId of state.personUsed) session.ledger.markPersonUsed(surfaceId);
    if (blockerCleared) {
      session.blockerEpoch += 1;
      for (const record of session.ledger.policyRecords()) {
        this.nextProbe.delete(record);
        this.refusalCount.delete(record);
      }
      this.zeroProgressRotations = 0;
      this.pressureBackoffUntil = 0;
      this.declined = new WeakSet();
    }
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
  blocked(
    id: string,
    record: TabRecord,
    now: number,
    links?: ReadonlySet<BrowserSurfaceId>,
  ): SleepBlocker | null {
    const session = this.sessions.get(id);
    const state = session?.hostState;
    if (!session || !state || state.keepAwake) return "host-state";
    if (session.ledger.closing) return "closing";
    if (state.viewed.includes(record.id)) return "viewed";
    if (state.pinned.includes(record.id)) return "pinned";
    const external = session.blocked(record.id);
    if (external) return external;
    if (record.lease.busy || !["live", "sleeping"].includes(record.lease.state)) return "operation";
    if (state.runs > 0 && record.agentActed) return "agent-input";
    if (record.typed) return "typed";
    if (now - record.usedAt < quietMs) return "quiet";
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
    if (this.closed || this.running) return;
    this.trimRestore();
    const now = Date.now();
    // The reclaim waiting on confirmation is sampled as soon as that arrives.
    if (this.reclaimFrom?.waiting && this.untabbedPages() === 0) {
      this.reclaimFrom.settledAt = Math.min(this.reclaimFrom.settledAt, now);
      this.nextRendererSample = Math.min(this.nextRendererSample, now);
    }
    const budget = !this.options.rendererUsage && this.overBudget();
    let earliest = Infinity;
    for (const [id, session] of this.sessions) {
      const links = this.openerLinks(session);
      const cutoff = this.readCutoff(session);
      for (const record of session.ledger.policyRecords()) {
        if (!record.live) continue;
        if (this.options.rendererUsage) earliest = Math.min(earliest, this.nextRendererSample);
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
        if (reason && reason !== "quiet") continue;
        earliest = Math.min(
          earliest,
          Math.max(
            budget ? now : this.deadline(session, record, cutoff),
            record.usedAt + quietMs,
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
  private sampleRenderers(): void {
    const measure = this.options.rendererUsage;
    if (!measure) return;
    const now = Date.now();
    this.nextRendererSample = now + rendererSampleMs;
    const usage = measure();
    this.rendererUsage = usage;
    if (!this.overBudget()) {
      this.reclaimFrom = null;
      this.ineffectiveReclaims = 0;
      this.zeroProgressRotations = 0;
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
      usage.processes < reclaim.usage.processes ||
      (usage.bytes !== null &&
        reclaim.usage.bytes !== null &&
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
    let hasUnvisitedEligible = false;
    const pending = new Set<Promise<void>>();
    try {
      this.sampleRenderers();
      const candidates = [...this.sessions].flatMap(([id, session]) =>
        [...session.ledger.policyRecords()]
          .filter((record) => record.live)
          .map((record) => ({ id, session, record })),
      );
      livePages = candidates.length;
      candidates.sort(
        (a, b) =>
          Number(this.declined.has(a.record)) - Number(this.declined.has(b.record)) ||
          this.category(a.session, a.record) - this.category(b.session, b.record) ||
          a.record.usedAt - b.record.usedAt,
      );
      for (const { id, session, record } of candidates) {
        if (pending.size >= concurrentSleeps) await Promise.race(pending);
        if (attempted >= sleepsPerPass || this.closed) break;
        const deadline = this.deadline(session, record);
        if (this.rendererUsage && deadline > Date.now()) {
          if (
            !this.releasing ||
            Date.now() < Math.max(this.pressureBackoffUntil, this.reclaimFrom?.settledAt ?? 0)
          )
            continue;
          // Only a successful sleep can change the measured pressure.
          if (pending.size) await Promise.all(pending);
          if (this.closed) break;
        }
        if (
          this.sessions.get(id) !== session ||
          (this.nextProbe.get(record) ?? 0) > Date.now() ||
          this.blocked(id, record, Date.now())
        )
          continue;
        if (
          deadline > Date.now() &&
          // A page can share its process, so measure again before asking another
          // page to sleep under pressure.
          ((this.rendererUsage && slept > 0) || !this.overBudget(pending.size))
        )
          continue;
        const attemptEpoch = session.blockerEpoch;
        const sleeping = session.ledger
          .sleep(record.id, (next) => this.blocked(id, next, Date.now()))
          .then((committed) => {
            if (committed) {
              slept++;
              this.refusalCount.delete(record);
              this.nextProbe.delete(record);
              this.zeroProgressRotations = 0;
            } else if (session.blockerEpoch === attemptEpoch) {
              this.declined.add(record);
              const refusals = (this.refusalCount.get(record) ?? 0) + 1;
              this.refusalCount.set(record, refusals);
              const probeDelay = Math.min(
                maxProbeDelayMs,
                quietMs * 2 ** Math.min(refusals - 1, 3),
              );
              this.nextProbe.set(record, Date.now() + probeDelay);
            }
            this.trimRestore();
          })
          .finally(() => pending.delete(sleeping));
        pending.add(sleeping);
        attempted++;
      }
      await Promise.all(pending);
      const afterAttempts = Date.now();
      hasUnvisitedEligible = candidates.some(
        ({ id, session, record }) =>
          record.live !== null &&
          !this.declined.has(record) &&
          this.sessions.get(id) === session &&
          (this.nextProbe.get(record) ?? 0) <= afterAttempts &&
          !this.blocked(id, record, afterAttempts),
      );
      if (!this.closed && attempted < sleepsPerPass) {
        for (const host of this.retirementCandidates()) {
          if (this.closed || this.estimate() <= this.budget()) break;
          if (this.canRetire(host)) await this.options.retireHost!(host.key);
        }
      }
    } finally {
      this.running = false;
      const now = Date.now();
      const continueScan = attempted >= sleepsPerPass && (slept > 0 || hasUnvisitedEligible);
      if (slept === 0 && attempted > 0 && !hasUnvisitedEligible) {
        this.zeroProgressRotations++;
        const backoff = Math.min(
          zeroProgressBackoffMaxMs,
          zeroProgressBackoffBaseMs * 2 ** Math.min(this.zeroProgressRotations - 1, 4),
        );
        this.pressureBackoffUntil = Math.max(this.pressureBackoffUntil, now + backoff);
        this.declined = new WeakSet();
      } else if (attempted < sleepsPerPass) {
        this.declined = new WeakSet();
      }
      if (this.rendererUsage && this.releasing) {
        if (slept > 0) {
          this.reclaimFrom ??= {
            usage: this.rendererUsage,
            settledAt: now + rendererSettleMs,
            waiting: false,
          };
          this.reclaimFrom.settledAt = now + rendererSettleMs;
          this.reclaimFrom.waiting = false;
        }
        if (continueScan)
          this.nextRendererSample = Math.min(this.nextRendererSample, now + pressureScanMs);
        if (this.reclaimFrom)
          this.nextRendererSample = Math.min(this.nextRendererSample, this.reclaimFrom.settledAt);
      }
      this.poke(continueScan ? pressureScanMs : 0);
      if (this.options.onPass) this.reportPass({ ...this.summary(attempted, slept), livePages });
    }
  }

  close(): void {
    this.closed = true;
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
