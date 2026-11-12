import {
  TeamAgentRequestIdSchema,
  type TeamAgentRequestId,
  type TeamLinkId,
  type TeamSource,
} from "@opensteer/core";
import {
  teamPreviewMaxBytes,
  teamUploadMaxBytes,
  TeamBinaryDownloadHeadersSchema,
  TeamBinaryUploadHeadersSchema,
  TeamBinaryUploadMetadataSchema,
  TeamFileResultSchema,
} from "@opensteer/protocol";
import { Transform, type Readable } from "node:stream";
import { createHash } from "node:crypto";
import { TeamLinkEndpoint } from "./endpoint.js";
import { checkTeamVersion, linkError, type TeamMachineFilesPort } from "./contracts.js";
import type { TeamAccessResolver } from "../team/access-port.js";
import { auditTeamMachineCall } from "./audit.js";
import { teamUploadParts } from "./multipart.js";

export function boundedTeamStream(
  source: Readable,
  maxBytes: number,
  signal: AbortSignal,
  expected?: { readonly size: number; readonly sha256?: string },
): Readable {
  signal.throwIfAborted();
  let size = 0;
  const hash = createHash("sha256");
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes || (expected && size > expected.size))
        callback(linkError("resource_exhausted"));
      else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
    flush(callback) {
      if (
        expected &&
        (size !== expected.size ||
          (expected.sha256 !== undefined && hash.digest("hex") !== expected.sha256))
      )
        callback(linkError("bad_request"));
      else callback();
    },
  });
  const cancel = () => {
    source.destroy(linkError());
    bounded.destroy(linkError());
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  source.on("error", () => bounded.destroy(linkError()));
  bounded.on("error", () => source.destroy());
  bounded.once("close", () => {
    signal.removeEventListener("abort", cancel);
    source.destroy();
  });
  source.pipe(bounded);
  return bounded;
}

export class TeamLinkBinary {
  readonly endpoint: TeamLinkEndpoint;
  readonly files: TeamMachineFilesPort;
  readonly resolver: TeamAccessResolver;
  constructor(
    endpoint: TeamLinkEndpoint,
    files: TeamMachineFilesPort,
    resolver: TeamAccessResolver,
  ) {
    this.endpoint = endpoint;
    this.files = files;
    this.resolver = resolver;
  }

