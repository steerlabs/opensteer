import { type RunId, type TeamBlobId } from "@opensteer/core";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import { TeamSqlInputSchema, TeamSearchInputSchema } from "@opensteer/protocol";
import type { z } from "zod";
import {
  linkError,
  type TeamLinkCallInput,
  type TeamLinkRpc,
} from "../team-link-endpoint/contracts.js";
import { PersonalTeamRequests } from "./requests.js";

export interface TeamRunFilesPort {
  fetch(runId: RunId, blobId: TeamBlobId): Promise<unknown>;
}
export class TeamRunTools {
  readonly #requests: PersonalTeamRequestsStore;
  readonly #publisher: PersonalTeamRequests;
  readonly #rpc: (teamId: Parameters<PersonalTeamRequestsStore["get"]>[0]) => TeamLinkRpc;
  readonly #files: TeamRunFilesPort;
  constructor(
    requests: PersonalTeamRequestsStore,
    publisher: PersonalTeamRequests,
    rpc: (teamId: Parameters<PersonalTeamRequestsStore["get"]>[0]) => TeamLinkRpc,
    files: TeamRunFilesPort,
  ) {
    this.#requests = requests;
    this.#publisher = publisher;
    this.#rpc = rpc;
    this.#files = files;
  }

  async #request(runId: RunId) {
    const request = await this.#requests.forRun(runId);
    if (!request) throw new Error("no team request in this turn");
    return request;
  }

  async authority(runId: RunId) {
    return this.#request(runId);
  }

  async receipt(runId: RunId) {
    const request = await this.#request(runId);
    const result = await this.#rpc(request.teamId).call({
      type: "receipt",
      requestId: request.requestId,
    });
    if (result.kind !== "receipt") throw linkError("bad_request");
    if (result.messageId !== null)
      await this.#requests.publication(
        request.teamId,
        request.requestId,
        "accepted",
        result.messageId,
      );
    return result.messageId === null
      ? null
      : { messageId: result.messageId, source: request.source };
  }

  async context(runId: RunId) {
    const request = await this.#request(runId);
    const result = await this.#rpc(request.teamId).call({
      type: "context",
      requestId: request.requestId,
    });
    if (result.kind !== "context") throw linkError("bad_request");
    return result.context;
  }

  async read(
    runId: RunId,
    input: Omit<Extract<TeamLinkCallInput, { type: "read" }>, "type" | "requestId">,
  ) {
    const request = await this.#request(runId);
    const result = await this.#rpc(request.teamId).call({
      type: "read",
      requestId: request.requestId,
      channelId: input.channelId,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
      ...(input.before ? { before: input.before } : {}),
    });
    if (result.kind !== "read") throw linkError("bad_request");
    return result.result;
  }

  async search(runId: RunId, value: z.infer<typeof TeamSearchInputSchema>) {
    const request = await this.#request(runId);
    const result = await this.#rpc(request.teamId).call({
      type: "search",
      requestId: request.requestId,
      input: TeamSearchInputSchema.parse(value),
    });
    if (result.kind !== "search") throw linkError("bad_request");
    return result.result;
  }

  async reply(runId: RunId, bodyMarkdown: string, attachmentIds: readonly TeamBlobId[] = []) {
    return this.#publisher.reply(await this.#request(runId), bodyMarkdown, attachmentIds);
  }

  async sql(runId: RunId, value: z.infer<typeof TeamSqlInputSchema>) {
    const request = await this.#request(runId);
    const result = await this.#rpc(request.teamId).call({
      type: "knowledge.sql",
      requestId: request.requestId,
      input: TeamSqlInputSchema.parse(value),
    });
    if (result.kind !== "knowledge.sql") throw linkError("bad_request");
    return result.result;
  }

  async file(runId: RunId, blobId: TeamBlobId) {
    await this.#request(runId);
    return this.#files.fetch(runId, blobId);
  }
}
