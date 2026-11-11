import { totalmem } from "node:os";
import type { BrowserSurfaceId, BrowserSessionState } from "@opensteer/protocol/browser";
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
}

interface SleepSession {
  readonly ledger: SurfaceLedger;
  readonly restoreVersion?: 1 | undefined;
  readonly blocked: (id: BrowserSurfaceId) => string | null;
}
interface HeldSession extends SleepSession {
  hostState: BrowserSessionState | null;
  releasedAt: number;
  stop(): void;
}

/** Runtime-wide scheduling; the ledger alone commits page transitions. */
export class TabSleeper {
  private readonly sessions = new Map<string, HeldSession>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly nextProbe = new WeakMap<TabRecord, number>();
  private running = false;
  private closed = false;

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
  private estimate(): number {
    let pages = 0;
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
    const estimate = this.estimate() - pendingPages * pageEstimateBytes;
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
    if (
      state.runs === 0 &&
      (session.hostState === null ||
        session.hostState.runs > 0 ||
        (session.hostState.keepAwake && !state.keepAwake))
    )
      session.releasedAt = Date.now();
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
  blocked(
    id: string,
    record: TabRecord,
    now: number,
    links?: ReadonlySet<BrowserSurfaceId>,
  ): string | null {
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
    const budget = this.overBudget();
    let earliest = Infinity;
    for (const [id, session] of this.sessions) {
      const links = this.openerLinks(session);
      const cutoff = this.readCutoff(session);
      for (const record of session.ledger.policyRecords()) {
        if (!record.live) continue;
        const reason = this.blocked(id, record, now, links);
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
    if (!Number.isFinite(earliest)) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.pass();
      },
      Math.max(minimumDelay, earliest - now),
    );
    this.timer.unref();
  }
  private async pass(): Promise<void> {
    this.running = true;
    let attempted = 0;
    const pending = new Set<Promise<void>>();
    try {
      const candidates = [...this.sessions].flatMap(([id, session]) =>
        [...session.ledger.policyRecords()]
          .filter((record) => record.live)
          .map((record) => ({ id, session, record })),
      );
      candidates.sort(
        (a, b) =>
          this.category(a.session, a.record) - this.category(b.session, b.record) ||
          a.record.usedAt - b.record.usedAt,
      );
      for (const { id, session, record } of candidates) {
        if (pending.size >= concurrentSleeps) await Promise.race(pending);
        if (attempted >= sleepsPerPass || this.closed) break;
        if (
          this.sessions.get(id) !== session ||
          (this.nextProbe.get(record) ?? 0) > Date.now() ||
          this.blocked(id, record, Date.now())
        )
          continue;
        if (this.deadline(session, record) > Date.now() && !this.overBudget(pending.size)) continue;
        const sleeping = session.ledger
          .sleep(record.id, (next) => this.blocked(id, next, Date.now()))
          .then((committed) => {
            if (!committed) this.nextProbe.set(record, Date.now() + quietMs);
            this.trimRestore();
          })
          .finally(() => pending.delete(sleeping));
        pending.add(sleeping);
        attempted++;
      }
      await Promise.all(pending);
      if (!this.closed && attempted < sleepsPerPass) {
        for (const host of this.retirementCandidates()) {
          if (this.closed || this.estimate() <= this.budget()) break;
          if (this.canRetire(host)) await this.options.retireHost!(host.key);
        }
      }
    } finally {
      this.running = false;
      this.poke(attempted >= sleepsPerPass ? 1_000 : 0);
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}