  async #authority(headers: Readonly<Record<string, unknown>>, action: "read" | "post") {
    checkTeamVersion(headers["x-opensteer-team-api-version"]);
    if (typeof headers.authorization !== "string" || !headers.authorization.startsWith("Bearer "))
      throw linkError("unauthorized");
    const link = await this.endpoint.options.links.authenticate(headers.authorization.slice(7));
    const requestId = TeamAgentRequestIdSchema.parse(headers["x-opensteer-team-request-id"]);
    let request;
    try {
      request = await this.endpoint.options.requests.authorize(link.id, requestId, action);
    } catch (error) {
      await auditTeamMachineCall(this.endpoint.options.links.database, {
        linkId: link.id,
        requestId,
        action: `file.${action}`,
        outcome: "denied",
      });
      throw error;
    }
    return {
      link,
      request,
      requestId,
      actor: { kind: "agent" as const, userId: link.ownerUserId },
    };
  }

  async #channel(
    source: TeamSource,
    userId: Parameters<TeamAccessResolver["channel"]>[1]["userId"],
  ) {
    return this.endpoint.options.links.database.transaction().execute(async (tx) => {
      const rights = await this.resolver.channel(tx, { kind: "agent", userId }, source.channelId);
      if (!rights.read || rights.peopleOnly) throw linkError();
      return true;
    });
  }

  async #audit(
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
    action: string,
    source: TeamSource,
    outcome: "allowed" | "denied",
  ): Promise<void> {
    await auditTeamMachineCall(this.endpoint.options.links.database, {
      linkId,
      requestId,
      action,
      outcome,
      channelId: source.channelId,
    });
  }

  async download(raw: Readonly<Record<string, unknown>>, signal: AbortSignal) {
    checkTeamVersion(raw["x-opensteer-team-api-version"]);
    const { link, request, requestId, actor } = await this.#authority(raw, "read");
    const headers = TeamBinaryDownloadHeadersSchema.parse(raw);
    const revision = this.endpoint.options.access.revision;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let unregister = this.endpoint.options.lifetimes.register({
      linkId: link.id,
      userId: link.ownerUserId,
      requestId,
      channelIds: [request.channelId],
      cancel: () => controller.abort(),
    });
    try {
      const result = await this.files.open({
        actor,
        linkId: link.id,
        requestId,
        blobId: headers["x-opensteer-team-blob-id"],
        part: headers["x-opensteer-team-file-part"],
        signal: combined,
      });
      const metadata = TeamFileResultSchema.parse({ file: result.file, source: result.source });
      if (
        metadata.file.channelId !== metadata.source.channelId ||
        metadata.file.id !== headers["x-opensteer-team-blob-id"]
      )
        throw linkError();
      await this.#channel(metadata.source, link.ownerUserId);
      unregister();
      unregister = this.endpoint.options.lifetimes.register({
        linkId: link.id,
        userId: link.ownerUserId,
        requestId,
        channelIds: [request.channelId, metadata.source.channelId],
        cancel: () => controller.abort(),
      });
      combined.throwIfAborted();
      await this.#audit(link.id, requestId, "file.read", metadata.source, "allowed");
      const preview = headers["x-opensteer-team-file-part"] === "preview";
      const size = preview ? metadata.file.preview?.sizeBytes : metadata.file.sizeBytes;
      if (size === undefined) throw linkError("bad_request");
      const bytes = boundedTeamStream(
        result.bytes,
        preview ? teamPreviewMaxBytes : teamUploadMaxBytes,
        combined,
        { size, ...(preview ? {} : { sha256: metadata.file.sha256 }) },
      );
      bytes.once("close", unregister);
      return await this.endpoint.options.access.handoff(
        revision,
        async () => {
          await this.endpoint.options.requests.authorize(link.id, requestId, "read");
          return this.#channel(metadata.source, link.ownerUserId);
        },
        () => {
          combined.throwIfAborted();
          return {
            ...metadata,
            bytes,
            size,
            mediaType: preview ? metadata.file.preview!.mediaType : metadata.file.mediaType,
          };
        },
      );
    } catch (error) {
      unregister();
      controller.abort();
      await auditTeamMachineCall(this.endpoint.options.links.database, {
        linkId: link.id,
        requestId,
        action: "file.read",
        outcome: "denied",
        channelId: request.channelId,
      });
      throw error;
    }
  }

  async upload(raw: Readonly<Record<string, unknown>>, bytes: Readable, signal: AbortSignal) {
    checkTeamVersion(raw["x-opensteer-team-api-version"]);
    const { link, request, requestId, actor } = await this.#authority(raw, "post");
    const headers = TeamBinaryUploadHeadersSchema.parse(raw);
    const revision = this.endpoint.options.access.revision;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const unregister = this.endpoint.options.lifetimes.register({
      linkId: link.id,
      userId: link.ownerUserId,
      requestId,
      channelIds: [request.channelId],
      cancel: () => controller.abort(),
    });
    try {
      const metadata = TeamBinaryUploadMetadataSchema.parse(
        JSON.parse(headers["x-opensteer-team-upload"]),
      );
      const bounded = boundedTeamStream(
        bytes,
        metadata.sizeBytes + metadata.previewSizeBytes + 16 * 1024,
        combined,
      );
      const upload = teamUploadParts(bounded, headers["content-type"], metadata, combined);
      const result = TeamFileResultSchema.parse(
        await this.files.upload({
          actor,
          linkId: link.id,
          requestId,
          metadata,
          parts: upload.parts,
          signal: combined,
        }),
      );
      if (!upload.complete) throw linkError("bad_request");
      combined.throwIfAborted();
      if (
        result.file.channelId !== request.channelId ||
        result.source.channelId !== request.channelId ||
        result.source.threadRootId !== request.threadRootId ||
        result.file.sizeBytes !== metadata.sizeBytes ||
        result.file.sha256 !== metadata.sha256
      )
        throw linkError();
      await this.#audit(link.id, requestId, "file.upload", result.source, "allowed");
      return await this.endpoint.options.access.handoff(
        revision,
        async () => {
          await this.endpoint.options.requests.authorize(link.id, requestId, "post");
          return true;
        },
        () => {
          combined.throwIfAborted();
          return result;
        },
      );
    } catch (error) {
      await auditTeamMachineCall(this.endpoint.options.links.database, {
        linkId: link.id,
        requestId,
        action: "file.upload",
        outcome: "denied",
        channelId: request.channelId,
      });
      throw error;
    } finally {
      controller.abort();
      unregister();
    }
  }
}
