import { stripRefs } from "@opensteer/shared/stripRefs";
import { OpensteerError, type DeploymentId, type RunId, type TeamBlobId } from "@opensteer/core";
import type { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import type { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import { TeamMarkdownSchema, TeamSearchInputSchema } from "@opensteer/protocol";
import { teamMentionHandles } from "@opensteer/shared/teamMentions";
import type { z } from "zod";
import {
  linkError,
  type TeamLinkCallInput,
  type TeamLinkResult,
  type TeamLinkRpc,
} from "../team-link-endpoint/contracts.js";
import type { TeamToolPort, TeamToolRun } from "../mcp/team-tool-port.js";
import { teamOperationId } from "./operation-id.js";

export class TeamRunTools {
  readonly linksStore: PersonalTeamLinksStore;
  readonly requests: PersonalTeamRequestsStore;
  readonly onPost: ((teamId: DeploymentId) => Promise<void>) | undefined;
  readonly rpc: (teamId: DeploymentId) => TeamLinkRpc;
  constructor(
    linksStore: PersonalTeamLinksStore,
    requests: PersonalTeamRequestsStore,
    rpc: (teamId: DeploymentId) => TeamLinkRpc,
    onPost?: (teamId: DeploymentId) => Promise<void>,
  ) {
    this.linksStore = linksStore;
    this.requests = requests;
    this.rpc = rpc;
    this.onPost = onPost;
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
    // Admission commits, and can dispatch, before the mirror is recorded and the team has the accept.
    // Only that window retries; any other refusal stays as the team or link gave it.
    const unconfirmed = () =>
      new OpensteerError({
        code: "conflict",
        message: "The team hasn't confirmed this request yet",
        retryable: true,
      });
    const request = await this.requests.forRun(runId);
    if (!request) {
      if (await this.requests.repliesToTeam(runId)) throw unconfirmed();
      throw linkError();
    }
    let result: TeamLinkResult;
    try {
      result = await this.rpc(request.teamId).call({
        type: "context",
        requestId: request.requestId,
      });
    } catch (error) {
      if (
        request.terminalState === null &&
        request.remoteState === "queued" &&
        error instanceof OpensteerError &&
        !error.retryable
      )
        throw unconfirmed();
      throw error;
    }
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
      if (
        request.deliveryVia === "tool" &&
        request.answerPayload &&
        stripRefs(request.answerPayload.bodyMarkdown) === request.answerPayload.bodyMarkdown &&
        (await this.requests.post(teamId, request.clientMessageId))?.messageId === null
      )
        return this.post(run, teamId, {
          channelId: request.source.channelId,
          ...(request.source.threadRootId ? { threadRootId: request.source.threadRootId } : {}),
          ...request.answerPayload,
        });
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
    const link = await this.linksStore.get(teamId);
    if (!link?.remoteLinkId || !["active", "unreachable"].includes(link.state)) throw linkError();
    const request = await this.requests.forRun(run.runId);
    const claimsReply =
      request?.teamId === teamId &&
      request.source.channelId === input.channelId &&
      request.source.threadRootId === (input.threadRootId ?? null);
    const clientMessageId = teamOperationId("tool", run.runId, run.operationId);
    const frozen =
      claimsReply && request.clientMessageId === clientMessageId ? request.answerPayload : null;
    const previous = await this.requests.post(teamId, clientMessageId);
    const savedBody = frozen?.bodyMarkdown ?? previous?.bodyMarkdown;
    if (savedBody !== undefined && stripRefs(savedBody) !== savedBody) {
      if (claimsReply) {
        const receipt = await this.rpc(teamId).call({
          type: "receipt",
          requestId: request.requestId,
        });
        if (receipt.kind !== "receipt") throw linkError("bad_request");
        if (receipt.messageId) {
          await this.requests.publication(teamId, request.requestId, "accepted", receipt.messageId);
          return {
            messageId: receipt.messageId,
            source: { ...request.source, messageId: receipt.messageId },
          };
        }
        await this.requests.publication(
          teamId,
          request.requestId,
          "blocked",
          null,
          "The saved post contains private references and cannot be replayed. Send a new post.",
        );
      }
      throw new OpensteerError({
        code: "conflict",
        message:
          "The saved post contains private references and cannot be replayed. Send a new post.",
      });
    }
    input = {
      ...input,
      bodyMarkdown: savedBody ?? stripRefs(input.bodyMarkdown),
      attachmentIds: frozen?.attachmentIds ?? previous?.attachmentIds ?? input.attachmentIds,
    };
    if (!TeamMarkdownSchema.safeParse(input.bodyMarkdown).success)
      throw new OpensteerError({
        code: "bad_request",
        message: "The sanitized post is empty or exceeds the team message limit.",
      });
    const { source, ownerHandle } = await this.read(run, teamId, {
      channelId: input.channelId,
      ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
    });
    if (claimsReply) {
      const saved = await this.requests.freeze(teamId, request.requestId, {
        runId: run.runId,
        via: "tool",
        clientMessageId,
        answerMessageId: null,
        payload: { bodyMarkdown: input.bodyMarkdown, attachmentIds: [...input.attachmentIds] },
      });
      if (
        saved.clientMessageId === clientMessageId &&
        saved.answerPayload &&
        (saved.answerPayload.bodyMarkdown !== input.bodyMarkdown ||
          JSON.stringify(saved.answerPayload.attachmentIds) !== JSON.stringify(input.attachmentIds))
      )
        throw new OpensteerError({
          code: "conflict",
          message:
            "The saved post changed while it was being prepared. Check its receipt before retrying.",
        });
    }
    const mentionedAgentHandles = [...new Set(teamMentionHandles(input.bodyMarkdown))].filter(
      (handle) => handle.endsWith("-agent") && handle !== `${ownerHandle}-agent`,
    );
    const provenance = {
      teamDeploymentId: teamId,
      localLinkId: link.id,
      remoteLinkId: link.remoteLinkId,
      clientMessageId,
      runId: run.runId,
      messageId: null,
      channelId: input.channelId,
      threadRootId: input.threadRootId ?? null,
      mentionedAgentHandles,
      bodyMarkdown: input.bodyMarkdown,
      attachmentIds: [...input.attachmentIds],
      requestId: claimsReply ? request.requestId : null,
    };
    if (mentionedAgentHandles.length) await this.requests.recordPost(provenance);
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
          error instanceof OpensteerError &&
          [
            "bad_request",
            "forbidden",
            "unauthorized",
            "not_found",
            "conflict",
            "resource_exhausted",
          ].includes(error.code)
        ) {
          if (mentionedAgentHandles.length)
            await this.requests.forgetPost(teamId, clientMessageId, link.id);
          if (claimsReply)
            await this.requests.clearFreeze(teamId, request.requestId, clientMessageId);
        }
        throw error;
      });
    if (result.kind !== "receipt" || result.messageId === null) throw linkError("bad_request");
    if (mentionedAgentHandles.length)
      await this.requests.recordPost({
        ...provenance,
        messageId: result.messageId,
        askOutcomes: result.askOutcomes,
      });
    await this.onPost?.(teamId);
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
