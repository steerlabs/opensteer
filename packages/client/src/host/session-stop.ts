import { createClientAction, type ClientActionState } from "../actions/client-action.js";
import { clientScopeKey } from "../connections/connection-controller.js";
import { ClientOperationError } from "../connections/operation-error.js";
import type { HostClient } from "./client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { mutationIdempotencyKey } from "./host-session-client.js";

const owners = new WeakMap<HostClient, Map<string, SessionStopOwner>>();
const idle = { key: "", running: false, outcome: null, issue: null, unconfirmed: false } as const;

export interface SessionStopState extends ClientActionState<void> {
  readonly unconfirmed: boolean;
}

/** Stop is owned by the named session, independently of where its controls are mounted. */
export class SessionStopOwner {
  static for(client: HostClient, threadId: string, sessionId: string): SessionStopOwner {
    let sessions = owners.get(client);
    if (!sessions) owners.set(client, (sessions = new Map()));
    let owner = sessions.get(sessionId);
    if (!owner) {
      owner = new SessionStopOwner(client, threadId, sessionId, () => {
        if (sessions.get(sessionId) === owner) sessions.delete(sessionId);
      });
      sessions.set(sessionId, owner);
    }
    return owner;
  }

  readonly #listeners = new Set<() => void>();
  #state: SessionStopState = idle;
  #action: ReturnType<typeof createClientAction<void, void>> | null = null;
  #release: (() => void) | null = null;

  readonly #client: HostClient;
  readonly #threadId: string;
  readonly #sessionId: string;
  readonly #forget: () => void;

  private constructor(client: HostClient, threadId: string, sessionId: string, forget: () => void) {
    this.#client = client;
    this.#threadId = threadId;
    this.#sessionId = sessionId;
    this.#forget = forget;
  }

  getSnapshot = () => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      queueMicrotask(() => {
        if (!this.#listeners.size && !this.#state.running && !this.#state.unconfirmed)
          this.#finish(true);
      });
    };
  };

  run = () => {
    if (!this.#action) this.#start();
    return this.#action!.run(undefined);
  };

  reconcile = () => this.#action?.reconcile() ?? Promise.resolve();

  #start() {
    const client = this.#client;
    const threadId = this.#threadId;
    const sessionId = this.#sessionId;
    const key = `agent-session-stop:${sessionId}`;
    const scope = clientScopeKey(client.connection.getSnapshot().scope);
    let seen = false;
    const ended = () => {
      const snapshot = client.getSnapshot();
      const thread = threadInDirectory(threadId, snapshot);
      if (thread) {
        seen = true;
        const work = thread.externalWork;
        return work ? work.sessionId !== sessionId || work.status === "ended" : false;
      }
      return seen && snapshot.connection === "connected" && snapshot.tasks != null;
    };
    // Check only what the Home has reported. A check never sends Stop again.
    const action = createClientAction<void, void>(client, {
      key,
      label: "stop this agent",
      done: "stopped",
      happened: "it was stopped",
      execute: async () => {
        const result = await client.dispatch({
          type: "agent.session.stop",
          threadId,
          agentSessionId: sessionId,
          idempotencyKey: mutationIdempotencyKey(key),
        });
        if (result.type !== "agent.session.stop" || !result.ended)
          throw new ClientOperationError("Stop was not confirmed.", "blocked");
      },
      reconcile: async () => (ended() ? { kind: "confirmed", value: undefined } : null),
    });
    this.#action = action;
    const releaseAction = action.subscribe(() => {
      const state = action.getSnapshot();
      if (state.outcome?.kind === "confirmed" || (!state.running && ended())) {
        this.#finish(ended());
        return;
      }
      const previous = this.#state;
      const unconfirmed =
        previous.unconfirmed ||
        state.outcome?.kind === "unconfirmed" ||
        state.outcome?.kind === "rejected";
      // A new press or an offline response can't settle a previously uncertain Stop.
      const keep =
        previous.unconfirmed &&
        previous.issue !== null &&
        (state.outcome === null || state.outcome.kind === "not-sent");
      this.#publish({
        ...state,
        outcome: keep ? previous.outcome : state.outcome,
        issue: keep ? previous.issue : state.issue,
        unconfirmed,
      });
    });
    const retire = () => {
      if (
        clientScopeKey(client.connection.getSnapshot().scope) !== scope ||
        (!action.getSnapshot().running && ended())
      )
        this.#finish(true);
    };
    ended();
    const releaseSnapshot = client.subscribe(retire);
    const releaseConnection = client.connection.subscribe(retire);
    this.#release = () => {
      releaseAction();
      releaseSnapshot();
      releaseConnection();
      action.dispose();
    };
  }

  #finish(remove = false) {
    this.#release?.();
    this.#release = null;
    this.#action = null;
    if (remove) this.#forget();
    this.#publish(idle);
  }

  #publish(state: SessionStopState) {
    this.#state = state;
    this.#listeners.forEach((listener) => listener());
  }
}

export const idleSessionStopState: SessionStopState = idle;
