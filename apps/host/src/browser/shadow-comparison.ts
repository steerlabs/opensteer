import { createHash } from "node:crypto";

/**
 * What the Host would do if it reconciled a browser session's catalog with
 * what its runtime reports, computed from facts the Host already has and
 * nothing more. Shadow only: nothing here closes, keeps, sleeps or refuses.
 */

/** The catalog's side, from one consistent read. */
export interface ShadowCatalog {
  readonly ended: boolean;
  /** Open page tabs of the session, by catalog identity. */
  readonly tabs: ReadonlyMap<string, number>;
  /** Which of the reported surfaces are tabs of the session the catalog has closed. */
  readonly closed: ReadonlySet<string>;
  /** `runId:bindingGeneration` of every Run binding that may use the session now. */
  readonly eligible: ReadonlySet<string>;
  /** Runs the read has facts for; a holder of any other Run is unknown, not ineligible. */
  readonly known: ReadonlySet<string>;
}

/** The runtime's side, as it already reports it, with what the Host knows of each surface. */
export interface ShadowInventory {
  /** Every surface the runtime reports: `live` has a page, `suspended` is a tab asleep. */
  readonly surfaces: ReadonlyMap<string, "live" | "suspended">;
  /** The catalog generation the Host bound each surface's page at, where it did. */
  readonly admitted: ReadonlyMap<string, number>;
  /** Surfaces whose catalog write the Host has not made yet: their admission may be under way. */
  readonly pending: ReadonlySet<string>;
  readonly personUsed: ReadonlySet<string>;
  readonly viewing: ReadonlySet<string>;
  /** The Run actors the Host saw act on or hold each surface. */
  readonly holders: readonly {
    readonly surface: string;
    readonly run: string;
    readonly bindingGeneration: number;
  }[];
}

export type ShadowKind = "would-destroy" | "tab-without-page" | "would-drop-hold";

export interface ShadowFinding {
  /** Stable while the disagreement lasts. */
  readonly key: string;
  readonly kind: ShadowKind;
  readonly reason:
    "ended" | "closed" | "never-admitted" | "generation" | "asleep" | "missing" | "not-eligible";
  readonly tab: string;
  readonly generation: number | null;
  readonly state: "live" | "suspended" | null;
  readonly personUsed: boolean;
  readonly viewing: boolean;
  readonly run?: string;
  readonly bindingGeneration?: number;
}

/** What a comparison could not judge, counted in the summary rather than named. */
export interface ShadowUncertain {
  /** Pages not in the catalog whose catalog write is still pending in the Host. */
  readonly awaitingAdmission: number;
  /** Open tabs whose page the Host never bound at a generation, so a stale page is unseen. */
  readonly generationUnknown: number;
  /** Holds by Runs the read has no facts for. */
  readonly holderUnknown: number;
}

/**
 * Each disagreement between the catalog and the runtime's surfaces:
 * a surface whose tab the catalog closed, never had, or reopened since the
 * Host bound its page would be destroyed; an open tab with no page is asleep
 * or missing; a surface held by a Run binding that may no longer use the
 * session would lose that hold. What it cannot judge is only counted.
 */
export function compareShadow(
  catalog: ShadowCatalog,
  inventory: ShadowInventory,
): { readonly findings: ShadowFinding[]; readonly uncertain: ShadowUncertain } {
  const findings: ShadowFinding[] = [];
  let awaitingAdmission = 0;
  let generationUnknown = 0;
  let holderUnknown = 0;
  const facts = (tab: string) => ({
    personUsed: inventory.personUsed.has(tab),
    viewing: inventory.viewing.has(tab),
  });
  for (const [tab, state] of inventory.surfaces) {
    const generation = catalog.tabs.get(tab);
    const admitted = inventory.admitted.get(tab);
    const closed = catalog.closed.has(tab);
    // A page the Host is still admitting has no row yet; its commit compares again.
    if (!catalog.ended && generation === undefined && !closed && inventory.pending.has(tab)) {
      awaitingAdmission++;
      continue;
    }
    if (!catalog.ended && generation !== undefined && admitted === undefined) generationUnknown++;
    const reason = catalog.ended
      ? "ended"
      : closed
        ? "closed"
        : generation === undefined
          ? "never-admitted"
          : admitted !== undefined && admitted !== generation
            ? "generation"
            : null;
    if (reason)
      findings.push({
        key: `destroy:${reason}:${tab}`,
        kind: "would-destroy",
        reason,
        tab,
        generation: admitted ?? null,
        state,
        ...facts(tab),
      });
  }
  if (!catalog.ended)
    for (const [tab, generation] of catalog.tabs) {
      const state = inventory.surfaces.get(tab);
      if (state === "live") continue;
      const reason = state === "suspended" ? "asleep" : "missing";
      findings.push({
        key: `nopage:${reason}:${tab}:${generation}`,
        kind: "tab-without-page",
        reason,
        tab,
        generation,
        state: state ?? null,
        ...facts(tab),
      });
    }
  for (const holder of inventory.holders) {
    if (!inventory.surfaces.has(holder.surface)) continue;
    if (!catalog.known.has(holder.run)) {
      holderUnknown++;
      continue;
    }
    const key = `${holder.run}:${holder.bindingGeneration}`;
    if (catalog.eligible.has(key)) continue;
    findings.push({
      key: `hold:${holder.surface}:${key}`,
      kind: "would-drop-hold",
      reason: "not-eligible",
      tab: holder.surface,
      generation: catalog.tabs.get(holder.surface) ?? null,
      state: inventory.surfaces.get(holder.surface) ?? null,
      run: holder.run,
      bindingGeneration: holder.bindingGeneration,
      ...facts(holder.surface),
    });
  }
  return { findings, uncertain: { awaitingAdmission, generationUnknown, holderUnknown } };
}

