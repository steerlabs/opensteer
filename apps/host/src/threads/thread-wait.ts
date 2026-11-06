import { OpensteerError, type Message, type RunId, type Run } from "@opensteer/core";

export interface ThreadWaitSnapshot {
  readonly connected: boolean;
  readonly pendingRequest?: { readonly id: string; readonly kind: string };
  readonly authorityExpiresAt?: number;
  readonly run?: { readonly id: RunId; readonly status: Run["status"] };
  readonly messages: readonly Message[];
  /** Messages after these were not read yet. */
  readonly hasMore?: boolean;
}
export class ThreadWaitService {
  readonly options: {
    readonly subscribe: (wake: () => void) => () => void;
    readonly read: () => Promise<ThreadWaitSnapshot>;
  };
  constructor(options: ThreadWaitService["options"]) {
    this.options = options;
  }
  wait(input: { readonly timeoutMs: number; readonly signal?: AbortSignal }) {
    return new Promise<
      ThreadWaitSnapshot & { readonly status: "running" | "settled" | "offline" | "timed_out" }
    >((resolve, reject) => {
      const deadline = Date.now() + Math.min(100_000, Math.max(1, input.timeoutMs));
      let done = false;
      let reading = false;
      let dirty = false;
      let snapshot: ThreadWaitSnapshot | undefined;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      let authorityTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        done = true;
        if (timer) clearTimeout(timer);
        if (authorityTimer) clearTimeout(authorityTimer);
        unsubscribe();
        input.signal?.removeEventListener("abort", aborted);
      };
      const fail = (error: unknown) => {
        if (!done) {
          cleanup();
          reject(error);
        }
      };
      const finish = (status: "running" | "settled" | "offline" | "timed_out") => {
        if (done || !snapshot) return;
        cleanup();
        resolve({ ...snapshot, status });
      };
      const aborted = () => fail(input.signal?.reason ?? new Error("Thread wait cancelled"));
      const read = () => {
        if (done) return;
        if (reading) {
          dirty = true;
          return;
        }
        reading = true;
        dirty = false;
        void this.options.read().then((value) => {
          if (done) return;
          snapshot = value;
          if (
            value.authorityExpiresAt !== undefined &&
            value.authorityExpiresAt <= deadline &&
            !authorityTimer
          )
            authorityTimer = setTimeout(
              () =>
                fail(
                  new OpensteerError({
                    code: "forbidden",
                    message: "MCP caller authority expired",
                  }),
                ),
              Math.max(1, value.authorityExpiresAt - Date.now()),
            );
          reading = false;
          if (!value.run || ["completed", "failed", "interrupted"].includes(value.run.status))
            finish("settled");
          else if (!value.connected) finish("offline");
          else if (value.pendingRequest || value.messages.length) finish("running");
          else if (dirty) read();
        }, fail);
      };
      // Subscribe before reading: an event during the read marks a second read,
      // and a commit before subscription is already in the first snapshot.
      unsubscribe = this.options.subscribe(read);
      input.signal?.addEventListener("abort", aborted, { once: true });
      if (input.signal?.aborted) {
        aborted();
        return;
      }
      timer = setTimeout(
        () => {
          snapshot ??= { connected: true, messages: [] };
          finish("timed_out");
        },
        Math.min(100_000, Math.max(1, input.timeoutMs)),
      );
      read();
    });
  }
}
