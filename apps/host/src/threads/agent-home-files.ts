import { localFilesMaximumDirectoryOffset } from "@opensteer/shared/files/models";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { OpensteerError, type ComputerFolder } from "@opensteer/core";
import {
  FolderDirectoryPageSchema,
  FolderFileKeySchema,
  folderFilePreviewMaxBytes,
  type FolderDirectoryPage,
} from "@opensteer/protocol";
import { NativeFsHelper } from "@opensteer/shared/files/native-fs-helper";
import { z } from "zod";
import { RootedFileReader, rootedFileKey, rootedFileSegments } from "./rooted-file-reader.js";

const cursorSchema = z.strictObject({
  revision: z.string().length(43),
  offset: z.number().int().min(0).max(localFilesMaximumDirectoryOffset),
  scope: z.string().length(43),
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
/** Reads Agent home through the native helper's no-follow, root-pinned file operations. */
export class AgentHomeFiles {
  readonly #reader: RootedFileReader;
  readonly #lifetime = new AbortController();
  readonly options: {
    readonly agentHome: () => Promise<ComputerFolder>;
    readonly helperPath: string | undefined;
  };
  constructor(options: AgentHomeFiles["options"]) {
    this.options = options;
    this.#reader = new RootedFileReader({
      root: async () => (await options.agentHome()).path,
      helperPath: options.helperPath,
    });
  }
  async #root(signal: AbortSignal) {
    const { path } = await this.options.agentHome();
    if (!this.options.helperPath)
      throw new OpensteerError({
        code: "folder_unavailable",
        message: "The hosting computer's file helper is unavailable",
      });
    const helper = new NativeFsHelper({
      binary: this.options.helperPath,
      rootPolicy: "managed-local",
    });
    const identity = await helper.directoryIdentity({ path: ".", root: path }, signal);
    return { helper, root: path, expectedRootIdentity: identity };
  }
  async list(
    input: { parentKey: string; limit: number; cursor?: string },
    signal = AbortSignal.timeout(15000),
  ): Promise<FolderDirectoryPage> {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    const { helper, ...root } = await this.#root(signal);
    const segments = folderFileSegments(input.parentKey);
    const scope = createHash("sha256")
      .update(JSON.stringify([root.root, input.parentKey]))
      .digest("base64url");
    const cursor = input.cursor
      ? cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")))
      : undefined;
    if (cursor && cursor.scope !== scope) throw badKey();
    const result = await helper.filesList(
      {
        ...root,
        pathSegmentsBase64: segments,
        limit: input.limit,
        offset: cursor?.offset ?? 0,
        ...(cursor ? { expectedDirectoryRevision: cursor.revision } : {}),
      },
      signal,
    );
    return FolderDirectoryPageSchema.parse({
      parentKey: input.parentKey,
      revision: result.directoryRevision,
      cursor: result.hasMore
        ? Buffer.from(
            JSON.stringify({
              scope,
              revision: result.directoryRevision,
              offset: result.nextOffset,
            }),
          ).toString("base64url")
        : null,
      entries: result.entries.map(({ displayName, nameBase64, ...entry }) => ({
        ...entry,
        name: displayName,
        key: rootedFileKey([...segments, nameBase64]),
      })),
    });
  }
  async preview(key: string, signal = AbortSignal.timeout(15000)) {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    const { helper, ...root } = await this.#root(signal);
    const result = await helper.filesReadRange(
      {
        ...root,
        pathSegmentsBase64: folderFileSegments(key),
        offset: 0,
        maxBytes: folderFilePreviewMaxBytes,
      },
      signal,
    );
    return {
      bytes: result.bytes,
      metadata: {
        contentType: "application/octet-stream",
        etag: `"${result.metadata.revision}"`,
        modifiedAt: result.metadata.modifiedAt,
        sizeBytes: result.metadata.sizeBytes,
        truncated: !result.eof,
      },
    };
  }
  async download(key: string, signal = AbortSignal.timeout(60000)): Promise<Response> {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    const { helper, ...root } = await this.#root(signal);
    const result = await helper.filesDownload(
      { ...root, pathSegmentsBase64: folderFileSegments(key), offset: 0, length: 0 },
      signal,
    );
    return new Response(Readable.toWeb(result.stream) as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(result.length),
        etag: `"${result.metadata.revision}"`,
      },
    });
  }
  resolveAbsolutePath(...args: Parameters<RootedFileReader["resolveAbsolutePath"]>) {
    return this.#reader.resolveAbsolutePath(...args);
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
