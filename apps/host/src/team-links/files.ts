import {
  type ArtifactContentPart,
  type RunId,
  type DeploymentId,
  type TeamChannelId,
  type TeamBlobId,
  type TeamSource,
} from "@opensteer/core";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import {
  TeamFileResultSchema,
  TeamBinaryUploadMetadataSchema,
  teamPreviewMaxBytes,
  teamUploadMaxBytes,
  teamBinaryRoutes,
  type TeamFileSchema,
} from "@opensteer/protocol";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, join, win32 } from "node:path";
import sharp from "sharp";
import type { z } from "zod";
import { boundedTeamStream } from "../team-link-endpoint/binary.js";
import { linkError } from "../team-link-endpoint/contracts.js";
import { PersonalTeamVault } from "./vault.js";
import type { TeamToolRun } from "../mcp/team-tool-port.js";
import { teamOperationId } from "./operation-id.js";
import { TeamLinkNetwork } from "./network.js";

export interface PersonalTeamAttachmentPort {
  admitPath(runId: RunId, path: string, signal: AbortSignal): Promise<ArtifactContentPart>;
  /** Uses the existing private attachment store/cache, bound to this Run. No network credentials enter it. */
  import(input: {
    readonly runId: RunId;
    readonly file: z.infer<typeof TeamFileSchema>;
    readonly source: TeamSource;
    readonly bytes: Readable;
    readonly signal: AbortSignal;
  }): Promise<{ readonly path: string; readonly attachment: ArtifactContentPart }>;
  export(
    runId: RunId,
    attachment: ArtifactContentPart,
  ): Promise<{ readonly bytes: Readable; readonly sha256: string }>;
}
export class TeamRunFileTransfers {
  readonly #links: PersonalTeamLinksStore;
  readonly #vault: PersonalTeamVault;
  readonly #network: TeamLinkNetwork;
  readonly #attachments: PersonalTeamAttachmentPort;
  constructor(options: {
    readonly links: PersonalTeamLinksStore;
    readonly vault: PersonalTeamVault;
    readonly network: TeamLinkNetwork;
    readonly attachments: PersonalTeamAttachmentPort;
  }) {
    this.#links = options.links;
    this.#vault = options.vault;
    this.#network = options.network;
    this.#attachments = options.attachments;
  }

