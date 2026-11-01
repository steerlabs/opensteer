export const bootstrapDiagnosticHeader = "x-opensteer-bootstrap-diagnostics";
export const bootstrapDiagnosticWindowMs = 60_000;
export const bootstrapEarlyReadThreshold = 5;

export const bootstrapReasons = [
  "interval",
  "load",
  "refresh",
  "reauthenticate",
  "reconnect",
  "foreground",
  "host.browser-sessions-changed",
  "host.machines.changed",
  "host.machine.access.session.started",
  "host.machine.access.session.ended",
] as const;
export type BootstrapReason = (typeof bootstrapReasons)[number];
type Counts = Partial<Record<BootstrapReason, number>>;
interface BootstrapDiagnosticLog {
  readonly windowMs: number;
  readonly triggers: string;
  readonly starts: string;
  readonly noticeWindowMs: number;
  readonly notices: string;
}
export interface BootstrapDiagnosticSummary {
  readonly windowMs: number;
  readonly triggers: Counts;
  readonly starts: Counts;
}

function earlyReads(summary: BootstrapDiagnosticSummary): number {
  return bootstrapReasons.reduce(
    (sum, reason) => sum + (reason === "interval" ? 0 : (summary.starts[reason] ?? 0)),
    0,
  );
}

/** Shared across client lifetimes so repeated mounts cannot hide a load loop. */
export class BootstrapReadDiagnostics {
  #since: number | undefined;
  #lastReport = -Infinity;
  #triggers: Counts = {};
  #starts: Counts = {};
  #pending: BootstrapDiagnosticSummary | undefined;

  trigger(reason: BootstrapReason, now = Date.now()): void {
    this.#rotate(now);
    this.#triggers[reason] = (this.#triggers[reason] ?? 0) + 1;
  }

  start(reason: BootstrapReason, now = Date.now()): void {
    this.#rotate(now);
    this.#starts[reason] = (this.#starts[reason] ?? 0) + 1;
    const summary = {
      windowMs: now - this.#since!,
      triggers: this.#triggers,
      starts: this.#starts,
    };
    if (
      earlyReads(summary) <= bootstrapEarlyReadThreshold ||
      now - this.#lastReport < bootstrapDiagnosticWindowMs
    )
      return;
    this.#pending = summary;
    this.#lastReport = now;
    this.#reset(now);
  }

  takeSummary(): BootstrapDiagnosticSummary | undefined {
    const summary = this.#pending;
    this.#pending = undefined;
    return summary;
  }

  #rotate(now: number): void {
    if (this.#since === undefined || now < this.#since) {
      this.#lastReport = -Infinity;
      this.#reset(now);
    } else if (now - this.#since > bootstrapDiagnosticWindowMs) this.#reset(now);
  }

  #reset(now: number): void {
    this.#since = now;
    this.#triggers = {};
    this.#starts = {};
  }
}

/** Only fixed keys and bounded counts may cross into persistent logs. */
export function parseBootstrapDiagnosticSummary(raw: unknown): BootstrapDiagnosticSummary | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !record(value) ||
      Object.keys(value).some((key) => !["windowMs", "triggers", "starts"].includes(key))
    )
      return null;
    if (!count(value.windowMs) || value.windowMs > bootstrapDiagnosticWindowMs) return null;
    const triggers = counts(value.triggers);
    const starts = counts(value.starts);
    if (!triggers || !starts) return null;
    const summary = { windowMs: value.windowMs, triggers, starts };
    return earlyReads(summary) > bootstrapEarlyReadThreshold ? summary : null;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
  );
}
function counts(value: unknown): Counts | null {
  if (!record(value)) return null;
  const output: Counts = {};
  for (const [key, valueCount] of Object.entries(value)) {
    const reason = bootstrapReasons.find((reason) => reason === key);
    if (!reason || !count(valueCount)) return null;
    output[reason] = valueCount;
  }
  return output;
}

export const bootstrapNoticeSources = [
  "unspecified",
  "browser.profiles",
  "browser.profile-reconciled",
  "browser.profile-deletions",
  "browser.tabs",
  "browser.catalog-flush",
  "browser.usage",
  "browser.detach",
  "browser.grant-revoked",
  "browser.start",
  "browser.terminal",
  "browser.attach",
  "browser.transition",
  "browser.membership",
  "browser.groups",
  "computer-apps.status",
  "computer-use.sessions",
  "integration.connections",
  "runner.shell-access",
  "runner.disconnect",
  "runner.registered",
  "machine.command",
  "machine.access",
] as const;
export type BootstrapNoticeSource = (typeof bootstrapNoticeSources)[number];

/** Bounded publication counters; no subscriber or domain identifiers are retained. */
export class BootstrapNoticeDiagnostics {
  #since: number | undefined;
  #lastReport = -Infinity;
  readonly #buckets = new Map<number, Record<string, number>>();

  record(type: string, source: BootstrapNoticeSource, now = Date.now()): void {
    if (
      !bootstrapReasons.some((reason) => reason.startsWith("host.") && reason === type) ||
      !bootstrapNoticeSources.some((known) => known === source)
    )
      return;
    this.#rotate(now);
    const second = Math.floor(now / 1_000) * 1_000;
    const bucket = this.#buckets.get(second) ?? {};
    this.#buckets.set(second, bucket);
    const key = `${type}/${source}`;
    bucket[key] = (bucket[key] ?? 0) + 1;
  }

  report(raw: unknown, now = Date.now()): BootstrapDiagnosticLog | null {
    const summary = parseBootstrapDiagnosticSummary(raw);
    if (!summary || now - this.#lastReport < bootstrapDiagnosticWindowMs) return null;
    this.#rotate(now);
    this.#lastReport = now;
    const notices: Record<string, number> = {};
    for (const bucket of this.#buckets.values())
      for (const [key, count] of Object.entries(bucket)) notices[key] = (notices[key] ?? 0) + count;
    return {
      windowMs: summary.windowMs,
      triggers: JSON.stringify(summary.triggers),
      starts: JSON.stringify(summary.starts),
      noticeWindowMs: Math.min(bootstrapDiagnosticWindowMs, now - this.#since!),
      notices: JSON.stringify(notices),
    };
  }

  #rotate(now: number): void {
    if (this.#since === undefined || now < this.#since) {
      this.#since = now;
      this.#buckets.clear();
    }
    for (const second of this.#buckets.keys())
      if (now - second >= bootstrapDiagnosticWindowMs) this.#buckets.delete(second);
  }
}
