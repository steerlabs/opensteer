import { OpensteerError, type DeploymentId, type RunId, type TeamBlobId } from "@opensteer/core";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import { TeamSearchInputSchema } from "@opensteer/protocol";
import type { z } from "zod";
import {
  linkError,
  type TeamLinkCallInput,
  type TeamLinkRpc,
} from "../team-link-endpoint/contracts.js";
import type { TeamToolPort, TeamToolRun } from "../mcp/team-tool-port.js";
import { teamOperationId } from "./operation-id.js";

export class TeamRunTools {
  readonly linksStore: PersonalTeamLinksStore;
  readonly requests: PersonalTeamRequestsStore;
  readonly rpc: (teamId: DeploymentId) => TeamLinkRpc;
  constructor(
    linksStore: PersonalTeamLinksStore,
    requests: PersonalTeamRequestsStore,
    rpc: (teamId: DeploymentId) => TeamLinkRpc,
  ) {
    this.linksStore = linksStore;
    this.requests = requests;
    this.rpc = rpc;
  }

  async teams() {
    return (await this.linksStore.list())
      .filter((link) => ["active", "unreachable"].includes(link.state))
      .map((link) => this.linksStore.view(link));
  }

  async authority(teamId?: DeploymentId) {
    const teams = await this.teams();
    const team = teamId
      ? teams.find((link) => link.teamId === teamId)
      : teams.length === 1
        ? teams[0]
        : undefined;
    if (team) return team.teamId;
    throw new OpensteerError({
      code: teamId || !teams.length ? "not_found" : "bad_request",
      message: teamId
        ? "That team is not linked."
        : !teams.length
          ? "Your owner has no linked teams."
          : "Choose teamId; more than one team is linked.",
      ...(teams.length
        ? {
            next: `Use teamId from: ${teams.map((link) => `${link.teamName} (${link.teamId})`).join(", ")}.`,
          }
        : {}),
    });
  }

  async context(runId: RunId) {
    const request = await this.requests.forRun(runId);
    if (!request) throw linkError();
    const result = await this.rpc(request.teamId).call({
      type: "context",
      requestId: request.requestId,
    });
    if (result.kind !== "context") throw linkError("bad_request");
    return {
      ...result.context,
      asker:
        request.kind === "ask" && request.localDecision === "approve"
          ? {
              displayName: request.presentation!.asker.displayName,
              actor: request.presentation!.asker.actor,
            }
          : null,
    };
  }

  async channels(
    run: TeamToolRun,
    teamId: DeploymentId,
    after?: Extract<TeamLinkCallInput, { type: "channels" }>["after"],
  ) {
    const result = await this.rpc(teamId).call({
      type: "channels",
      operationId: teamOperationId("tool", run.runId, run.operationId),
      runId: run.runId,
      ...(after ? { after } : {}),
    });
    if (result.kind !== "channels") throw linkError("bad_request");
    return result.result;
  }

  async read(
    run: TeamToolRun,
    teamId: DeploymentId,
    input: Omit<Extract<TeamLinkCallInput, { type: "read" }>, "type" | "requestId" | "runId">,
  ) {
    const result = await this.rpc(teamId).call({
      type: "read",
      runId: run.runId,
      operationId: teamOperationId("tool", run.runId, run.operationId),
      ...input,
    });
    if (result.kind !== "read") throw linkError("bad_request");
    return result.result;
  }

  async search(
    run: TeamToolRun,
    teamId: DeploymentId,
    input: z.infer<typeof TeamSearchInputSchema>,
  ) {
    const result = await this.rpc(teamId).call({
      type: "search",
      operationId: teamOperationId("tool", run.runId, run.operationId),
      runId: run.runId,
      input: TeamSearchInputSchema.parse(input),
    });
    if (result.kind !== "search") throw linkError("bad_request");
    return result.result;
  }

  async receipt(run: TeamToolRun, teamId: DeploymentId) {
    const request = await this.requests.forRun(run.runId);
    if (
      !request ||
      request.teamId !== teamId ||
      request.clientMessageId !== teamOperationId("tool", run.runId, run.operationId)
    )
      return null;
    const result = await this.rpc(teamId).call({ type: "receipt", requestId: request.requestId });
    if (result.kind !== "receipt") throw linkError("bad_request");
    if (result.messageId !== null) {
      await this.requests.publication(teamId, request.requestId, "accepted", result.messageId);
      return { messageId: result.messageId, source: request.source };
    }
    return null;
  }

  async post(
    run: TeamToolRun,
    teamId: DeploymentId,
    input: {
      readonly channelId: Extract<TeamLinkCallInput, { type: "post" }>["channelId"];
      readonly threadRootId?: Extract<TeamLinkCallInput, { type: "post" }>["threadRootId"];
      readonly bodyMarkdown: string;
      readonly attachmentIds: readonly TeamBlobId[];
    },
  ): ReturnType<TeamToolPort["post"]> {
    const request = await this.requests.forRun(run.runId);
    const claimsReply =
      request?.teamId === teamId &&
      request.source.channelId === input.channelId &&
      request.source.threadRootId === (input.threadRootId ?? null);
    const clientMessageId = teamOperationId("tool", run.runId, run.operationId);
    const { source } = await this.read(run, teamId, {
      channelId: input.channelId,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
    });
    if (claimsReply)
      await this.requests.freeze(teamId, request.requestId, {
        runId: run.runId,
        via: "tool",
        clientMessageId,
        answerMessageId: null,
        payload: { bodyMarkdown: input.bodyMarkdown, attachmentIds: [...input.attachmentIds] },
      });
    const result = await this.rpc(teamId)
      .call({
        type: "post",
        runId: run.runId,
        clientMessageId,
        ...input,
        attachmentIds: [...input.attachmentIds],
        ...(claimsReply ? { requestId: request.requestId } : {}),
      })
      .catch(async (error: unknown) => {
        if (
          claimsReply &&
          error instanceof OpensteerError &&
          [
            "bad_request",
            "forbidden",
            "unauthorized",
            "not_found",
            "conflict",
            "resource_exhausted",
          ].includes(error.code)
        )
          await this.requests.clearFreeze(teamId, request.requestId, clientMessageId);
        throw error;
      });
    if (result.kind !== "receipt" || result.messageId === null) throw linkError("bad_request");
    if (claimsReply) {
      const receipt = await this.rpc(teamId).call({
        type: "receipt",
        requestId: request.requestId,
      });
      if (receipt.kind !== "receipt") throw linkError("bad_request");
      if (receipt.messageId)
        await this.requests.publication(teamId, request.requestId, "accepted", receipt.messageId);
    }
    return {
      messageId: result.messageId,
      ...(result.askOutcomes?.length ? { askOutcomes: result.askOutcomes } : {}),
      source: { ...source, messageId: result.messageId, threadRootId: input.threadRootId ?? null },
    };
  }
}
