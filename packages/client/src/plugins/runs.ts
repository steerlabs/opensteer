import type { PluginWorkflowRunView } from "@opensteer/protocol";

export function pluginWorkflowRunLive(run: Pick<PluginWorkflowRunView, "status">) {
  return !["complete", "errored", "terminated"].includes(run.status);
}

/** Finished runs shown before "Show more"; live runs always show. */
export const pluginFinishedRunsShown = 5;

export interface PluginWorkflowRunsState {
  /** Live runs first, then the newest finished ones, up to what the person asked to see. */
  readonly visible: readonly PluginWorkflowRunView[];
  /** Whether "Show more" would show anything: a hidden loaded run, or another page. */
  readonly more: boolean;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  /** The last read's failure; never read as "no runs". */
  readonly error: unknown;
}

type Page = { readonly runs: readonly PluginWorkflowRunView[]; readonly cursor: string | null };

/**
 * One plugin's workflow runs, paged by the Host's cursor: newest first by
 * creation, with unfinished runs also on the first page, so a later page can
 * repeat one and merging by id keeps its newest state. A refresh reads again
 * every page loaded so far, so a run on a later page never keeps a stale state.
 */
export class PluginWorkflowRuns {
  readonly #read: (cursor: string | null) => Promise<Page>;
  readonly #listeners = new Set<() => void>();
  #runs: readonly PluginWorkflowRunView[] = [];
  #cursor: string | null = null;
  #pages = 0;
  #shown = pluginFinishedRunsShown;
  #generation = 0;
  #running: Promise<void> | null = null;
  #dirty = false;
  #disposed = false;
  #state: PluginWorkflowRunsState = {
    visible: [],
    more: false,
    loaded: false,
    loading: false,
    loadingMore: false,
    error: null,
  };

  constructor(read: (cursor: string | null) => Promise<Page>) {
    this.#read = read;
  }

  getState = (): PluginWorkflowRunsState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Reads again every page loaded so far; overlapping calls coalesce into one more read. */
  refresh = (): Promise<void> => {
    if (this.#disposed) return Promise.resolve();
    this.#dirty = true;
    this.#running ??= this.#drain();
    return this.#running;
  };

  /** Shows more finished runs, reading the next page when the loaded ones run out. */
  showMore = async (): Promise<void> => {
    if (this.#disposed || this.#state.loadingMore) return;
    this.#shown += 10;
    const finished = this.#runs.filter((run) => !pluginWorkflowRunLive(run)).length;
    if (finished >= this.#shown || !this.#cursor || this.#running) return this.#publish({});
    const generation = this.#generation;
    this.#publish({ loadingMore: true, error: null });
    try {
      const page = await this.#read(this.#cursor);
      if (generation !== this.#generation || this.#disposed) return;
      this.#runs = merge(this.#runs, page.runs);
      this.#cursor = page.cursor;
      this.#pages += 1;
      this.#publish({ loadingMore: false });
    } catch (error) {
      if (generation === this.#generation && !this.#disposed)
        this.#publish({ loadingMore: false, error });
    }
  };

  dispose() {
    this.#disposed = true;
    this.#generation += 1;
    this.#listeners.clear();
  }

  async #drain() {
    try {
      while (this.#dirty && !this.#disposed) {
        this.#dirty = false;
        const generation = ++this.#generation;
        this.#publish({ loading: true, loadingMore: false, error: null });
        try {
          const pages = Math.max(1, this.#pages);
          let runs: readonly PluginWorkflowRunView[] = [];
          let cursor: string | null = null;
          let read = 0;
          do {
            const page = await this.#read(cursor);
            runs = merge(runs, page.runs);
            cursor = page.cursor;
            read += 1;
          } while (cursor && read < pages);
          if (generation !== this.#generation || this.#disposed) continue;
          this.#runs = runs;
          this.#cursor = cursor;
          this.#pages = read;
          this.#publish({ loaded: true, loading: false });
        } catch (error) {
          if (generation === this.#generation && !this.#disposed)
            this.#publish({ loading: false, error });
        }
      }
    } finally {
      this.#running = null;
    }
  }

  #publish(patch: Partial<PluginWorkflowRunsState>) {
    const live = this.#runs.filter(pluginWorkflowRunLive);
    const finished = this.#runs.filter((run) => !pluginWorkflowRunLive(run));
    this.#state = {
      ...this.#state,
      ...patch,
      visible: [...live, ...finished.slice(0, this.#shown)],
      more: finished.length > this.#shown || this.#cursor !== null,
    };
    for (const listener of this.#listeners) listener();
  }
}

function merge(
  runs: readonly PluginWorkflowRunView[],
  page: readonly PluginWorkflowRunView[],
): readonly PluginWorkflowRunView[] {
  const ids = new Set(page.map(({ id }) => id));
  return [...runs.filter(({ id }) => !ids.has(id)), ...page];
}
