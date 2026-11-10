import type { BrowserTabDestination } from "./browser-thread-tabs.js";

/** A busy agent never moves the page more than once a second. */
const switchInterval = 1000;

export interface BrowserAgentFollowInput {
  readonly threadId: string | null;
  readonly shownTab: BrowserTabDestination | null;
  readonly agentTab: BrowserTabDestination | null;
  /** Something is open over the page, such as its tab sheet: following waits to move it. */
  readonly held?: boolean;
}

export interface BrowserAgentFollowState {
  readonly threadId: string | null;
  /** The page's tab as last reported, or where following just sent it. */
  readonly shownTab: BrowserTabDestination | null;
  readonly agentTab: BrowserTabDestination | null;
  readonly held: boolean;
  /** The page's tab as last reported, which tells the person's moves from following's own. */
  readonly observedTab: BrowserTabDestination | null;
  /** Where following last sent the page, until the page reports being there. */
  readonly lastFollow: BrowserTabDestination | null;
  readonly following: boolean;
  /** The person took the page over; only their own return to the agent's tab follows again. */
  readonly steering: boolean;
  readonly deadline: number | null;
  readonly lastSwitch: number | null;
}

export type BrowserAgentFollowEvent =
  | { readonly type: "update"; readonly input: BrowserAgentFollowInput }
  | { readonly type: "steer" | "settle" };

export interface BrowserAgentFollowTransition {
  readonly state: BrowserAgentFollowState;
  readonly follow: BrowserTabDestination | null;
}

export function initialBrowserAgentFollowState(): BrowserAgentFollowState {
  return {
    threadId: null,
    shownTab: null,
    agentTab: null,
    held: false,
    observedTab: null,
    lastFollow: null,
    following: false,
    steering: false,
    deadline: null,
    lastSwitch: null,
  };
}

function sameTab(a: BrowserTabDestination | null, b: BrowserTabDestination | null): boolean {
  return a !== null && b !== null && a.sessionId === b.sessionId && a.tabId === b.tabId;
}

/**
 * Following starts when the page and the agent's tab meet: the page opens on
 * it, the agent arrives in the page, or the person goes to it. It stops when
 * the person moves the page themselves; from then until the agent leaves the
 * browser, only their own return to the agent's tab starts it again.
 */
function updated(
  previous: BrowserAgentFollowState,
  input: BrowserAgentFollowInput,
): BrowserAgentFollowState {
  const { threadId, shownTab, agentTab, held = false } = input;
  if (threadId === null) return initialBrowserAgentFollowState();
  const base = previous.threadId === threadId ? previous : initialBrowserAgentFollowState();
  const meets = sameTab(shownTab, agentTab);
  // Following's own move, now in the page; a later visit there is the person's.
  const arrived = sameTab(shownTab, base.lastFollow);
  const moved =
    base.threadId !== null &&
    !arrived &&
    !(shownTab === null ? base.observedTab === null : sameTab(shownTab, base.observedTab));
  let { following, steering } = base;
  if (moved) {
    following = meets;
    steering = !meets;
  } else if (meets && !steering && !sameTab(base.shownTab, base.agentTab)) following = true;
  if (agentTab === null) {
    following = false;
    steering = false;
  }
  return {
    ...base,
    threadId,
    shownTab,
    agentTab,
    held,
    observedTab: shownTab,
    lastFollow: arrived ? null : base.lastFollow,
    following,
    steering,
  };
}

export function transitionBrowserAgentFollow(
  previous: BrowserAgentFollowState,
  event: BrowserAgentFollowEvent,
  now: number,
): BrowserAgentFollowTransition {
  let state =
    event.type === "update"
      ? updated(previous, event.input)
      : event.type === "steer"
        ? { ...previous, following: false, steering: previous.agentTab !== null }
        : previous;
  let follow: BrowserTabDestination | null = null;
  if (
    state.following &&
    !state.held &&
    state.agentTab !== null &&
    !sameTab(state.shownTab, state.agentTab)
  ) {
    const deadline = state.lastSwitch === null ? now : state.lastSwitch + switchInterval;
    if (now >= deadline) {
      follow = state.agentTab;
      state = { ...state, shownTab: follow, lastFollow: follow, lastSwitch: now, deadline: null };
    } else state = { ...state, deadline };
  } else state = { ...state, deadline: null };
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
  /** The person moved the page themselves, within its tab: following stops. */
  readonly steer = (): void => {
    this.#dispatch({ type: "steer" });
  };
  dispose(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }
  #dispatch(event: BrowserAgentFollowEvent): void {
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
  }
}
