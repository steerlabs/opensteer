import { OpensteerError, ThreadIdSchema } from "@opensteer/core";
import {
  FileSourceSchema,
  FileResourceSchema,
  TranscriptFileOpenSchema,
  TranscriptFileContentSchema,
  type FileSource,
  type FileResource,
  type TranscriptFileOpen,
  type TranscriptFileContent,
} from "@opensteer/protocol";
import type { ReferenceReadPorts } from "../references/contracts.js";
import type { AssetUrlStore } from "./asset-urls.js";
import { HostClientRequestError } from "./client.js";
import { HostTransportError } from "../connections/host-transport-error.js";

export type OpenTranscriptFile = Extract<TranscriptFileOpen, { status: "ok" }>;
export type TranscriptFileState =
  | TranscriptFileOpen
  | { readonly status: "offline"; readonly cached: OpenTranscriptFile | null }
  | { readonly status: "failed" };
export type TranscriptFileDownload =
  | ({ readonly status: "ok" } & TranscriptFileContent)
  | { readonly status: "unavailable" | "offline" | "failed" };
interface Operation<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  users: number;
}
const textCacheLimit = 4 * 1024 * 1024;
function cancelled() {
  const error = new Error("File view ended");
  error.name = "AbortError";
  return error;
}
function isOffline(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof HostClientRequestError &&
      (error.reason === "transport-unreachable" ||
        error.reason === "transport-timed-out" ||
        error.code === "runner_offline" ||
        error.code === "timeout")) ||
    (error instanceof HostTransportError &&
      (error.code === "unreachable" || error.code === "timed-out")) ||
    (error instanceof OpensteerError &&
      (error.code === "runner_offline" || error.code === "timeout"))
  );
}
function isUnavailable(error: unknown): boolean {
  return (
    (error instanceof HostClientRequestError && (error.status === 403 || error.status === 404)) ||
    (error instanceof OpensteerError && (error.code === "forbidden" || error.code === "not_found"))
  );
}

export interface TranscriptFileImages {
  readonly store: Pick<AssetUrlStore, "seed">;
  readonly deploymentId: () => string | null;
}

