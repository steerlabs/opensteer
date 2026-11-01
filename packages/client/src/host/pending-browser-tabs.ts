import type { BrowserTabOpenResult } from "@opensteer/protocol";
import {
  HostClientRequestError,
  isHostRefusal,
  type BrowserTabOpenHandle,
  type BrowserTabOpenInput,
  type BrowserTabOpenOptions,
  type PendingBrowserTab,
} from "./client.js";

interface Opening {
  readonly target: BrowserTabOpenInput;
  readonly options: BrowserTabOpenOptions;
  handle: BrowserTabOpenHandle;
  state: "opening" | "unknown" | "failed" | "opened";
  dismissed: boolean;
}

function fingerprint(target: BrowserTabOpenInput, options: BrowserTabOpenOptions): string {
  return JSON.stringify([
    "sessionId" in target
      ? [target.sessionId]
      : [
          target.identity.kind,
          target.identity.kind === "profile" ? target.identity.profileId : null,
          target.placement?.runnerId,
        ],
    options.url,
    options.viewport?.width,
    options.viewport?.height,
  ]);
}

interface PendingBrowserTabPorts {
  readonly admitted: () => boolean;
  readonly open: (
    target: BrowserTabOpenInput,
    options: BrowserTabOpenOptions,
  ) => Promise<BrowserTabOpenResult>;
  readonly close: (result: BrowserTabOpenResult) => Promise<unknown>;
  readonly changed: (rows: readonly PendingBrowserTab[]) => void;
}

/** Presentation only: an unknown submission can be replayed, never replaced implicitly. */
export class PendingBrowserTabs {
  readonly #opens = new Map<string, Opening>();
  readonly #completed = new Set<string>();
  #rows: readonly PendingBrowserTab[] = [];
  #generation = 0;

  readonly #ports: PendingBrowserTabPorts;
  #disposed = false;
  constructor(ports: PendingBrowserTabPorts) {
    this.#ports = ports;
  }

  get rows(): readonly PendingBrowserTab[] {
    return this.#rows;
  }

  readonly begin = (
    target: string | BrowserTabOpenInput,
    options: BrowserTabOpenOptions = {},
  ): BrowserTabOpenHandle => {
    if (this.#disposed || !this.#ports.admitted())
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "Sign in to open a browser tab.",
      });
    const key = options.idempotencyKey ?? `open-tab:${crypto.randomUUID()}`;
    const input = typeof target === "string" ? { sessionId: target } : target;
    const previous = this.#opens.get(key);
    if (previous && options.viewport === undefined && previous.options.viewport)
      options = { ...options, viewport: previous.options.viewport };
    if (previous) {
      if (fingerprint(previous.target, previous.options) !== fingerprint(input, options))
        throw new HostClientRequestError({
          code: "conflict",
          status: 409,
          message: "This browser opening already has another destination.",
        });
      if (previous.state === "opening" || previous.state === "opened") return previous.handle;
    }
    const generation = this.#generation;
    const uncertain = previous?.state === "unknown";
    let resolve!: (result: BrowserTabOpenResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<BrowserTabOpenResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const handle = { idempotencyKey: key, result };
    const opening: Opening = previous ?? {
      target:
        "sessionId" in input
          ? { sessionId: input.sessionId }
          : {
              identity: { ...input.identity },
              ...(input.placement ? { placement: { ...input.placement } } : {}),
            },
      options: {
        ...options,
        ...(options.viewport ? { viewport: { ...options.viewport } } : {}),
        idempotencyKey: key,
      },
      handle,
      state: "opening",
      dismissed: false,
    };
    // Install the handle before publishing: a synchronous subscriber may join it.
    opening.handle = handle;
    opening.state = "opening";
    this.#opens.set(key, opening);
    if (!opening.dismissed)
      this.#publish({
        idempotencyKey: key,
        target: opening.target,
        ...(opening.options.url === undefined ? {} : { url: opening.options.url }),
        ...(opening.options.typed === undefined ? {} : { typed: opening.options.typed }),
        ...(opening.options.viewport ? { viewport: opening.options.viewport } : {}),
        state: "opening",
      });
    void this.#run(key, opening, generation, uncertain).then(resolve, reject);
    return opening.handle;
  };

  async #run(
    key: string,
    opening: Opening,
    generation: number,
    uncertain: boolean,
  ): Promise<BrowserTabOpenResult> {
    try {
      this.#requireCurrent(generation);
      const result = await this.#ports.open(opening.target, opening.options);
      this.#requireCurrent(generation);
      opening.state = "opened";
      if (opening.dismissed) await this.#ports.close(result);
      this.#requireCurrent(generation);
      this.#remove(key);
      this.#completed.add(key);
      if (this.#completed.size > 100) {
        const oldest = this.#completed.values().next().value!;
        this.#completed.delete(oldest);
        this.#opens.delete(oldest);
      }
      return result;
    } catch (error) {
      if (generation === this.#generation) {
        opening.state =
          uncertain ||
          !isHostRefusal(error) ||
          (error instanceof HostClientRequestError &&
            error.reason === "browser-tab-open-outcome-unknown")
            ? "unknown"
            : "failed";
        if (!opening.dismissed)
          this.#publish({
            idempotencyKey: key,
            target: opening.target,
            ...(opening.options.url === undefined ? {} : { url: opening.options.url }),
            ...(opening.options.typed === undefined ? {} : { typed: opening.options.typed }),
            ...(opening.options.viewport ? { viewport: opening.options.viewport } : {}),
            state: opening.state,
            error: {
              code:
                error instanceof HostClientRequestError ? (error.reason ?? error.code) : "unknown",
              message: error instanceof Error ? error.message : "The browser could not be opened.",
            },
          });
      }
      throw error;
    }
  }

  #requireCurrent(generation: number): void {
    if (generation !== this.#generation)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "The signed-in account changed while the browser was opening.",
      });
  }

  readonly dismiss = (key: string): void => {
    const opening = this.#opens.get(key);
    if (!opening) return;
    opening.dismissed = true;
    this.#remove(key);
  };

  dispose(): void {
    this.#disposed = true;
    this.clear();
  }

  clear(): void {
    this.#generation += 1;
    this.#opens.clear();
    this.#completed.clear();
    this.#rows = [];
  }

  #publish(row: PendingBrowserTab): void {
    this.#rows = [
      ...this.#rows.filter((value) => value.idempotencyKey !== row.idempotencyKey),
      row,
    ];
    this.#ports.changed(this.#rows);
  }
  #remove(key: string): void {
    const rows = this.#rows.filter((value) => value.idempotencyKey !== key);
    if (rows.length === this.#rows.length) return;
    this.#rows = rows;
    this.#ports.changed(rows);
  }
}