/** Past this many person-viewed pages that would be destroyed at once, the summary is loud. */
export const shadowLoudViewedPages = 10;
/** One finding writes at most this many lines in `flapWindowMs`; the rest are counted. */
const linesPerFinding = 4;
const flapWindowMs = 10 * 60_000;
/** One comparison writes at most this many appear and resolve lines; the rest are counted. */
const linesPerUpdate = 50;

/**
 * Turns successive comparisons into log lines: one when a disagreement
 * appears, one with its age when it resolves, a summary when the counts
 * change, and a loud line when a session crosses `shadowLoudViewedPages`.
 * A finding that flaps, or a burst of many at once, is folded into counts.
 */
export class ShadowLedger {
  readonly #open = new Map<string, { readonly finding: ShadowFinding; readonly since: number }>();
  readonly #recent = new Map<string, number[]>();
  #counts = "";
  #loud = false;
  #folded = 0;

  update(
    findings: readonly ShadowFinding[],
    uncertain: ShadowUncertain,
    now: number,
  ): Record<string, unknown>[] {
    const lines: Record<string, unknown>[] = [];
    let written = 0;
    const write = (key: string, line: Record<string, unknown>) => {
      const recent = (this.#recent.get(key) ?? []).filter((at) => now - at < flapWindowMs);
      if (recent.length >= linesPerFinding || written >= linesPerUpdate) {
        this.#folded++;
        this.#recent.set(key, recent);
        return;
      }
      recent.push(now);
      this.#recent.set(key, recent);
      written++;
      lines.push(line);
    };
    const current = new Map(findings.map((finding) => [finding.key, finding]));
    for (const [key, { finding, since }] of this.#open)
      if (!current.has(key)) {
        this.#open.delete(key);
        write(key, {
          event: "browser.shadow.resolved",
          kind: finding.kind,
          reason: finding.reason,
          ...shadowLogTab(finding.tab),
          ...(finding.run
            ? { run: finding.run, bindingGeneration: finding.bindingGeneration }
            : {}),
          ageMs: now - since,
        });
      }
    for (const [key, finding] of current)
      if (!this.#open.has(key)) {
        this.#open.set(key, { finding, since: now });
        write(key, { event: "browser.shadow.appeared", ...logFields(finding) });
      }
    for (const [key, times] of this.#recent)
      if (!this.#open.has(key) && times.every((at) => now - at >= flapWindowMs))
        this.#recent.delete(key);
    const counts = { "would-destroy": 0, "tab-without-page": 0, "would-drop-hold": 0 };
    const oldestMs: Partial<Record<ShadowKind, number>> = {};
    for (const { finding, since } of this.#open.values()) {
      counts[finding.kind]++;
      oldestMs[finding.kind] = Math.max(oldestMs[finding.kind] ?? 0, now - since);
    }
    const encoded = JSON.stringify([counts, uncertain, this.#folded]);
    if (encoded !== this.#counts) {
      this.#counts = encoded;
      lines.push({
        event: "browser.shadow.summary",
        counts,
        oldestMs,
        ...uncertain,
        folded: this.#folded,
      });
    }
    const viewed = findings.filter(
      (finding) => finding.kind === "would-destroy" && (finding.personUsed || finding.viewing),
    ).length;
    const loud = viewed > shadowLoudViewedPages;
    if (loud && !this.#loud)
      lines.push({ event: "browser.shadow.loud", viewed, wouldDestroy: counts["would-destroy"] });
    this.#loud = loud;
    return lines;
  }

  /** The comparison ends with its session: what was still open, counted. */
  stopped(now: number): Record<string, unknown> {
    const counts = { "would-destroy": 0, "tab-without-page": 0, "would-drop-hold": 0 };
    let oldestMs = 0;
    for (const { finding, since } of this.#open.values()) {
      counts[finding.kind]++;
      oldestMs = Math.max(oldestMs, now - since);
    }
    return { event: "browser.shadow.stopped", open: counts, oldestMs, folded: this.#folded };
  }
}

/** The shape of a surface id a desktop or standalone runtime issues. */
const issuedSurfaceId = /^surface_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * A runtime-supplied tab id as a log line may carry it: as is only when it is
 * an id of the issued shape, otherwise a short digest and a marker, so no text
 * a runtime chose (a URL, a title, a newline) ever reaches the log.
 */
export function shadowLogTab(tab: string): Record<string, unknown> {
  return issuedSurfaceId.test(tab)
    ? { tab }
    : {
        tab: null,
        tabDigest: createHash("sha256").update(tab).digest("hex").slice(0, 12),
        tabRecognized: false,
      };
}

/** Ids, states, reasons and flags only: never a URL, title or anything from a page. */
function logFields(finding: ShadowFinding): Record<string, unknown> {
  return {
    kind: finding.kind,
    reason: finding.reason,
    ...shadowLogTab(finding.tab),
    generation: finding.generation,
    state: finding.state,
    personUsed: finding.personUsed,
    viewing: finding.viewing,
    ...(finding.run ? { run: finding.run, bindingGeneration: finding.bindingGeneration } : {}),
  };
}
