import type { BrowserSurfaceId, BrowserSessionState } from "@opensteer/protocol/browser";
import type { SurfaceLedger, TabRecord } from "./surface-ledger.js";

const quietMs = 10_000;
const leftoverMs = 60_000;
const sleepsPerPass = 8;

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
    for (const surfaceId of state.viewed) session.ledger.touch(surfaceId, true);
    this.poke();
  }
  private openerLinks(session: SleepSession): ReadonlySet<BrowserSurfaceId> {
    const records = [...session.ledger.policyRecords()];
    const live = new Set(records.filter((record) => record.live).map((record) => record.id));
    const linked = new Set<BrowserSurfaceId>();
    for (const record of records)
      if (record.live && record.openerId && live.has(record.openerId)) {
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
    const now = Date.now();
    let earliest = Infinity;
    for (const [id, session] of this.sessions) {
      if (!session.hostState || session.hostState.runs !== 0) continue;
      const links = this.openerLinks(session);
      for (const record of session.ledger.policyRecords()) {
        if (!record.live || record.origin !== "agent" || record.personUsed) continue;
        const reason = this.blocked(id, record, now, links);
        if (reason && reason !== "quiet") continue;
        earliest = Math.min(
          earliest,
          Math.max(
            Math.max(record.usedAt, session.releasedAt) + leftoverMs,
            this.nextProbe.get(record) ?? 0,
          ),
        );
      }
    }
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
    let slept = 0;
    try {
      for (const [id, session] of this.sessions) {
        if (slept >= sleepsPerPass || this.closed) break;
        if (!session.hostState || session.hostState.runs !== 0) continue;
        const links = this.openerLinks(session);
        for (const record of session.ledger.policyRecords()) {
          if (slept >= sleepsPerPass || this.closed) break;
          if (
            !record.live ||
            record.origin !== "agent" ||
            record.personUsed ||
            Date.now() - Math.max(record.usedAt, session.releasedAt) < leftoverMs ||
            (this.nextProbe.get(record) ?? 0) > Date.now() ||
            this.blocked(id, record, Date.now(), links)
          )
            continue;
          const committed = await session.ledger.sleep(record.id, (next) =>
            this.blocked(id, next, Date.now()),
          );
          if (!committed) this.nextProbe.set(record, Date.now() + quietMs);
          slept++;
        }
      }
    } finally {
      this.running = false;
      this.poke(slept >= sleepsPerPass ? 1_000 : 0);
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
