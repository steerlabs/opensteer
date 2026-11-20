import { Readable } from "node:stream";
import { OpensteerError, appMaxBytes, type ComputerFolder } from "@opensteer/core";
import {
  FolderDirectoryPageSchema,
  FolderFileKeySchema,
  encodeHomeFileExportBundle,
  folderFilePreviewMaxBytes,
  homeFilesExportMaxBytes,
  homeFilesMaxBytes,
  type FolderDirectoryPage,
  type RunnerHomeFileResult,
} from "@opensteer/protocol";
import { localFilesMaximumDirectoryOffset } from "@opensteer/shared/files/models";
import { z } from "zod";
import {
  RootedFileReader,
  fileTooLarge,
  rootedFileKey,
  rootedFileSegments,
  type HomeFilesTransport,
} from "./rooted-file-reader.js";

const cursorSchema = z.strictObject({
  revision: z.string().length(43),
  offset: z.number().int().min(0).max(localFilesMaximumDirectoryOffset),
  scope: z.string().length(43),
  parentKey: FolderFileKeySchema,
});
const badKey = () =>
  new OpensteerError({ code: "bad_request", message: "Invalid folder file key" });
export function folderFileSegments(key: string): string[] {
  const encoded = FolderFileKeySchema.parse(key);
  try {
    return encoded === "" ? [] : rootedFileSegments(encoded);
  } catch {
    throw badKey();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new OpensteerError({ code: "folder_unavailable", message: "Agent home file request failed" });
}

function mapHomeFileError(result: RunnerHomeFileResult, maxBytes?: number): OpensteerError {
  const message = result.message ?? "Agent home file operation failed";
  switch (result.errorCode) {
    case "not_found":
      return new OpensteerError({ code: "not_found", message });
    case "bad_request":
      return new OpensteerError({ code: "bad_request", message });
    case "file_too_large":
      return maxBytes !== undefined
        ? fileTooLarge(result.sizeBytes ?? maxBytes + 1, maxBytes)
        : new OpensteerError({
            code: "resource_exhausted",
            reason: "file-too-large",
            message,
          });
    case "revision_mismatch":
      return new OpensteerError({ code: "conflict", reason: "revision-mismatch", message });
    case "conflict":
      return new OpensteerError({ code: "conflict", message });
    default:
      return new OpensteerError({ code: "folder_unavailable", message });
  }
}

/** Proxies Agent home file operations to the hosting Runner over the authenticated channel. */
export class AgentHomeFiles {
  readonly #reader: RootedFileReader;
  readonly #lifetime = new AbortController();
  readonly options: {
    readonly agentHome: () => Promise<ComputerFolder>;
    readonly transport: HomeFilesTransport;
  };
  constructor(options: AgentHomeFiles["options"]) {
    this.options = options;
    this.#reader = new RootedFileReader({
      computerId: async () => (await options.agentHome()).computerId,
      transport: options.transport,
    });
  }

  async list(
    input: { parentKey: string; limit: number; cursor?: string },
    signal = AbortSignal.timeout(15000),
  ): Promise<FolderDirectoryPage> {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.throwIfAborted();
    const home = await this.options.agentHome();
    const segments = folderFileSegments(input.parentKey);
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (input.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
      } catch {
        throw badKey();
      }
      if (cursor.parentKey !== input.parentKey) throw badKey();
    }
    const result = await this.options.transport.requestHomeFile(
      home.computerId,
      {
        ...(cursor
          ? { expectedDirectoryRevision: cursor.revision, expectedRootScope: cursor.scope }
          : {}),
        limit: input.limit,
        offset: cursor?.offset ?? 0,
        pathSegmentsBase64: segments,
        type: "host.home-files.list",
      },
      signal,
    );
    if (!result.ok || result.data?.kind !== "list") throw mapHomeFileError(result);
    const listing = result.data.listing;
    return FolderDirectoryPageSchema.parse({
      parentKey: input.parentKey,
      revision: listing.directoryRevision,
      cursor: listing.hasMore
        ? Buffer.from(
            JSON.stringify({
              scope: result.data.rootScope,
              parentKey: input.parentKey,
              revision: listing.directoryRevision,
              offset: listing.nextOffset,
            }),
          ).toString("base64url")
        : null,
      entries: listing.entries.map(({ displayName, nameBase64, ...entry }) => ({
        ...entry,
        name: displayName,
        key: rootedFileKey([...segments, nameBase64]),
      })),
    });
  }

  async preview(key: string, signal = AbortSignal.timeout(15000)) {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.throwIfAborted();
    const home = await this.options.agentHome();
    const result = await this.options.transport.requestHomeFile(
      home.computerId,
      {
        maxBytes: folderFilePreviewMaxBytes,
        offset: 0,
        pathSegmentsBase64: folderFileSegments(key),
        type: "host.home-files.read",
      },
      signal,
    );
    if (!result.ok || result.data?.kind !== "read")
      throw mapHomeFileError(result, folderFilePreviewMaxBytes);
    const bytes = Buffer.from(result.data.contentBase64, "base64");
    if (
      bytes.byteLength !== result.data.bytesRead ||
      bytes.toString("base64") !== result.data.contentBase64
    )
      throw new OpensteerError({
        code: "folder_unavailable",
        message: "The hosting computer returned an invalid file preview",
      });
    return {
      bytes,
      metadata: {
        contentType: "application/octet-stream",
        etag: `"${result.data.metadata.revision}"`,
        modifiedAt: result.data.metadata.modifiedAt,
        sizeBytes: result.data.metadata.sizeBytes,
        truncated: !result.data.eof,
      },
    };
  }

  async download(
    key: string,
    signal = AbortSignal.timeout(60000),
    purpose?: "app-html",
  ): Promise<Response> {
    const operation = new AbortController();
    signal = AbortSignal.any([signal, this.#lifetime.signal, operation.signal]);
    signal.throwIfAborted();
    const home = await this.options.agentHome();
    signal.throwIfAborted();
    const segments = folderFileSegments(key);
    const { relay, requestHomeFile } = this.options.transport;
    const maxBytes = purpose === "app-html" ? appMaxBytes : homeFilesMaxBytes;
    const transfer = relay.open(maxBytes);
    const onAbort = () =>
      transfer.close(
        signal.reason instanceof Error ? signal.reason : new Error("File download was aborted"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const sending = requestHomeFile(
      home.computerId,
      {
        pathSegmentsBase64: segments,
        ...(purpose ? { purpose } : {}),
        transfer: transfer.upload,
        type: "host.home-files.download",
      },
      signal,
    ).then((result) => {
      if (!result.ok || result.data?.kind !== "download") throw mapHomeFileError(result, maxBytes);
      return result.data;
    });
    void sending.catch((error) => transfer.close(asError(error)));
    let incoming: Awaited<ReturnType<typeof relay.download>>;
    try {
      incoming = await relay.download(transfer.download.id, transfer.download.token, signal);
    } catch (error) {
      transfer.close(asError(error));
      signal.removeEventListener("abort", onAbort);
      await sending.catch(() => undefined);
      throw error;
    }
    const iterator = incoming.stream[Symbol.asyncIterator]();
    let size = 0;
    let finalized = false;
    const cleanup = (failure?: Error) => {
      if (finalized) return;
      finalized = true;
      incoming.settled(failure);
      transfer.close(failure);
      signal.removeEventListener("abort", onAbort);
      if (failure) operation.abort(failure);
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const next = await iterator.next();
          if (next.done) {
            if (size !== incoming.sizeBytes) throw new Error("File transfer size changed");
            incoming.settled();
            if ((await sending).length !== size) throw new Error("File transfer size changed");
            cleanup();
            controller.close();
            return;
          }
          const chunk = next.value;
          const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > incoming.sizeBytes)
            throw new Error("File transfer exceeded its declared size");
          controller.enqueue(bytes);
        } catch (error) {
          const failure = asError(error);
          cleanup(failure);
          await sending.catch(() => undefined);
          controller.error(failure);
        }
      },
      async cancel(reason) {
        const failure = reason instanceof Error ? reason : new Error("File download cancelled");
        cleanup(failure);
        await iterator.return?.().catch(() => undefined);
        await sending.catch(() => undefined);
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(incoming.sizeBytes),
      },
    });
  }

  async writeDirectory(
    input: {
      readonly directory: string;
      readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
      readonly maxBytes?: number;
    },
    signal = AbortSignal.timeout(60000),
  ): Promise<void> {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    signal.throwIfAborted();
    const maxBytes = input.maxBytes ?? homeFilesExportMaxBytes;
    const bundle = encodeHomeFileExportBundle({
      directory: input.directory,
      files: input.files,
      maxBytes,
    });
    const home = await this.options.agentHome();
    signal.throwIfAborted();
    const { relay, requestHomeFile } = this.options.transport;
    const transfer = relay.open();
    const onAbort = () =>
      transfer.close(
        signal.reason instanceof Error ? signal.reason : new Error("File export was aborted"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const uploading = relay.upload(transfer.upload.id, transfer.upload.token, {
      name: "plugin-export.bin",
      sizeBytes: bundle.byteLength,
      stream: Readable.from([bundle]),
    });
    void uploading.catch((error) => transfer.close(asError(error)));
    try {
      const result = await requestHomeFile(
        home.computerId,
        {
          directory: input.directory,
          maxBytes,
          transfer: transfer.download,
          type: "host.home-files.write",
        },
        signal,
      );
      if (!result.ok || result.data?.kind !== "write") throw mapHomeFileError(result, maxBytes);
      await uploading;
    } finally {
      transfer.close();
      signal.removeEventListener("abort", onAbort);
      await uploading.catch(() => undefined);
    }
  }

  resolveAbsolutePath(...args: Parameters<RootedFileReader["resolveAbsolutePath"]>) {
    return this.#reader.resolveAbsolutePath(...args);
  }
  resolvePath(...args: Parameters<RootedFileReader["resolvePath"]>) {
    return this.#reader.resolvePath(...args);
  }
  read(...args: Parameters<RootedFileReader["read"]>) {
    return this.#reader.read(...args);
  }
  readContent(...args: Parameters<RootedFileReader["readContent"]>) {
    return this.#reader.readContent(...args);
  }
  close() {
    this.#reader.close();
    this.#lifetime.abort(new Error("Host file service closed"));
  }
}
