import type { BrowserTabDestination } from "./browser-thread-tabs.js";

export interface BrowserAgentFollowInput {
  readonly threadId: string | null;
  readonly shownTab: BrowserTabDestination | null;
  readonly agentTab: BrowserTabDestination | null;
}

export interface BrowserAgentFollowState extends BrowserAgentFollowInput {
  readonly following: boolean;
  readonly waitingForMatch: boolean;
  readonly deadline: number | null;
}

export type BrowserAgentFollowEvent =
  | { readonly type: "update"; readonly input: BrowserAgentFollowInput }
  | { readonly type: "pause" | "resume" | "settle" };

export interface BrowserAgentFollowTransition {
  readonly state: BrowserAgentFollowState;
  readonly follow: BrowserTabDestination | null;
}

export function initialBrowserAgentFollowState(): BrowserAgentFollowState {
  return {
    threadId: null,
    shownTab: null,
    agentTab: null,
    following: false,
    waitingForMatch: true,
    deadline: null,
  };
}

function sameTab(a: BrowserTabDestination | null, b: BrowserTabDestination | null): boolean {
  return a !== null && b !== null && a.sessionId === b.sessionId && a.tabId === b.tabId;
}

export function transitionBrowserAgentFollow(
  previous: BrowserAgentFollowState,
  event: BrowserAgentFollowEvent,
  now: number,
): BrowserAgentFollowTransition {
  let state = previous;
  let follow: BrowserTabDestination | null = null;
  if (event.type === "update") {
    const changedThread = previous.threadId !== event.input.threadId;
    state = { ...(changedThread ? initialBrowserAgentFollowState() : previous), ...event.input };
    if (state.threadId === null) state = initialBrowserAgentFollowState();
    else if (state.agentTab === null && state.following)
      state = { ...state, following: false, waitingForMatch: false, deadline: null };
    else if (state.waitingForMatch && sameTab(state.shownTab, state.agentTab))
      state = { ...state, following: true, waitingForMatch: false };
  } else if (event.type === "pause") {
    state = { ...state, following: false, waitingForMatch: false, deadline: null };
  } else if (event.type === "resume") {
    follow = state.threadId === null ? null : state.agentTab;
    state = {
      ...state,
      following: follow !== null,
      waitingForMatch: false,
      shownTab: follow ?? state.shownTab,
      deadline: null,
    };
  } else if (state.deadline !== null && now >= state.deadline && state.following) {
    follow = sameTab(state.shownTab, state.agentTab) ? null : state.agentTab;
    state = { ...state, shownTab: follow ?? state.shownTab, deadline: null };
  }
  state = {
    ...state,
    deadline:
      state.following && state.agentTab !== null
        ? (state.deadline ?? (!sameTab(state.shownTab, state.agentTab) ? now + 1000 : null))
        : null,
  };
  return { state, follow };
}

export interface BrowserAgentFollowTimers {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

const defaultTimers: BrowserAgentFollowTimers = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export class BrowserAgentFollow {
  #state = initialBrowserAgentFollowState();
  #cancel: (() => void) | undefined;
  readonly onFollow: (tab: BrowserTabDestination) => void;
  readonly onChange: (following: boolean) => void;
  readonly timers: BrowserAgentFollowTimers;
  constructor(
    onFollow: (tab: BrowserTabDestination) => void,
    onChange: (following: boolean) => void = () => {},
    timers: BrowserAgentFollowTimers = defaultTimers,
  ) {
    this.onFollow = onFollow;
    this.onChange = onChange;
    this.timers = timers;
  }
  get state(): BrowserAgentFollowState {
    return this.#state;
  }
  update(input: BrowserAgentFollowInput): void {
    this.#dispatch({ type: "update", input });
  }
  readonly pause = (): void => {
    this.#dispatch({ type: "pause" });
  };
  readonly resume = (): BrowserTabDestination | null => this.#dispatch({ type: "resume" });
  dispose(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }
  #dispatch(event: BrowserAgentFollowEvent): BrowserTabDestination | null {
    this.dispose();
    const { state, follow } = transitionBrowserAgentFollow(this.#state, event, this.timers.now());
    this.#state = state;
    if (state.deadline !== null)
      this.#cancel = this.timers.schedule(
        () => this.#dispatch({ type: "settle" }),
        Math.max(0, state.deadline - this.timers.now()),
      );
    this.onChange(state.following);
    if (follow) this.onFollow(follow);
    return follow;
  }
}