export class TranscriptFileController {
  readonly #ports: Pick<ReferenceReadPorts, "openFile" | "readFile">;
  readonly #opens = new Map<string, Operation<TranscriptFileState>>();
  readonly #downloads = new Map<string, Operation<TranscriptFileDownload>>();
  readonly #cache = new Map<
    string,
    { readonly value: OpenTranscriptFile; readonly bytes: number }
  >();
  readonly #ownerSignal: AbortSignal | undefined;
  readonly #images: TranscriptFileImages | undefined;
  #bytes = 0;
  #generation = 0;
  #disposed = false;
  constructor(options: {
    readonly rpc: Pick<ReferenceReadPorts, "openFile" | "readFile">;
    readonly ownerSignal?: AbortSignal;
    /** Where an image's preview, minted by the open itself, is kept for the viewer to show. */
    readonly images?: TranscriptFileImages;
  }) {
    this.#ports = options.rpc;
    this.#images = options.images;
    this.#ownerSignal = options.ownerSignal;
    if (this.#ownerSignal?.aborted) this.dispose();
    else this.#ownerSignal?.addEventListener("abort", this.#retire, { once: true });
  }
  readonly #retire = () => this.dispose();
  open(
    threadId: string | null,
    source: FileSource,
    signal?: AbortSignal,
  ): Promise<TranscriptFileState> {
    const input = {
      threadId: threadId === null ? null : ThreadIdSchema.parse(threadId),
      source: FileSourceSchema.parse(source),
    };
    const key = JSON.stringify([
      input.threadId,
      input.source.kind,
      input.source.kind === "path" ? input.source.path : input.source.attachmentId,
    ]);
    return this.#share(this.#opens, key, signal, async (controller, generation) => {
      try {
        const value = TranscriptFileOpenSchema.parse(
          await this.#ports.openFile(input, controller.signal),
        );
        this.#assertCurrent(controller, generation);
        this.#forget(key);
        const deploymentId = this.#images?.deploymentId();
        if (value.status === "ok" && value.preview.kind === "image" && deploymentId)
          this.#images!.store.seed(
            deploymentId,
            input.threadId,
            input.source,
            "preview",
            value.preview.image,
          );
        if (value.status === "ok" && value.preview.kind === "text") {
          const bytes = new TextEncoder().encode(value.preview.text).byteLength;
          if (bytes <= textCacheLimit) {
            this.#cache.set(key, { value, bytes });
            this.#bytes += bytes;
            while (this.#bytes > textCacheLimit) this.#forget(this.#cache.keys().next().value!);
          }
        }
        return value;
      } catch (error) {
        this.#assertCurrent(controller, generation);
        if (isUnavailable(error)) {
          this.#forget(key);
          return { status: "unavailable" };
        }
        if (
          (error instanceof OpensteerError && error.code === "unauthorized") ||
          (error instanceof HostClientRequestError && error.status === 401)
        )
          throw error;
        if (isOffline(error)) {
          const cached = this.#cache.get(key);
          if (cached) {
            this.#cache.delete(key);
            this.#cache.set(key, cached);
          }
          return { status: "offline", cached: cached?.value ?? null };
        }
        return { status: "failed" };
      }
    });
  }
  download(
    threadId: string | null,
    resource: FileResource,
    signal?: AbortSignal,
  ): Promise<TranscriptFileDownload> {
    const input = {
      threadId: threadId === null ? null : ThreadIdSchema.parse(threadId),
      resource: FileResourceSchema.parse(resource),
    };
    const key = JSON.stringify([input.threadId, input.resource]);
    return this.#share(this.#downloads, key, signal, async (controller, generation) => {
      try {
        const content = TranscriptFileContentSchema.parse(
          await this.#ports.readFile(input, controller.signal),
        );
        this.#assertCurrent(controller, generation);
        return { status: "ok", ...content };
      } catch (error) {
        this.#assertCurrent(controller, generation);
        if (
          (error instanceof OpensteerError && error.code === "unauthorized") ||
          (error instanceof HostClientRequestError && error.status === 401)
        )
          throw error;
        if (isUnavailable(error)) {
          for (const [key, cached] of this.#cache)
            if (JSON.stringify(cached.value.resource) === JSON.stringify(input.resource))
              this.#forget(key);
          return { status: "unavailable" };
        }
        return { status: isOffline(error) ? "offline" : "failed" };
      }
    });
  }
  #assertCurrent(controller: AbortController, generation: number) {
    if (this.#disposed || controller.signal.aborted || generation !== this.#generation)
      throw cancelled();
  }
  #share<T>(
    map: Map<string, Operation<T>>,
    key: string,
    signal: AbortSignal | undefined,
    work: (controller: AbortController, generation: number) => Promise<T>,
  ): Promise<T> {
    if (this.#disposed || signal?.aborted) return Promise.reject(cancelled());
    let operation = map.get(key);
    if (!operation) {
      const controller = new AbortController();
      const generation = this.#generation;
      operation = {
        controller,
        users: 0,
        promise: Promise.resolve().then(() => {
          this.#assertCurrent(controller, generation);
          return work(controller, generation);
        }),
      };
      map.set(key, operation);
      const own = operation;
      const finish = () => {
        if (map.get(key) === own) map.delete(key);
      };
      void operation.promise.then(finish, finish);
    }
    const own = operation;
    own.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener("abort", abort);
        own.controller.signal.removeEventListener("abort", abort);
        if (--own.users === 0) {
          if (map.get(key) === own) map.delete(key);
          own.controller.abort();
        }
        return true;
      };
      const abort = () => {
        if (finish()) reject(cancelled());
      };
      signal?.addEventListener("abort", abort, { once: true });
      own.controller.signal.addEventListener("abort", abort, { once: true });
      void own.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  }
  #forget(key: string) {
    const cached = this.#cache.get(key);
    if (cached) this.#bytes -= cached.bytes;
    this.#cache.delete(key);
  }
  reset() {
    this.#generation++;
    for (const operation of [...this.#opens.values(), ...this.#downloads.values()])
      operation.controller.abort();
    this.#opens.clear();
    this.#downloads.clear();
    this.#cache.clear();
    this.#bytes = 0;
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ownerSignal?.removeEventListener("abort", this.#retire);
    this.reset();
  }
}
