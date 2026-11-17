import { clientScopeKey, type ClientSession } from "../connections/connection-controller.js";
import { classifyClientFailure } from "../connections/operation-error.js";
import { clientIssue, type ClientIssue } from "../feedback/client-issue.js";

export type ActionOutcome<T> =
  | { readonly kind: "confirmed"; readonly value: T }
  | { readonly kind: "rejected" | "not-sent" | "unconfirmed"; readonly issue: ClientIssue | null };
export interface ClientActionState<T> {
  readonly key: string;
  readonly running: boolean;
  readonly outcome: ActionOutcome<T> | null;
  readonly issue: ClientIssue | null;
}
export interface ClientAction<I, O> {
  getSnapshot(): ClientActionState<O>;
  subscribe(listener: () => void): () => void;
  preflight(): ActionOutcome<O> | null;
  run(input: I): Promise<ActionOutcome<O>>;
  reconcile(): Promise<void>;
  dismiss(): void;
  dispose(): void;
}
export interface ClientActionSpec<I, O> {
  readonly key: string;
  readonly label: string;
  readonly done?: string;
  readonly thing?: string;
  readonly execute: (input: I, signal: AbortSignal) => Promise<O>;
  readonly reconcile?: (input: I, signal: AbortSignal) => Promise<ActionOutcome<O> | null>;
}
export function createClientAction<I, O>(
  session: ClientSession,
  spec: ClientActionSpec<I, O>,
): ClientAction<I, O> {
  return new SessionClientAction(session, spec);
}

class SessionClientAction<I, O> implements ClientAction<I, O> {
  readonly #session: ClientSession;
  readonly #spec: ClientActionSpec<I, O>;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  #state: ClientActionState<O>;
  #controller: AbortController | null = null;
  #pending: Promise<ActionOutcome<O>> | null = null;
  #reconciling: Promise<void> | null = null;
  #scope: string | null;
  #input: { readonly value: I } | null = null;
  #disposed = false;
  #revision: number;
  constructor(session: ClientSession, spec: ClientActionSpec<I, O>) {
    this.#session = session;
    this.#spec = spec;
    const state = session.connection.getSnapshot();
    this.#scope = clientScopeKey(state.scope);
    this.#revision = state.readyRevision;
    this.#state = { key: spec.key, running: false, outcome: null, issue: null };
    this.#unsubscribe = session.connection.subscribe(() => {
      const state = session.connection.getSnapshot(),
        scope = clientScopeKey(state.scope);
      if (scope !== this.#scope) {
        this.#scope = scope;
        this.#controller?.abort();
        this.#controller = null;
        this.#input = null;
        this.#pending = null;
        this.#publish({ running: false, outcome: null, issue: null });
      }
      if (state.readyRevision !== this.#revision) {
        this.#revision = state.readyRevision;
        if (this.#state.outcome?.kind === "unconfirmed") void this.reconcile();
      }
    });
  }
  getSnapshot = (): ClientActionState<O> => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  preflight = (): ActionOutcome<O> | null => {
    const state = this.#session.connection.getSnapshot();
    if (
      !this.#disposed &&
      state.phase === "ready" &&
      state.network !== "offline" &&
      state.scope !== null
    )
      return null;
    return {
      kind: "not-sent",
      issue: {
        code: "not-sent",
        action: this.#spec.label,
        ...(this.#spec.done ? { done: this.#spec.done } : {}),
        ...(this.#spec.thing ? { thing: this.#spec.thing } : {}),
        reason: state.network === "offline" ? "offline" : "unreachable",
        ...(state.name ? { name: state.name } : {}),
      },
    };
  };
  run = (input: I): Promise<ActionOutcome<O>> => {
    if (this.#pending) return this.#pending;
    const unavailable = this.preflight();
    if (unavailable) {
      this.#publish({
        outcome: unavailable,
        issue: unavailable.kind === "confirmed" ? null : unavailable.issue,
      });
      return Promise.resolve(unavailable);
    }
    const controller = new AbortController();
    this.#controller = controller;
    const scope = this.#scope;
    this.#input = { value: input };
    this.#publish({ running: true, outcome: null, issue: null });
    const current = () =>
      this.#controller === controller && scope === this.#scope && !this.#disposed;
    const operation = Promise.resolve()
      .then<ActionOutcome<O>>(async () => {
        // Scope can change between a tap and the first dispatch microtask.
        if (!current()) return { kind: "not-sent" as const, issue: null };
        return Promise.resolve()
          .then(() => this.#spec.execute(input, controller.signal))
          .then(
            (value) => ({ kind: "confirmed" as const, value }),
            (error) => {
              const failure = classifyClientFailure(error);
              const issue = clientIssue(error, { operation: "action", label: this.#spec.label });
              return {
                kind:
                  failure.kind === "rejection" ? ("rejected" as const) : ("unconfirmed" as const),
                issue: issue && {
                  ...issue,
                  ...(this.#spec.done ? { done: this.#spec.done } : {}),
                  ...(this.#spec.thing ? { thing: this.#spec.thing } : {}),
                },
              };
            },
          );
      })
      .then((outcome) => {
        if (current())
          this.#publish({
            running: false,
            outcome,
            issue: outcome.kind === "confirmed" ? null : outcome.issue,
          });
        return outcome;
      })
      .finally(() => {
        if (this.#pending === operation) this.#pending = null;
      });
    this.#pending = operation;
    return operation;
  };
  reconcile = (): Promise<void> => {
    if (this.#reconciling) return this.#reconciling;
    if (
      !this.#spec.reconcile ||
      !this.#input ||
      this.#state.outcome?.kind !== "unconfirmed" ||
      this.preflight()
    )
      return Promise.resolve();
    const controller = this.#controller,
      scope = this.#scope;
    if (!controller) return Promise.resolve();
    const pending = this.#spec
      .reconcile(this.#input.value, controller.signal)
      .then(
        (outcome) => {
          if (
            outcome &&
            controller === this.#controller &&
            scope === this.#scope &&
            !this.#disposed
          )
            this.#publish({ outcome, issue: outcome.kind === "confirmed" ? null : outcome.issue });
        },
        () => {},
      )
      .finally(() => {
        if (this.#reconciling === pending) this.#reconciling = null;
      });
    this.#reconciling = pending;
    return pending;
  };
  dismiss = (): void => {
    this.#publish({ issue: null });
  };
  dispose = (): void => {
    this.#disposed = true;
    this.#controller?.abort();
    this.#unsubscribe();
    this.#listeners.clear();
  };
  #publish(patch: Partial<ClientActionState<O>>): void {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((fn) => fn());
  }
}

export function createClientActionFamily<I, O>(
  session: ClientSession,
  spec: Omit<ClientActionSpec<I, O>, "key">,
): {
  for(key: string): ClientAction<I, O>;
  dispose(): void;
} {
  const actions = new Map<string, ClientAction<I, O>>();
  return {
    for(key) {
      let action = actions.get(key);
      if (!action) {
        action = createClientAction(session, { ...spec, key });
        actions.set(key, action);
      }
      return action;
    },
    dispose() {
      actions.forEach((action) => action.dispose());
      actions.clear();
    },
  };
}
