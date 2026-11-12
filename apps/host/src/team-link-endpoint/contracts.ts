import {
  OpensteerError,
  type TeamActor,
  type TeamAgentRequestId,
  type TeamBlobId,
  type TeamLinkId,
  type TeamSource,
} from "@opensteer/core";
import { teamApiVersion } from "@opensteer/deployment-authority";
import type {
  TeamBinaryUploadMetadataSchema,
  TeamFileSchema,
  TeamLinkClientFrame,
  TeamLinkResultSchema,
  TeamReadResultSchema,
  TeamSearchInputSchema,
  TeamSearchPageSchema,
  TeamSqlInputSchema,
  TeamSqlResultSchema,
} from "@opensteer/protocol";
import type { Readable } from "node:stream";
import type { z } from "zod";
import type { TeamUploadPart } from "./multipart.js";

export const teamLinkRoutes = {
  redeem: "/internal/v1/team/link/redeem",
  socket: "/internal/v1/team/link",
} as const;
export const teamLinkMaxFrameBytes = 300 * 1024;
export type TeamLinkResult = z.infer<typeof TeamLinkResultSchema>;
export type TeamLinkCall = Exclude<TeamLinkClientFrame, { type: "hello" | "ping" }>;
export type TeamLinkCallInput = TeamLinkCall extends infer Frame
  ? Frame extends TeamLinkCall
    ? Omit<Frame, "id">
    : never
  : never;
export interface TeamLinkRpc {
  call(input: TeamLinkCallInput): Promise<TeamLinkResult>;
}
export interface TeamMachineDataPort {
  read(
    actor: TeamActor,
    linkId: TeamLinkId,
    input: Extract<TeamLinkCall, { type: "read" }>,
  ): Promise<z.infer<typeof TeamReadResultSchema>>;
  search(
    actor: TeamActor,
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
    input: z.infer<typeof TeamSearchInputSchema>,
  ): Promise<z.infer<typeof TeamSearchPageSchema>>;
  sql(
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
    input: z.infer<typeof TeamSqlInputSchema>,
  ): Promise<{
    readonly result: z.infer<typeof TeamSqlResultSchema>;
    /** Rechecks the exact topic scope that produced this buffered result, without rerunning SQL. */
    readonly reauthorize: () => Promise<boolean>;
  }>;
}
export interface TeamMachineFilesPort {
  open(input: {
    readonly actor: TeamActor;
    readonly linkId: TeamLinkId;
    readonly requestId: TeamAgentRequestId;
    readonly blobId: TeamBlobId;
    readonly part: "original" | "preview";
    readonly signal: AbortSignal;
  }): Promise<{
    readonly file: z.infer<typeof TeamFileSchema>;
    readonly source: TeamSource;
    readonly bytes: Readable;
  }>;
  upload(input: {
    readonly actor: TeamActor;
    readonly linkId: TeamLinkId;
    readonly requestId: TeamAgentRequestId;
    readonly metadata: z.infer<typeof TeamBinaryUploadMetadataSchema>;
    readonly parts: AsyncIterable<TeamUploadPart>;
    readonly signal: AbortSignal;
  }): Promise<{ readonly file: z.infer<typeof TeamFileSchema>; readonly source: TeamSource }>;
}
export function linkError(
  code:
    | "unauthorized"
    | "forbidden"
    | "conflict"
    | "bad_request"
    | "runner_offline"
    | "timeout"
    | "resource_exhausted" = "forbidden",
) {
  return new OpensteerError({
    code,
    message: "Team link operation is unavailable",
    retryable: ["runner_offline", "timeout", "resource_exhausted"].includes(code),
  });
}
export function checkTeamVersion(value: unknown): void {
  if (value !== String(teamApiVersion))
    throw new OpensteerError({
      code: "bad_request",
      reason: "unsupported-version",
      message: "Team API version mismatch",
      details: { kind: "team", apiVersion: teamApiVersion },
    });
}
