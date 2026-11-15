import { TextDecoder } from "node:util";
import {
  rpcSuccess,
  TranscriptFileContentSchema,
  TranscriptFileOpenSchema,
  transcriptFileContentMaxBytes,
  transcriptFilePreviewMaxBytes,
  type HostApiServerContext,
  type TranscriptFileOpenInput,
  type TranscriptFileOpen,
  type TranscriptFileContentInput,
} from "@opensteer/protocol";
import { OpensteerError } from "@opensteer/core";
import { requireSession } from "../integrations/integration-rpc-context.js";
import { AssetService } from "../assets/asset-service.js";
import { TranscriptFileAccess, type FileActor } from "./transcript-file-access.js";
import { fileUnavailable } from "./rooted-file-reader.js";

export class TranscriptFiles {
  readonly access: TranscriptFileAccess;
  readonly assets: AssetService;
  constructor(access: TranscriptFileAccess, assets: AssetService) {
    this.access = access;
    this.assets = assets;
  }
  async open(
    input: TranscriptFileOpenInput,
    actor: FileActor,
    signal?: AbortSignal,
  ): Promise<TranscriptFileOpen> {
    try {
      const context = { userId: actor.userId, threadId: input.threadId };
      const f = await this.access.resolve(input.source, context, signal);
      if (!f) return { status: "unavailable" };
      if (f.mediaType.startsWith("image/") && f.mediaType !== "image/svg+xml") {
        const image = await this.assets.urlForResource(f, "preview", actor, input.threadId, signal);
        return TranscriptFileOpenSchema.parse({
          status: "ok",
          ...f,
          preview: image.status === "ok" ? { kind: "image", image } : { kind: "download" },
        });
      }
      const { bytes, metadata } = await this.access.read(
        f.resource,
        context,
        { maxBytes: transcriptFilePreviewMaxBytes },
        signal,
      );
      let preview: { kind: "download" } | { kind: "text"; text: string; truncated: boolean } = {
        kind: "download",
      };
      if (!bytes.includes(0) && !bytes.some((b) => b < 32 && ![9, 10, 12, 13].includes(b))) {
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const text = decoder.decode(bytes, { stream: metadata.truncated });
          preview = { kind: "text", text, truncated: metadata.truncated };
        } catch {
          /* Binary and invalid UTF-8 are download-only. */
        }
      }
      return TranscriptFileOpenSchema.parse({ status: "ok", ...f, preview });
    } catch (e) {
      signal?.throwIfAborted();
      if (e instanceof OpensteerError && e.code === "not_found") return { status: "unavailable" };
      throw e;
    }
  }
  async content(input: TranscriptFileContentInput, actor: FileActor, signal?: AbortSignal) {
    const result = await this.access.read(
      input.resource,
      { userId: actor.userId, threadId: input.threadId },
      { maxBytes: transcriptFileContentMaxBytes, full: true },
      signal,
    );
    if (result.metadata.truncated) throw fileUnavailable();
    return TranscriptFileContentSchema.parse({
      bytes: result.bytes,
      metadata: { ...result.metadata, truncated: false },
    });
  }
}
export function createTranscriptFileHandlers(files: TranscriptFiles | undefined) {
  return {
    "file.open": async (input: TranscriptFileOpenInput, context: HostApiServerContext) => {
      const s = requireSession(context);
      if (!files) throw fileUnavailable();
      return rpcSuccess(
        await files.open(input, { userId: s.user.id, sessionId: s.id }, context.signal),
      );
    },
    "file.content": async (input: TranscriptFileContentInput, context: HostApiServerContext) => {
      const s = requireSession(context);
      if (!files) throw fileUnavailable();
      return rpcSuccess(
        await files.content(input, { userId: s.user.id, sessionId: s.id }, context.signal),
      );
    },
  };
}
export function createTranscriptFileServices(
  options: ConstructorParameters<typeof AssetService>[0],
) {
  const assets = new AssetService(options);
  const files = new TranscriptFiles(options.access, assets);
  return {
    access: options.access,
    assets,
    files,
    close: () => {
      options.access.close();
      options.access.options.home.close();
    },
  };
}