  async #authority(run: TeamToolRun, teamId: DeploymentId) {
    const link = await this.#links.get(teamId);
    if (link?.state === "needs_update" || link?.state === "joining")
      throw linkError("runner_offline");
    if (!link?.credentialReference || !["active", "unreachable"].includes(link.state))
      throw linkError();
    const { secret } = await this.#vault.open(link.credentialReference, teamId);
    return {
      link,
      headers: {
        authorization: `Bearer ${secret}`,
        [teamApiVersionHeader]: String(teamApiVersion),
        "x-opensteer-team-run-id": run.runId,
        "x-opensteer-team-operation-id": teamOperationId("file", run.runId, run.operationId),
      },
    };
  }

  async fetch(
    run: TeamToolRun,
    teamId: DeploymentId,
    blobId: TeamBlobId,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ) {
    const { link, headers } = await this.#authority(run, teamId);
    const response = await this.#network.request(link.approvedOrigin, teamBinaryRoutes.download, {
      signal,
      headers: {
        ...headers,
        "x-opensteer-team-blob-id": blobId,
        "x-opensteer-team-file-part": "original",
      },
    });
    try {
      const encoded = response.headers["x-opensteer-team-file"];
      if (typeof encoded !== "string" || encoded.length > 8192) throw linkError("bad_request");
      const metadata = TeamFileResultSchema.parse(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
      if (
        metadata.file.id !== blobId ||
        metadata.file.channelId !== metadata.source.channelId ||
        metadata.source.teamId !== teamId
      )
        throw linkError();
      const bytes = boundedTeamStream(response, metadata.file.sizeBytes, signal, {
        size: metadata.file.sizeBytes,
        sha256: metadata.file.sha256,
      });
      const local = await this.#attachments.import({
        runId: run.runId,
        ...metadata,
        bytes,
        signal,
      });
      return { ...metadata, ...local };
    } finally {
      response.destroy();
    }
  }

  async upload(
    run: TeamToolRun,
    teamId: DeploymentId,
    channelId: TeamChannelId,
    attachment: ArtifactContentPart,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ) {
    const { link, headers } = await this.#authority(run, teamId);
    const sizeBytes = TeamBinaryUploadMetadataSchema.shape.sizeBytes.parse(attachment.sizeBytes);
    const exported = await this.#attachments.export(run.runId, attachment);
    let body: Readable | undefined;
    let original = exported.bytes;
    let directory: string | undefined;
    try {
      let preview: Buffer | undefined;
      if (attachment.mediaType?.startsWith("image/")) {
        directory = await mkdtemp(join(tmpdir(), "opensteer-team-preview-"));
        const path = join(directory, "original");
        await pipeline(
          boundedTeamStream(exported.bytes, teamUploadMaxBytes, signal, {
            size: sizeBytes,
            sha256: exported.sha256,
          }),
          createWriteStream(path, { flags: "wx", mode: 0o600 }),
          { signal },
        );
        preview = await sharp(path)
          .rotate()
          .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 60 })
          .toBuffer();
        if (preview.length > teamPreviewMaxBytes) throw linkError("resource_exhausted");
        original = createReadStream(path);
      }
      const metadata = TeamBinaryUploadMetadataSchema.parse({
        channelId,
        clientUploadId: teamOperationId(
          "upload",
          teamId,
          run.runId,
          run.operationId,
          channelId,
          attachment.name,
          exported.sha256,
        ),
        filename: basename(win32.basename(attachment.name)),
        mediaType: attachment.mediaType,
        sizeBytes,
        sha256: exported.sha256,
        previewSizeBytes: preview?.length ?? 0,
      });
      const boundary = `opensteer-${randomUUID()}`;
      const contentType = `multipart/form-data; boundary=${boundary}`;
      body = Readable.from(
        (async function* () {
          yield Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="original"; filename="original"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          );
          for await (const chunk of boundedTeamStream(original, metadata.sizeBytes, signal, {
            size: metadata.sizeBytes,
            sha256: metadata.sha256,
          }))
            yield chunk;
          if (preview) {
            yield Buffer.from(
              `\r\n--${boundary}\r\nContent-Disposition: form-data; name="preview"; filename="preview"\r\nContent-Type: image/jpeg\r\n\r\n`,
            );
            yield preview;
          }
          yield Buffer.from(`\r\n--${boundary}--\r\n`);
        })(),
      );
      const response = await this.#network.request(link.approvedOrigin, teamBinaryRoutes.upload, {
        method: "POST",
        body,
        signal,
        headers: {
          ...headers,
          "content-type": contentType,
          "x-opensteer-team-upload": JSON.stringify(metadata).replace(
            /[^\x20-\x7e]/g,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
          ),
        },
      });
      const chunks: Buffer[] = [];
      for await (const chunk of boundedTeamStream(response, 8192, signal))
        chunks.push(Buffer.from(chunk));
      const result = TeamFileResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (
        result.source.teamId !== teamId ||
        result.file.channelId !== channelId ||
        result.source.channelId !== channelId
      )
        throw linkError();
      return result;
    } finally {
      exported.bytes.destroy();
      original.destroy();
      body?.destroy();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async uploadPath(
    run: TeamToolRun,
    teamId: DeploymentId,
    channelId: TeamChannelId,
    path: string,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ) {
    await this.#authority(run, teamId);
    signal.throwIfAborted();
    const attachment = await this.#attachments.admitPath(run.runId, path, signal);
    return this.upload(run, teamId, channelId, attachment, signal);
  }
}
