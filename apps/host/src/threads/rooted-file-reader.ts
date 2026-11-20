import { OpensteerError, type RunnerId } from "@opensteer/core";
import type { RunnerRegistry } from "@opensteer/orchestration";
import type { HomeFileRootKind, RunnerHomeFileResult } from "@opensteer/protocol";
import type { RunFileRelay } from "../agents/run-file-relay.js";

export interface HomeFilesTransport {
  readonly requestHomeFile: RunnerRegistry["requestHomeFile"];
  readonly relay: RunFileRelay;
}

export function fileUnavailable() {
  return new OpensteerError({ code: "not_found", message: "File unavailable" });
}
export function fileTooLarge(sizeBytes: number, maxBytes: number) {
  return new OpensteerError({
    code: "resource_exhausted",
    reason: "file-too-large",
    message: `File is ${sizeBytes} bytes; too large to download here (limit ${maxBytes} bytes)`,
    details: { sizeBytes, maxBytes },
  });
}
export function rootedFileKey(segments: readonly string[]) {
  return Buffer.concat(
    segments.flatMap((s, i) => [...(i ? [Buffer.from([0])] : []), Buffer.from(s, "base64url")]),
  ).toString("base64url");
}
export function rootedFileSegments(key: string): string[] {
  if (!key || key.length > 16384 || !/^[\w-]+$/u.test(key)) throw fileUnavailable();
  const raw = Buffer.from(key, "base64url");
  if (raw.toString("base64url") !== key) throw fileUnavailable();
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++)
    if (i === raw.length || raw[i] === 0) {
      parts.push(raw.subarray(start, i));
      start = i + 1;
    }
  if (
    parts.some(
      (p) =>
        !p.length ||
        p.equals(Buffer.from(".")) ||
        p.equals(Buffer.from("..")) ||
        p.includes(47) ||
        p.includes(92),
    )
  )
    throw fileUnavailable();
  return parts.map((p) => p.toString("base64url"));
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : fileUnavailable();
}

function mapReaderError(result: RunnerHomeFileResult, maxBytes?: number): OpensteerError {
  if (result.errorCode === "file_too_large" && maxBytes !== undefined) {
    return fileTooLarge(result.sizeBytes ?? maxBytes + 1, maxBytes);
  }
  return fileUnavailable();
}

function parseScopedRevision(expectedRevision: string): {
  readonly rootScope: string;
  readonly fileRevision: string;
} {
  if (!/^[\w-]{43}\.[\w-]{43}$/u.test(expectedRevision)) throw fileUnavailable();
  return {
    rootScope: expectedRevision.slice(0, 43),
    fileRevision: expectedRevision.slice(44),
  };
}

/** Proxies rooted reads to the owning Runner; revisions bind the Runner's root identity and file. */
export class RootedFileReader {
  readonly #lifetime = new AbortController();
  readonly options: {
    readonly computerId: () => Promise<RunnerId>;
    readonly transport: HomeFilesTransport;
    readonly root?: HomeFileRootKind;
  };
  constructor(options: RootedFileReader["options"]) {
    this.options = options;
  }

  async resolveAbsolutePath(absolutePath: string, signal = AbortSignal.timeout(15000)) {
    return this.resolvePath(absolutePath, {}, signal);
  }

  async resolvePath(
    rawPath: string,
    options: { readonly allowRelative?: boolean; readonly allowTilde?: boolean } = {},
    signal = AbortSignal.timeout(15000),
  ) {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.throwIfAborted();
    if (!rawPath || rawPath.length > 4_096) throw fileUnavailable();
    const runnerId = await this.options.computerId();
    const result = await this.options.transport.requestHomeFile(
      runnerId,
      {
        ...(options.allowRelative ? { allowRelative: true } : {}),
        ...(options.allowTilde ? { allowTilde: true } : {}),
        path: rawPath,
        type: "host.home-files.resolve",
      },
      signal,
    );
    if (!result.ok || result.data?.kind !== "resolve") throw mapReaderError(result);
    return {
      key: result.data.key,
      revision: `${result.data.rootScope}.${result.data.metadata.revision}`,
      name: result.data.name,
      sizeBytes: result.data.metadata.sizeBytes,
    };
  }

