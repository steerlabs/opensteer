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
  /** Its page tabs the catalog has closed. */
  readonly closed: ReadonlySet<string>;
  /** `runId:bindingGeneration` of every Run binding that may use the session now. */
  readonly eligible: ReadonlySet<string>;
}

/** The runtime's side, as it already reports it, with what the Host knows of each surface. */
export interface ShadowInventory {
  /** Every surface the runtime reports: `live` has a page, `suspended` is a tab asleep. */
  readonly surfaces: ReadonlyMap<string, "live" | "suspended">;
  /** The catalog generation the Host bound each surface's page at, where it did. */
  readonly admitted: ReadonlyMap<string, number>;
  /** Surfaces whose catalog write the Host has not made yet: their admission is under way. */
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

/**
 * Each disagreement between the catalog and the runtime's surfaces:
 * a surface whose tab the catalog closed, never had, or reopened since the
 * Host bound its page would be destroyed; an open tab with no page is asleep
 * or missing; a surface held by a Run attempt that may no longer use the
 * session would lose that hold.
 */
export function compareShadow(catalog: ShadowCatalog, inventory: ShadowInventory): ShadowFinding[] {
  const findings: ShadowFinding[] = [];
  const facts = (tab: string) => ({
    personUsed: inventory.personUsed.has(tab),
    viewing: inventory.viewing.has(tab),
  });
  for (const [tab, state] of inventory.surfaces) {
    const generation = catalog.tabs.get(tab);
    const admitted = inventory.admitted.get(tab);
    const closed = catalog.closed.has(tab);
    // A page the Host is still admitting has no row yet; its commit compares again.
    if (generation === undefined && !closed && inventory.pending.has(tab)) continue;
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
    const key = `${holder.run}:${holder.bindingGeneration}`;
    if (catalog.eligible.has(key) || !inventory.surfaces.has(holder.surface)) continue;
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
  return findings;
}

/** Past this many person-viewed pages that would be destroyed at once, the summary is loud. */
export const shadowLoudViewedPages = 10;

/**
 * Turns successive comparisons into log lines: one when a disagreement
 * appears, one with its age when it resolves, a summary when the counts
 * change, and a loud line when a session crosses `shadowLoudViewedPages`.
 */
export class ShadowLedger {
  readonly #open = new Map<string, { readonly finding: ShadowFinding; readonly since: number }>();
  #counts = "";
  #loud = false;

  update(findings: readonly ShadowFinding[], now: number): Record<string, unknown>[] {
    const lines: Record<string, unknown>[] = [];
    const current = new Map(findings.map((finding) => [finding.key, finding]));
    for (const [key, { finding, since }] of this.#open)
      if (!current.has(key)) {
        this.#open.delete(key);
        lines.push({
          event: "browser.shadow.resolved",
          kind: finding.kind,
          reason: finding.reason,
          tab: finding.tab,
          ageMs: now - since,
        });
      }
    for (const [key, finding] of current)
      if (!this.#open.has(key)) {
        this.#open.set(key, { finding, since: now });
        lines.push({ event: "browser.shadow.appeared", ...logFields(finding) });
      }
    const counts = { "would-destroy": 0, "tab-without-page": 0, "would-drop-hold": 0 };
    const oldestMs: Partial<Record<ShadowKind, number>> = {};
    for (const { finding, since } of this.#open.values()) {
      counts[finding.kind]++;
      oldestMs[finding.kind] = Math.max(oldestMs[finding.kind] ?? 0, now - since);
    }
    const encoded = JSON.stringify(counts);
    if (encoded !== this.#counts) {
      this.#counts = encoded;
      lines.push({ event: "browser.shadow.summary", counts, oldestMs });
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
}

/** Ids, states, reasons and flags only: never a URL, title or anything from a page. */
function logFields(finding: ShadowFinding): Record<string, unknown> {
  return {
    kind: finding.kind,
    reason: finding.reason,
    tab: finding.tab,
    generation: finding.generation,
    state: finding.state,
    personUsed: finding.personUsed,
    viewing: finding.viewing,
    ...(finding.run ? { run: finding.run, bindingGeneration: finding.bindingGeneration } : {}),
  };
}
