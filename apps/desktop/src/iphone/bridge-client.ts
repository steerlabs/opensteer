import { spawnSupervised, type SupervisedProcess } from "@opensteer/harness/process-supervisor";
import {
  encodeLengthPrefixedJson,
  LengthPrefixedFrameReader,
} from "@opensteer/shared/lengthPrefixedJson";
import {
  iphoneBridgeBounds,
  iphoneNativeEventSchema,
  iphoneNativeFailureSchema,
  iphoneNativeHelloSchema,
  iphoneNativeRosterSchema,
  type IphoneNativeMessage,
} from "@opensteer/protocol/iphone-bridge";
import { z } from "zod";
import { IphoneServiceError } from "./iphone-store.js";

export interface IphoneNativeTransport {
  request<T>(
    method: string,
    params: unknown,
    result: z.ZodType<T>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
  onEvent(listener: (event: Extract<IphoneNativeMessage, { kind: "event" }>) => void): () => void;
  onLost(listener: () => void): () => void;
  onGap?(listener: () => void): () => void;
  close(): Promise<void>;
}
interface Pending {
  settle(error: Error | undefined, result?: unknown): void;
  readonly method: string;
}
const responseSchema = z.strictObject({
  kind: z.literal("response"),
  id: z.number().int().positive(),
  result: z.unknown(),
});
const failedSchema = z.strictObject({ error: iphoneNativeFailureSchema });
export class IphoneBridgeClient implements IphoneNativeTransport {
  readonly #process: SupervisedProcess;
  readonly #pending = new Map<number, Pending>();
  readonly #events = new Set<Parameters<IphoneNativeTransport["onEvent"]>[0]>();
  readonly #lost = new Set<() => void>();
  readonly #gaps = new Set<() => void>();
  #nextId = 1;
  #closed = false;
  #closing: Promise<void> | undefined;
  #bootId: string | undefined;
  #sequence = 0;
  constructor(process: SupervisedProcess, log: (line: string) => void = () => undefined) {
    this.#process = process;
    process.child.stdin.on("error", () => this.#fail());
    void this.#read().catch(() => this.#fail());
    // The bridge scrubs device identifiers from its diagnostics before writing them.
    void (async () => {
      const text = new TextDecoder();
      let partial = "";
      for await (const chunk of process.stderr) {
        const lines = (partial + text.decode(chunk as Uint8Array, { stream: true })).split("\n");
        partial = lines.pop()!.slice(0, 16_384);
        for (const line of lines) if (line) log(line);
      }
      if (partial) log(partial);
    })().catch(() => this.#fail());
    void process.exited.then(
      () => this.#fail(),
      () => this.#fail(),
    );
  }
  static async start(options: {
    binary: string;
    supervisorExecutable: string;
    privateRoot: string;
    imageRoots: readonly string[];
    environment: Readonly<Record<string, string>>;
    log?: (line: string) => void;
  }): Promise<{
    client: IphoneBridgeClient;
    images: { build: string; version?: string | undefined }[];
  }> {
    const process = spawnSupervised({
      executable: options.binary,
      supervisorExecutable: options.supervisorExecutable,
      args: [],
      cwd: options.privateRoot,
      environment: options.environment,
      output: "raw",
      stdin: "pipe",
    });
    const client = new IphoneBridgeClient(process, options.log);
    try {
      const hello = await client.request("hello", {}, iphoneNativeHelloSchema);
      client.#bootId = hello.bootId;
      const { images } = await client.request(
        "init",
        { privateRoot: options.privateRoot, imageRoots: options.imageRoots },
        z.strictObject({
          images: z
            .array(z.strictObject({ build: z.string(), version: z.string().optional() }))
            .max(8),
        }),
      );
      return { client, images };
    } catch (error) {
      await client.close();
      throw error instanceof IphoneServiceError
        ? error
        : new IphoneServiceError("bridge-protocol-mismatch");
    }
  }
  request<T>(
    method: string,
    params: unknown,
    result: z.ZodType<T>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new IphoneServiceError("phone-disconnected"));
    if (options.signal?.aborted) return Promise.reject(new IphoneServiceError("cancelled"));
    if (this.#pending.size >= iphoneBridgeBounds.pendingRequests - 1)
      return Promise.reject(new IphoneServiceError("phone-in-use"));
    const id = this.#nextId++;
    if (!Number.isSafeInteger(id)) {
      this.#fail();
      return Promise.reject(new IphoneServiceError("protocol-unsupported"));
    }
    const maxTimeoutMs =
      method === "setup.prepareDeveloperServices" ||
      method === "binding.probe" ||
      method === "session.open"
        ? 120000
        : 30000;
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 30000, maxTimeoutMs));
    const frame = encodeLengthPrefixedJson(
      { kind: "request", protocolVersion: 1, id, timeoutMs, method, params },
      iphoneBridgeBounds.requestBytes,
    );
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const error = new IphoneServiceError(
          options.signal?.aborted ? "cancelled" : "deadline-exceeded",
          method === "phone.perform" ? "unknown" : "not-started",
        );
        pending.settle(error);
        if (!this.#closed && method !== "request.cancel")
          void this.request("request.cancel", { requestId: id }, z.strictObject({}), {
            timeoutMs: 1000,
          }).catch(() => undefined);
      };
      const timer = setTimeout(cancel, timeoutMs);
      timer.unref();
      const pending: Pending = {
        method,
        settle: (error, value) => {
          if (!this.#pending.delete(id)) return;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
          if (error) {
            reject(error);
            return;
          }
          try {
            const failure = failedSchema.safeParse(value);
            if (failure.success && method !== "phone.perform")
              reject(new IphoneServiceError(failure.data.error.code, failure.data.error.effect));
            else {
              const parsed = result.parse(value);
              if (method === "hello") this.#bootId = iphoneNativeHelloSchema.parse(parsed).bootId;
              resolve(parsed);
            }
          } catch {
            reject(
              new IphoneServiceError(
                method === "hello" ? "bridge-protocol-mismatch" : "protocol-unsupported",
                method === "phone.perform" ? "unknown" : "not-started",
              ),
            );
            this.#fail();
          }
        },
      };
      this.#pending.set(id, pending);
      options.signal?.addEventListener("abort", cancel, { once: true });
      this.#process.child.stdin.write(frame, (error) => {
        if (error) this.#fail();
      });
    });
  }
  onEvent(listener: Parameters<IphoneNativeTransport["onEvent"]>[0]): () => void {
    this.#events.add(listener);
    return () => {
      this.#events.delete(listener);
    };
  }
  onGap(listener: () => void): () => void {
    this.#gaps.add(listener);
    return () => {
      this.#gaps.delete(listener);
    };
  }
  onLost(listener: () => void): () => void {
    this.#lost.add(listener);
    return () => {
      this.#lost.delete(listener);
    };
  }
  async #read(): Promise<void> {
    const reader = new LengthPrefixedFrameReader(iphoneBridgeBounds.responseBytes);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const chunk of this.#process.stdout) {
      for (const body of reader.push(chunk)) {
        if (body.length === 0) throw new Error();
        const value: unknown = JSON.parse(decoder.decode(body));
        const event = iphoneNativeEventSchema.safeParse(value);
        if (event.success) {
          if (
            body.length > iphoneBridgeBounds.eventBytes ||
            event.data.bootId !== this.#bootId ||
            event.data.sequence <= this.#sequence
          )
            throw new Error();
          const gap = event.data.sequence !== this.#sequence + 1;
          this.#sequence = event.data.sequence;
          if (gap) {
            for (const listener of this.#gaps) listener();
            void this.request("roster.get", {}, iphoneNativeRosterSchema)
              .then((roster) => {
                for (const listener of this.#events) listener({ ...event.data, roster });
              })
              .catch(() => this.#fail());
          }
          for (const listener of this.#events) listener(event.data);
        } else {
          const response = responseSchema.parse(value);
          this.#pending.get(response.id)?.settle(undefined, response.result);
        }
      }
    }
    this.#fail();
  }
  #fail(terminate = true): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of Array.from(this.#pending.values()))
      pending.settle(
        new IphoneServiceError(
          "phone-disconnected",
          pending.method === "phone.perform" ? "unknown" : "not-started",
        ),
      );
    for (const listener of this.#lost) listener();
    if (terminate) void this.#process.terminate(0).catch(() => undefined);
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#fail(false);
      this.#process.child.stdin.end();
      await this.#process.terminate(5000);
    })();
    return this.#closing;
  }
}
