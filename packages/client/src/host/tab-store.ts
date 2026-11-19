import type { Tab, TabId, TabLayout } from "@opensteer/core";
import type { TabBootstrap, TabStream } from "@opensteer/protocol";
import { KeyedStreamReceiver, type KeyedStreamMessage } from "@opensteer/protocol/keyed-stream";
import type { TabsReadModel } from "./tabs-contract.js";
import { tabStrip, type TabStrip } from "./tab-strip.js";

type Listener = () => void;
type Meta = { layout: TabLayout };
const emptyLayout: TabLayout = { revision: 0, items: [] };

/** A mutation's answer: the layout it committed and the tabs it returned. */
export interface TabCommandEffect {
  readonly layout: TabLayout;
  readonly tabs?: readonly Tab[];
}

export function layoutTabIds(layout: TabLayout): TabId[] {
  return layout.items.flatMap((item) => (item.kind === "tab" ? [item.tabId] : item.group.tabIds));
}

/**
 * The person's tab catalog on this device: the bootstrap prefix, completed and
 * patched by the Host's keyed `host.tabs` stream. A command's answer may run
 * ahead of the stream; it shows only while its layout is newer than the
 * stream's, so a late answer can never put back a tab the stream closed.
 */
export class TabStore implements TabsReadModel {
  readonly #receiver = new KeyedStreamReceiver<Tab, Meta, "tabId">({ key: "tabId" });
  #ahead: { layout: TabLayout; rows: Map<TabId, Tab> } | null = null;
  #rows: ReadonlyMap<TabId, Tab> = new Map();
  #layout: TabLayout = emptyLayout;
  #complete = false;
  #syncing = true;
  readonly #listeners = new Set<Listener>();
  readonly #structure = new Set<Listener>();
  readonly #tabs = new Map<TabId, Set<Listener>>();

  get rows(): ReadonlyMap<TabId, Tab> {
    return this.#rows;
  }
  get layout(): TabLayout {
    return this.#layout;
  }
  get complete(): boolean {
    return this.#complete;
  }
  get syncing(): boolean {
    return this.#syncing;
  }
  #strip: TabStrip | null = null;
  #stripOf: { layout: TabLayout; rows: ReadonlyMap<TabId, Tab> } | null = null;
  /** The layout as drawn: stable while only tab fields change. */
  get strip(): TabStrip {
    if (this.#strip && this.#stripOf?.layout === this.#layout && this.#stripOf.rows === this.#rows)
      return this.#strip;
    this.#strip = tabStrip(this.#layout, this.#rows, this.#strip ?? undefined);
    this.#stripOf = { layout: this.#layout, rows: this.#rows };
    return this.#strip;
  }
  get(tabId: string): Tab | undefined {
    return this.#rows.get(tabId as TabId);
  }
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  /** Fires when the layout or the set of known tabs changes; never for a field patch. */
  subscribeStructure(listener: Listener): () => void {
    this.#structure.add(listener);
    return () => this.#structure.delete(listener);
  }
  subscribeTab(tabId: string, listener: Listener): () => void {
    let listeners = this.#tabs.get(tabId as TabId);
    if (!listeners) this.#tabs.set(tabId as TabId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#tabs.delete(tabId as TabId);
    };
  }

