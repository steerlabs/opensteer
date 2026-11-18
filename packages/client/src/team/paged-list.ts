import { createClientRead, type ClientRead } from "../reads/client-read.js";
import { clientScopeKey, type ClientSession } from "../connections/connection-controller.js";
import type { ClientIssue } from "../feedback/client-issue.js";

export interface KeysetPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}
export interface PagedListState<Item, First> {
  readonly first: First | null;
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: ClientIssue | null;
  readonly capped: boolean;
}
export const pagedListBound = 1000;
interface Pages<Item, First> {
  readonly scope: string | null;
  readonly first: First;
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export class PagedList<Item, First extends KeysetPage<Item> = KeysetPage<Item>> {
  readonly #resource: ClientRead<Pages<Item, First>>;
  #append = false;
  #source: ReturnType<ClientRead<Pages<Item, First>>["getSnapshot"]> | null = null;
  #state: PagedListState<Item, First> = {
    first: null,
    items: [],
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    capped: false,
  };
  constructor(
    session: ClientSession,
    read: (cursor: string | null) => Promise<First>,
    bound = pagedListBound,
    subscribeInvalidation?: (listener: () => void) => () => void,
  ) {
    this.#resource = createClientRead(session, {
      key: "pages",
      label: "this list",
      remember: true,
      ...(subscribeInvalidation === undefined ? {} : { subscribeInvalidation }),
      read: async (signal) => {
        const scope = clientScopeKey(session.connection.getSnapshot().scope);
        const current = this.#resource.getSnapshot();
        const held =
          this.#append && current.status === "ready" && current.data.scope === scope
            ? current.data
            : null;
        const page = await read(held?.nextCursor ?? null);
        signal.throwIfAborted();
        this.#append = false;
        return {
          scope,
          first: held?.first ?? page,
          items: [...(held?.items ?? []), ...page.items].slice(0, bound),
          nextCursor: page.nextCursor,
        };
      },
    });
    this.#bound = bound;
  }
  readonly #bound: number;
  getState = (): PagedListState<Item, First> => {
    const source = this.#resource.getSnapshot();
    if (this.#source === source) return this.#state;
    this.#source = source;
    const data = source.status === "ready" ? source.data : null;
    const capped = !!data?.nextCursor && data.items.length >= this.#bound;
    this.#state = {
      first: data?.first ?? null,
      items: data?.items ?? [],
      nextCursor: capped ? null : (data?.nextCursor ?? null),
      loading: source.status === "loading" || source.status === "waiting",
      loadingMore: source.status === "ready" && source.refreshing && this.#append,
      error: source.issue,
      capped,
    };
    return this.#state;
  };
  subscribe = (listener: () => void): (() => void) => this.#resource.subscribe(listener);
  reload = (): Promise<void> => {
    this.#append = false;
    return this.#resource.refresh();
  };
  more = (): Promise<void> => {
    const state = this.getState();
    if (!state.nextCursor || state.loadingMore) return Promise.resolve();
    this.#append = true;
    return this.#resource.refresh();
  };
  dispose = (): void => this.#resource.dispose();
}
