import { DeploymentIdSchema } from "@opensteer/core";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { teamApiVersion, teamApiVersionHeader } from "@opensteer/deployment-authority";
import {
  TeamBinaryUploadMetadataSchema,
  TeamFileSchema,
  teamPreviewMaxBytes,
  teamUploadMaxBytes,
} from "@opensteer/protocol";
import type { z } from "zod";
import type { HostTransport } from "../connections/host-transport.js";
import { teamCacheKey, type TeamCacheScope } from "./persistence.js";

type TeamFile = z.infer<typeof TeamFileSchema>;
export interface TeamFileUpload {
  readonly channelId: TeamFile["channelId"];
  readonly original: Blob;
  readonly preview: Blob | null;
  readonly metadata: z.infer<typeof TeamBinaryUploadMetadataSchema>;
  readonly signal?: AbortSignal;
}
export function teamFileTransport(
  transport: Pick<HostTransport, "exchange">,
  scope: TeamCacheScope,
) {
  teamCacheKey(scope);
  const deploymentId = DeploymentIdSchema.parse(scope.teamDeploymentId);
  const version = { [teamApiVersionHeader]: String(teamApiVersion) };
  return {
    async readFile(
      file: TeamFile,
      part: "preview" | "original",
      signal?: AbortSignal,
    ): Promise<Blob> {
      const metadata = TeamFileSchema.parse(file),
        preview = part === "preview";
      if (preview && !metadata.preview) throw new Error("This file has no preview.");
      const expected = preview ? metadata.preview!.sizeBytes : metadata.sizeBytes;
      return transport.exchange(
        {
          expectedDeploymentId: deploymentId,
          path: `/v1/team/files/${metadata.id}/${part}`,
          method: "GET",
          headers: { additional: version },
          ...(signal ? { signal } : {}),
        },
        async (response, progress) => {
          if (!response.ok) throw new Error("The team file is no longer available.");
          const maximumBytes = preview ? teamPreviewMaxBytes : teamUploadMaxBytes;
          const bytes = await readBoundedResponse(response, {
            maximumBytes,
            signal: progress.signal,
            onProgress: progress.onProgress,
            sizeError: () => new Error("Team file exceeds its byte bound."),
          });
          if (bytes.byteLength !== expected) throw new Error("Team file size changed.");
          const mediaType = response.headers.get("content-type")?.split(";", 1)[0];
          if (mediaType !== (preview ? metadata.preview!.mediaType : "application/octet-stream"))
            throw new Error("Unexpected team file type.");
          return new Blob([Uint8Array.from(bytes)], {
            type: preview ? metadata.preview!.mediaType : "application/octet-stream",
          });
        },
      );
    },
    async uploadFile(input: TeamFileUpload): Promise<TeamFile> {
      const metadata = TeamBinaryUploadMetadataSchema.parse(input.metadata);
      if (
        input.original.size !== metadata.sizeBytes ||
        (input.preview?.size ?? 0) !== metadata.previewSizeBytes
      )
        throw new Error("Team upload sizes do not match their metadata.");
      const body = new Blob([input.original, ...(input.preview ? [input.preview] : [])], {
        type: "application/octet-stream",
      });
      return transport.exchange(
        {
          expectedDeploymentId: deploymentId,
          path: `/v1/team/files/upload/${input.channelId}`,
          method: "POST",
          body,
          headers: {
            contentType: "application/octet-stream",
            additional: { ...version, "x-opensteer-team-upload": JSON.stringify(metadata) },
          },
          ...(input.signal ? { signal: input.signal } : {}),
        },
        async (response, progress) => {
          if (!response.ok) throw new Error("The team file could not be uploaded.");
          const bytes = await readBoundedResponse(response, {
            maximumBytes: 128 * 1024,
            signal: progress.signal,
            onProgress: progress.onProgress,
            sizeError: () => new Error("Team upload response exceeds its byte bound."),
          });
          return TeamFileSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        },
      );
    },
  };
}