  /**
   * Bootstrap's ordered prefix of the same snapshot the stream then completes.
   * A running or assembling stream is newer than any bootstrap, which is ignored.
   */
  seed(bootstrap: TabBootstrap): boolean {
    if (this.#receiver.state === "committed" || this.#receiver.state === "assembling") return false;
    this.#ahead = null;
    this.#receiver.seed(bootstrap.tabs as Tab[], { layout: bootstrap.layout as TabLayout });
    this.#complete = bootstrap.complete;
    this.#syncing = !bootstrap.complete;
    this.#publish();
    return true;
  }

  replaceCurrent(snapshot: TabBootstrap): boolean {
    if (snapshot.layout.revision < this.#layout.revision) return false;
    this.#receiver.seed(snapshot.tabs as Tab[], { layout: snapshot.layout as TabLayout });
    this.#complete = snapshot.complete;
    this.#syncing = !snapshot.complete;
    this.#publish();
    return true;
  }

  /**
   * A read of the tab rows alone. They are paired with the layout the stream itself holds, never
   * with a command's answer running ahead of it: that answer stays shown until a layout at least
   * as new confirms it, so rows read before a tab opened cannot take that tab away.
   */
  replaceRows(tabs: readonly Tab[], complete: boolean): void {
    this.#receiver.seed(tabs as Tab[], { layout: this.#receiver.meta?.layout ?? emptyLayout });
    this.#complete = complete;
    this.#syncing = !complete;
    this.#publish();
  }

  /**
   * A read of the layout alone, judged against the stream's own layout. The rows kept are the
   * ones shown, which include a command's answer this layout now confirms.
   */
  replaceLayout(layout: TabLayout): boolean {
    const held = this.#receiver.meta?.layout ?? emptyLayout;
    if (layout.revision < held.revision) return false;
    this.#receiver.seed([...this.#rows.values()], { layout });
    this.#publish();
    return true;
  }

  markInventoryStale(): void {
    this.#complete = false;
    this.#syncing = true;
    this.#publish();
  }

  /** "resync" asks the caller to request a fresh stream; the rows shown stay until it lands. */
  apply(message: TabStream): "applied" | "staged" | "resync" {
    const result = this.#receiver.apply(message as KeyedStreamMessage<Tab, Meta, "tabId">);
    if (result === "applied") {
      this.#complete = true;
      this.#syncing = false;
    } else if (result === "resync") this.#syncing = true;
    this.#publish();
    return result;
  }

  /** The connection dropped: keep showing what is known until the Host restarts the stream. */
  disconnected(): void {
    this.#receiver.stale();
    this.#syncing = true;
    this.#publish();
  }

  /**
   * Applies a command's committed layout and returned tabs when they are newer
   * than what the stream has shown. Anything at or below the shown revision is
   * already reflected, or superseded, and is ignored.
   */
  applyCommand(effect: TabCommandEffect): void {
    if (effect.layout.revision <= this.#layout.revision) return;
    const rows = new Map(this.#ahead?.rows);
    for (const tab of effect.tabs ?? []) rows.set(tab.tabId, tab);
    this.#ahead = { layout: effect.layout, rows };
    this.#publish();
  }

  clear(): void {
    this.#ahead = null;
    this.#receiver.seed([], { layout: emptyLayout });
    this.#complete = false;
    this.#syncing = true;
    this.#publish();
  }

  #publish(): void {
    const base = this.#receiver.rows as ReadonlyMap<TabId, Tab>;
    const streamLayout = this.#receiver.meta?.layout ?? emptyLayout;
    if (this.#ahead && this.#ahead.layout.revision <= streamLayout.revision) this.#ahead = null;
    const layout = this.#ahead?.layout ?? streamLayout;
    let rows = base;
    if (this.#ahead) {
      const merged = new Map(base);
      const members = new Set(layoutTabIds(layout));
      for (const id of layoutTabIds(streamLayout)) if (!members.has(id)) merged.delete(id);
      for (const [id, tab] of this.#ahead.rows)
        if (members.has(id) && !base.has(id)) merged.set(id, tab);
      rows = merged;
    }
    const previous = this.#rows;
    const touched: TabId[] = [];
    for (const [id, tab] of rows) if (previous.get(id) !== tab) touched.push(id);
    for (const id of previous.keys()) if (!rows.has(id)) touched.push(id);
    const sameLayout =
      this.#layout === layout ||
      (this.#layout.revision === layout.revision &&
        JSON.stringify(this.#layout) === JSON.stringify(layout));
    // The receiver patches its map in place; selectors need a new map to see a change.
    if (touched.length) this.#rows = new Map(rows);
    if (!sameLayout) this.#layout = layout;
    const structural = !sameLayout || touched.some((id) => previous.has(id) !== this.#rows.has(id));
    const status =
      this.#complete !== this.#status.complete || this.#syncing !== this.#status.syncing;
    this.#status = { complete: this.#complete, syncing: this.#syncing };
    if (structural || touched.length || status) this.#revision++;
    for (const id of touched) for (const listener of this.#tabs.get(id) ?? []) listener();
    if (structural) for (const listener of this.#structure) listener();
    if (structural || touched.length || status) for (const listener of this.#listeners) listener();
  }
  #status = { complete: false, syncing: true };
  #revision = 0;
  /** Counts every published change, for views that derive from many rows at once. */
  get revision(): number {
    return this.#revision;
  }
}
