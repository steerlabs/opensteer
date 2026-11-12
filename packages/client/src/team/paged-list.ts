export interface KeysetPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export interface PagedListState<Item, First> {
  /** The first page's whole answer, for its other fields (revision, can). */
  readonly first: First | null;
  readonly items: readonly Item[];
  /** Null when the Host has no more, or the list reached its bound. */
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: unknown;
  /** True when more exist than this list will hold; narrow the search instead. */
  readonly capped: boolean;
}

/** Enough to find anything by scrolling; past it, search narrows the list. */
export const pagedListBound = 1000;

/**
 * A team list read page by page, the same on every surface: the first page,
 * then "Show more" appends the next by its cursor. A page answered for an
 * earlier load is dropped, so a reset never mixes two lists' rows.
 */
export class PagedList<Item, First extends KeysetPage<Item> = KeysetPage<Item>> {
  readonly #read: (cursor: string | null) => Promise<First>;
  readonly #listeners = new Set<() => void>();
  readonly #bound: number;
  #load = 0;
  #state: PagedListState<Item, First> = {
    first: null,
    items: [],
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    capped: false,
  };

  constructor(read: (cursor: string | null) => Promise<First>, bound = pagedListBound) {
    this.#read = read;
    this.#bound = bound;
  }

  getState = (): PagedListState<Item, First> => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Reads the first page again, dropping every appended row. */
  reload = async (): Promise<void> => {
    const load = ++this.#load;
    this.#set({ loading: true, loadingMore: false, error: null });
    try {
      const first = await this.#read(null);
      if (load !== this.#load) return;
      this.#set({
        first,
        items: first.items,
        ...this.#next(first.items.length, first.nextCursor),
        loading: false,
      });
    } catch (error) {
      if (load === this.#load) this.#set({ error, loading: false });
    }
  };

  more = async (): Promise<void> => {
    const { nextCursor, loadingMore } = this.#state;
    if (!nextCursor || loadingMore) return;
    const load = this.#load;
    this.#set({ loadingMore: true, error: null });
    try {
      const page = await this.#read(nextCursor);
      if (load !== this.#load) return;
      const items = [...this.#state.items, ...page.items].slice(0, this.#bound);
      this.#set({ items, ...this.#next(items.length, page.nextCursor), loadingMore: false });
    } catch (error) {
      if (load === this.#load) this.#set({ error, loadingMore: false });
    }
  };

  #next(count: number, cursor: string | null) {
    const capped = cursor !== null && count >= this.#bound;
    return { nextCursor: capped ? null : cursor, capped };
  }

  #set(patch: Partial<PagedListState<Item, First>>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
