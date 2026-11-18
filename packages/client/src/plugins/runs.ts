import { pluginRunsMax, type PluginWorkflowRunView } from "@opensteer/protocol";

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
 * repeat one. A refresh reads the head and any previously seen unfinished run.
 */
export class PluginWorkflowRuns {
  readonly #read: (cursor: string | null, ids?: readonly string[]) => Promise<Page>;
  readonly #listeners = new Set<() => void>();
  #runs: readonly PluginWorkflowRunView[] = [];
  #cursor: string | null = null;
  #paged = false;
  #shown = pluginFinishedRunsShown;
  #generation = 0;
  #running: Promise<void> | null = null;
  #dirty = false;
  #state: PluginWorkflowRunsState = {
    visible: [],
    more: false,
    loaded: false,
    loading: false,
    loadingMore: false,
    error: null,
  };

  constructor(read: (cursor: string | null, ids?: readonly string[]) => Promise<Page>) {
    this.#read = read;
  }

  getState = (): PluginWorkflowRunsState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Overlapping calls coalesce into one more head and live-run read. */
  refresh = (signal?: AbortSignal): Promise<void> => {
    this.#dirty = true;
    if (this.#running) return this.#running;
    const abort = () => this.cancelRefresh();
    signal?.addEventListener("abort", abort, { once: true });
    const running = this.#drain(signal).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (this.#running === running) this.#running = null;
    });
    this.#running = running;
    return running;
  };

  /** Shows more finished runs, reading the next page when the loaded ones run out. */
  showMore = async (signal?: AbortSignal): Promise<void> => {
    if (this.#state.loadingMore) return;
    this.#shown += 10;
    const finished = this.#runs.filter((run) => !pluginWorkflowRunLive(run)).length;
    if (finished >= this.#shown || !this.#cursor || this.#running) return this.#publish({});
    const generation = this.#generation;
    this.#publish({ loadingMore: true, error: null });
    try {
      const page = await this.#read(this.#cursor);
      if (signal?.aborted || generation !== this.#generation) return;
      this.#runs = merge(this.#runs, page.runs);
      this.#cursor = page.cursor;
      this.#paged = true;
      this.#publish({ loadingMore: false });
    } catch (error) {
      if (!signal?.aborted && generation === this.#generation)
        this.#publish({ loadingMore: false, error });
    }
  };

  /** Discard an in-flight read when the consumer detaches, including during StrictMode replay. */
  cancelRefresh() {
    this.#generation += 1;
    this.#dirty = false;
    this.#running = null;
    if (this.#state.loading || this.#state.loadingMore)
      this.#publish({ loading: false, loadingMore: false });
  }

  async #drain(signal?: AbortSignal) {
    while (this.#dirty && !signal?.aborted) {
      this.#dirty = false;
      const generation = ++this.#generation;
      this.#publish({ loading: true, loadingMore: false, error: null });
      try {
        const head = await this.#read(null);
        if (generation !== this.#generation) continue;
        const seen = new Set(head.runs.map(({ id }) => id));
        const olderLive = this.#runs
          .filter((run) => pluginWorkflowRunLive(run) && !seen.has(run.id))
          .map(({ id }) => id);
        const reads: Promise<Page>[] = [];
        for (let offset = 0; offset < olderLive.length; offset += pluginRunsMax)
          reads.push(this.#read(null, olderLive.slice(offset, offset + pluginRunsMax)));
        const updates = await Promise.all(reads);
        if (generation !== this.#generation) continue;
        const terminal = this.#runs.filter((run) => !pluginWorkflowRunLive(run));
        this.#runs = merge(
          merge(
            terminal,
            updates.flatMap(({ runs }) => runs),
          ),
          head.runs,
        );
        if (!this.#paged) this.#cursor = head.cursor;
        this.#publish({ loaded: true, loading: false });
      } catch (error) {
        if (generation === this.#generation) this.#publish({ loading: false, error });
      }
    }
  }

  #publish(patch: Partial<PluginWorkflowRunsState>) {
    const live = this.#runs.filter(pluginWorkflowRunLive);
    const finished = this.#runs
      .filter((run) => !pluginWorkflowRunLive(run))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
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
