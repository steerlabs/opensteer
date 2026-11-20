import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { OpensteerError } from "@opensteer/core";
import {
  runFileMaxBytes,
  runFileTransferProofPayload,
  type RunFileTransfer,
  type RunFileTransferBinding,
} from "@opensteer/protocol";

export interface RelayedRunFile {
  readonly name: string;
  readonly sizeBytes: number;
  readonly stream: Readable;
}

interface OpenTransfer {
  readonly downloadToken: Buffer;
  readonly uploadToken: Buffer;
  /** Settles the upload's response once the download has taken every byte, or failed. */
  finish(failure?: Error): void;
  readonly finished: Promise<void>;
  readonly maxBytes: number;
  binding?: { readonly scope: RunFileTransferBinding; readonly method: "PUT" | "GET" };
  unlink?: () => void;
  close(failure?: Error): void;
  /** Rejects when the transfer closes before an upload arrives. */
  readonly source: Promise<RelayedRunFile>;
  provide(file: RelayedRunFile): void;
  refuse(failure: Error): void;
  downloaded: boolean;
  uploaded: boolean;
}

export interface RunFileRelayHandle {
  readonly download: RunFileTransfer;
  readonly upload: RunFileTransfer;
  /** Idempotent. Ends the transfer however far it got. */
  close(failure?: Error): void;
}

const closed = () =>
  new OpensteerError({ code: "conflict", message: "This file transfer has ended." });

function refusedTransfer(): OpensteerError {
  return new OpensteerError({ code: "forbidden", message: "This file transfer is not available." });
}

function matches(expected: Buffer, presented: string): boolean {
  const actual = Buffer.from(presented, "utf8");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

/**
 * Streams one file from a Runner to another through the Host, for a tool call
 * whose two ends are on different computers. Runners reach the Host and never
 * each other, so the Host is the one place they can meet.
 *
 * Nothing touches the disk and nothing outlives the call: a transfer exists
 * only between `open` and `close`, each direction has its own one-use token,
 * and the bytes pass through under the receiver's backpressure.
 */
export class RunFileRelay {
  readonly #open = new Map<string, OpenTransfer>();
  readonly #verify:
    | ((scope: RunFileTransferBinding, payload: string, signature: string) => Promise<boolean>)
    | undefined;

  constructor(
    verify?: (
      scope: RunFileTransferBinding,
      payload: string,
      signature: string,
    ) => Promise<boolean>,
  ) {
    this.#verify = verify;
  }

  bind(
    transfer: RunFileTransfer,
    method: "PUT" | "GET",
    scope: RunFileTransferBinding,
    signal: AbortSignal,
  ): void {
    signal.throwIfAborted();
    const entry = this.#open.get(transfer.id);
    if (
      !entry ||
      entry.binding ||
      !matches(method === "PUT" ? entry.uploadToken : entry.downloadToken, transfer.token)
    )
      throw refusedTransfer();
    entry.binding = { method, scope };
    const disconnected = () => entry.close(new Error("Runner file connection ended."));
    signal.addEventListener("abort", disconnected, { once: true });
    entry.unlink = () => signal.removeEventListener("abort", disconnected);
  }

  async #authorizeHttp(
    id: string,
    token: string,
    method: "GET" | "PUT",
    signature: unknown,
  ): Promise<void> {
    const entry = this.#open.get(id);
    if (!entry || !matches(method === "PUT" ? entry.uploadToken : entry.downloadToken, token))
      throw refusedTransfer();
    const bound = entry.binding;
    if (!bound) return;
    if (
      bound.method !== method ||
      typeof signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/u.test(signature) ||
      !(await this.#verify?.(
        bound.scope,
        runFileTransferProofPayload(bound.scope, id, method),
        signature,
      ))
    )
      throw refusedTransfer();
  }

  async uploadHttp(
    id: string,
    token: string,
    file: RelayedRunFile,
    signal: AbortSignal,
    signature: unknown,
  ) {
    await this.#authorizeHttp(id, token, "PUT", signature);
    return this.upload(id, token, file, signal);
  }

  async downloadHttp(id: string, token: string, signal: AbortSignal, signature: unknown) {
    await this.#authorizeHttp(id, token, "GET", signature);
    return this.download(id, token, signal);
  }

  open(maxBytes = runFileMaxBytes): RunFileRelayHandle {
    const id = randomUUID();
    const uploadToken = randomBytes(32).toString("base64url");
    const downloadToken = randomBytes(32).toString("base64url");
    let provide!: (file: RelayedRunFile) => void;
    let refuse!: (failure: Error) => void;
    const source = new Promise<RelayedRunFile>((resolve, reject) => {
      provide = resolve;
      refuse = reject;
    });
    // Nothing may be left unhandled when a transfer closes before either side came.
    source.catch(() => undefined);
    let settle!: () => void;
    let fail!: (failure: Error) => void;
    const finished = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    finished.catch(() => undefined);
    const transfer: OpenTransfer = {
      close: (failure) => {
        if (!this.#open.delete(id)) return;
        transfer.unlink?.();
        const reason = failure ?? closed();
        transfer.refuse(reason);
        transfer.finish(reason);
        void transfer.source.then(
          ({ stream }) => stream.destroy(),
          () => undefined,
        );
      },
      downloadToken: Buffer.from(downloadToken, "utf8"),
      downloaded: false,
      finish: (failure) => (failure ? fail(failure) : settle()),
      finished,
      maxBytes,
      provide,
      refuse,
      source,
      uploadToken: Buffer.from(uploadToken, "utf8"),
      uploaded: false,
    };
    this.#open.set(id, transfer);
    return {
      close: transfer.close,
      download: { id, token: downloadToken },
      upload: { id, token: uploadToken },
    };
  }

  /** Resolves when the receiver has every byte; rejects if it never will. */
  async upload(
    id: string,
    token: string,
    file: RelayedRunFile,
    signal?: AbortSignal,
  ): Promise<void> {
    const transfer = this.#open.get(id);
    if (!transfer || transfer.uploaded || !matches(transfer.uploadToken, token))
      throw refusedTransfer();
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > transfer.maxBytes
    )
      throw new OpensteerError({ code: "bad_request", message: "This file is too large to send." });
    transfer.uploaded = true;
    const onError = (error: Error) => transfer.close(error);
    const onClose = () => {
      if (!file.stream.readableEnded) onError(new Error("The upload stopped."));
    };
    const onAbort = () => transfer.close(new Error("The upload stopped."));
    signal?.addEventListener("abort", onAbort, { once: true });
    file.stream.once("error", onError);
    file.stream.once("close", onClose);
    transfer.provide(file);
    if (signal?.aborted) onAbort();
    else if (file.stream.destroyed) onClose();
    try {
      await transfer.finished;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      file.stream.off("error", onError);
      file.stream.off("close", onClose);
    }
  }

  /** Waits for the upload. The caller must report the end through `settled`. */
  async download(
    id: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<RelayedRunFile & { readonly settled: (failure?: Error) => void }> {
    const transfer = this.#open.get(id);
    if (!transfer || transfer.downloaded || !matches(transfer.downloadToken, token))
      throw refusedTransfer();
    transfer.downloaded = true;
    try {
      const file = signal ? await raceAbort(transfer.source, signal) : await transfer.source;
      return {
        ...file,
        settled: (failure) => (failure ? transfer.close(failure) : transfer.finish()),
      };
    } catch (error) {
      if (signal?.aborted) transfer.close(error instanceof Error ? error : undefined);
      throw error;
    }
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("File transfer was aborted"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("File transfer was aborted"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