  async read(
    key: string,
    options: {
      readonly maxBytes: number;
      readonly expectedRevision?: string;
      readonly root?: HomeFileRootKind;
    },
    signal = AbortSignal.timeout(15000),
  ) {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 512 * 1024
    )
      throw fileUnavailable();
    const segments = rootedFileSegments(key);
    const expected = options.expectedRevision
      ? parseScopedRevision(options.expectedRevision)
      : undefined;
    const root = options.root ?? this.options.root;
    const runnerId = await this.options.computerId();
    const result = await this.options.transport.requestHomeFile(
      runnerId,
      {
        ...(expected
          ? {
              expectedFileRevision: expected.fileRevision,
              expectedRootScope: expected.rootScope,
            }
          : {}),
        maxBytes: options.maxBytes,
        offset: 0,
        pathSegmentsBase64: segments,
        ...(root ? { root } : {}),
        type: "host.home-files.read",
      },
      signal,
    );
    if (!result.ok || result.data?.kind !== "read") throw mapReaderError(result, options.maxBytes);
    const bytes = Buffer.from(result.data.contentBase64, "base64");
    if (
      bytes.byteLength !== result.data.bytesRead ||
      bytes.toString("base64") !== result.data.contentBase64
    )
      throw fileUnavailable();
    return {
      bytes,
      bytesRead: result.data.bytesRead,
      eof: result.data.eof,
      offset: result.data.offset,
      metadata: {
        ...result.data.metadata,
        revision: `${result.data.rootScope}.${result.data.metadata.revision}`,
      },
    };
  }

  async readContent(
    key: string,
    options: {
      readonly expectedRevision: string;
      readonly maxBytes: number;
      readonly root?: HomeFileRootKind;
    },
    signal = AbortSignal.timeout(60000),
  ) {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.throwIfAborted();
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1 ||
      options.maxBytes > 32 * 1024 * 1024
    )
      throw fileUnavailable();
    const segments = rootedFileSegments(key);
    const expected = parseScopedRevision(options.expectedRevision);
    const root = options.root ?? this.options.root;
    const runnerId = await this.options.computerId();
    const { relay, requestHomeFile } = this.options.transport;
    const transfer = relay.open(options.maxBytes);
    const close = () =>
      transfer.close(
        signal.reason instanceof Error ? signal.reason : new Error("File read was aborted"),
      );
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted) close();
    const sending = requestHomeFile(
      runnerId,
      {
        expectedFileRevision: expected.fileRevision,
        expectedRootScope: expected.rootScope,
        maxBytes: options.maxBytes,
        pathSegmentsBase64: segments,
        ...(root ? { root } : {}),
        transfer: transfer.upload,
        type: "host.home-files.download",
      },
      signal,
    ).then((result) => {
      if (!result.ok || result.data?.kind !== "download") {
        throw mapReaderError(result, options.maxBytes);
      }
      return result.data;
    });
    void sending.catch((error) => transfer.close(asError(error)));
    try {
      const incoming = await relay.download(transfer.download.id, transfer.download.token, signal);
      try {
        if (incoming.sizeBytes > options.maxBytes) {
          throw fileTooLarge(incoming.sizeBytes, options.maxBytes);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming.stream) {
          signal.throwIfAborted();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > options.maxBytes) throw fileTooLarge(size, options.maxBytes);
          chunks.push(bytes);
        }
        if (size !== incoming.sizeBytes) throw fileUnavailable();
        incoming.settled();
        const data = await sending;
        if (size !== data.length) throw fileUnavailable();
        return {
          bytes: Buffer.concat(chunks, size),
          metadata: {
            ...data.metadata,
            revision: `${data.rootScope}.${data.metadata.revision}`,
          },
          eof: true,
        };
      } catch (error) {
        incoming.settled(asError(error));
        incoming.stream.destroy();
        throw error;
      }
    } finally {
      transfer.close();
      signal.removeEventListener("abort", close);
      await sending.catch(() => undefined);
    }
  }

  close() {
    this.#lifetime.abort(new Error("Host file service closed"));
  }
}
