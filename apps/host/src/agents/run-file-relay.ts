import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { OpensteerError } from "@opensteer/core";
import { runFileMaxBytes, type RunFileTransfer } from "@opensteer/protocol";

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

  open(): RunFileRelayHandle {
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
      downloadToken: Buffer.from(downloadToken, "utf8"),
      downloaded: false,
      finish: (failure) => (failure ? fail(failure) : settle()),
      finished,
      provide,
      refuse,
      source,
      uploadToken: Buffer.from(uploadToken, "utf8"),
      uploaded: false,
    };
    this.#open.set(id, transfer);
    return {
      close: (failure) => {
        if (!this.#open.delete(id)) return;
        const reason = failure ?? closed();
        transfer.refuse(reason);
        transfer.finish(reason);
        void transfer.source.then(
          ({ stream }) => stream.destroy(),
          () => undefined,
        );
      },
      download: { id, token: downloadToken },
      upload: { id, token: uploadToken },
    };
  }

  /** Resolves when the receiver has every byte; rejects if it never will. */
  async upload(id: string, token: string, file: RelayedRunFile): Promise<void> {
    const transfer = this.#open.get(id);
    if (!transfer || transfer.uploaded || !matches(transfer.uploadToken, token))
      throw refusedTransfer();
    if (file.sizeBytes > runFileMaxBytes)
      throw new OpensteerError({ code: "bad_request", message: "This file is too large to send." });
    transfer.uploaded = true;
    transfer.provide(file);
    await transfer.finished;
  }

  /** Waits for the upload. The caller must report the end through `settled`. */
  async download(
    id: string,
    token: string,
  ): Promise<RelayedRunFile & { readonly settled: (failure?: Error) => void }> {
    const transfer = this.#open.get(id);
    if (!transfer || transfer.downloaded || !matches(transfer.downloadToken, token))
      throw refusedTransfer();
    transfer.downloaded = true;
    return { ...(await transfer.source), settled: transfer.finish };
  }
}
