import type { InitialState } from "@react-navigation/native";

interface DestinationPorts {
  readonly receive: (url: string) => boolean | "callback";
  /** `release` lets the first screen render while resolution waits on the network. */
  readonly resolve: (
    url: string,
    current: () => boolean,
    release: () => void,
    intent: number,
  ) => Promise<InitialState | null>;
  readonly present: (state: InitialState) => void;
  readonly failed: (error: unknown) => void;
  /** Nothing is pending any more, so the published selection may need applying. */
  readonly settled: () => void;
}

interface Pending {
  state: InitialState | null | undefined;
  readonly done: Promise<void>;
  readonly finish: () => void;
  readonly reject: (error: unknown) => void;
  readonly released: Promise<void>;
  work: Promise<void>;
}

/** One external intent, kept in memory until storage and the root navigator are ready. */
export class PendingDestination {
  readonly #options: DestinationPorts;
  #markHydrated!: () => void;
  readonly #hydrated = new Promise<void>((resolve) => {
    this.#markHydrated = resolve;
  });
  #pending: Pending | null = null;
  #initial: Pending | null = null;
  #ready = false;
  #generation = 0;
  #received = false;
  #selection: string | null | undefined;
  #selectionFailed = -1;
  #reconciled: string | null | undefined;
  #account: string | null | undefined;

  constructor(options: DestinationPorts) {
    this.#options = options;
  }

  get received(): boolean {
    return this.#received;
  }

  /**
   * False once a newer external intent arrives. A screen a destination opened passes that
   * destination's `intent`, so it is checked against it even if it mounts later.
   */
  capture = (intent?: number): (() => boolean) => {
    const generation = intent ?? this.#generation;
    return () => generation === this.#generation;
  };

  submit(url: string): Promise<void> {
    this.#received = true;
    const consumed = this.#options.receive(url);
    if (consumed === "callback") return Promise.resolve();
    this.#pending?.finish();
    const generation = ++this.#generation;
    this.#selection = undefined;
    this.#reconciled = undefined;
    let finish!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending: Pending = {
      state: undefined,
      done,
      finish,
      reject,
      released,
      work: Promise.resolve(),
    };
    this.#pending = pending;
    const current = (): boolean => generation === this.#generation;
    pending.work = (async () => {
      await this.#hydrated;
      if (!current()) return;
      const state = consumed
        ? null
        : await this.#options.resolve(url, current, release, generation);
      if (!current()) return;
      pending.state = state;
      if (state !== null && this.#selectionFailed !== generation) {
        const home = state.routes[0];
        this.#selection =
          home?.params &&
          "deploymentId" in home.params &&
          typeof home.params.deploymentId === "string"
            ? home.params.deploymentId
            : null;
      }
      this.#flush();
    })().catch((error: unknown) => {
      if (!current()) return;
      this.#pending = null;
      this.#options.failed(error);
      pending.reject(error);
      this.#options.settled();
    });
    return pending.done;
  }

  hydrated(): void {
    this.#markHydrated();
  }

  async initialState(fallback: () => InitialState): Promise<InitialState> {
    while (this.#pending !== null) {
      const pending = this.#pending;
      // A rejected destination was already reported through `failed`; startup continues without it.
      await Promise.race([pending.work, pending.done, pending.released]).catch(() => undefined);
      if (pending !== this.#pending) continue;
      if (pending.state === undefined) return fallback();
      this.#initial = pending;
      return pending.state ?? fallback();
    }
    return fallback();
  }

  ready(): void {
    this.#ready = true;
    this.#flush();
  }

  /** Restoring an Account at startup clears side memory, but keeps the external stack. */
  account(subject: string | null): boolean {
    const previous = this.#account;
    this.#account = subject;
    return (
      previous !== undefined && previous !== null && previous !== subject && this.#pending === null
    );
  }

  /** The destination's Deployment could not be selected, so the shown selection may take the root back. */
  selectionFailed(): void {
    this.#selectionFailed = this.#generation;
    this.#selection = undefined;
    this.#reconciled = undefined;
  }

  /** Never over a pending or landed external destination whose Deployment is still being selected. */
  mayReconcileSelection(deploymentId: string | null): boolean {
    if (this.#pending !== null) return false;
    if (this.#selection !== undefined && this.#selection !== deploymentId) return false;
    this.#selection = undefined;
    return true;
  }

  /** Once per published selection, so a screen the person opened on purpose stays open. */
  selectionToReconcile(deploymentId: string | null): boolean {
    return this.mayReconcileSelection(deploymentId) && deploymentId !== this.#reconciled;
  }

  reconciled(deploymentId: string | null): void {
    this.#reconciled = deploymentId;
  }

  #flush(): void {
    const pending = this.#pending;
    if (pending === null || pending.state === undefined || !this.#ready) return;
    try {
      if (pending !== this.#initial && pending.state !== null) this.#options.present(pending.state);
      pending.finish();
    } catch (error) {
      this.#selection = undefined;
      this.#options.failed(error);
      pending.reject(error);
    }
    this.#pending = null;
    this.#initial = null;
    this.#options.settled();
  }
}
