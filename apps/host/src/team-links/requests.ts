import {
  TeamSourceSchema,
  OpensteerError,
  type DeploymentId,
  type RunId,
  type TeamAgentRequestId,
  type MessageId,
} from "@opensteer/core";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import {
  TeamAgentRequestSchema,
  TeamMarkdownSchema,
  type PersonalTeamRequest,
  type TeamRunRequest,
} from "@opensteer/protocol";
import type { TaskAdmissionPort } from "../threads/task-admission.js";
import { linkError, type TeamLinkRpc } from "../team-link-endpoint/contracts.js";
import { teamOperationId } from "./operation-id.js";
import { publicTeamStatus, type PrivateTeamProgress } from "./status.js";

export interface PersonalTeamRunPort {
  /** Reads the durable input/Run outcome, including outcomes finalized while the link process was stopped. */
  outcome(request: PersonalTeamRequest): Promise<{
    readonly runId: RunId | null;
    readonly state:
      "pending" | "working" | "needs_you" | "done" | "failed" | "stopped" | "cancelled";
    readonly finalMessage: string | null;
    readonly answerMessageId: MessageId | null;
  }>;
}
export interface PersonalTeamRequestsOptions {
  readonly links: PersonalTeamLinksStore;
  readonly requests: PersonalTeamRequestsStore;
  readonly admission: TaskAdmissionPort;
  readonly runs: PersonalTeamRunPort;
  readonly rpc: (teamId: DeploymentId) => TeamLinkRpc;
}

export class PersonalTeamRequests {
  readonly options: PersonalTeamRequestsOptions;
  readonly #work = new Map<DeploymentId, Promise<void>>();
  readonly #lastStatus = new Map<string, number>();
  constructor(options: PersonalTeamRequestsOptions) {
    this.options = options;
  }

  async deliver(teamId: DeploymentId, value: TeamRunRequest): Promise<void> {
    const previous = this.#work.get(teamId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#admit(teamId, value));
    this.#work.set(teamId, next);
    try {
      await next;
    } finally {
      if (this.#work.get(teamId) === next) this.#work.delete(teamId);
    }
  }

  async #admit(teamId: DeploymentId, value: TeamRunRequest): Promise<void> {
    const { links, requests, admission } = this.options;
    const link = await links.get(teamId);
    if (!link || !["active", "unreachable"].includes(link.state)) throw linkError();
    const request = TeamAgentRequestSchema.parse(value.request);
    const source = TeamSourceSchema.parse(value.source);
    if (
      source.teamId !== teamId ||
      request.ownerUserId !== link.remoteOwnerUserId ||
      source.channelId !== request.channelId ||
      source.threadRootId !== request.threadRootId ||
      source.messageId !== request.triggerMessageId ||
      source.audience.peopleOnly
    )
      throw linkError();
    await links.observeName(teamId, source.audience.teamName);
    let local = await requests.get(teamId, request.id);
    if (local && local.triggerMessageId !== request.triggerMessageId) throw linkError("conflict");
    if (local?.publicationState === "blocked") return;
    if (
      local &&
      (local.answerPayload !== null ||
        local.terminalState !== null ||
        local.publicationState === "accepted")
    ) {
      await this.reconcileOne(local);
      return;
    }
    if (["done", "failed", "stopped", "cancelled"].includes(request.state)) {
      if (local) await this.cancel(teamId, request.id);
      return;
    }
    if (!local) {
      const receipt = await admission.admitTeamRequest({
        bodyMarkdown: value.bodyMarkdown,
        attachments: value.attachments,
        origin: { teamId, channelId: request.channelId, threadRootId: request.threadRootId },
        requestId: request.id,
        triggerMessageId: request.triggerMessageId,
        source,
      });
      local = await requests.record({
        teamId,
        requestId: request.id,
        triggerMessageId: request.triggerMessageId,
        taskId: receipt.taskId,
        inputId: receipt.inputId,
        runId: receipt.runId,
        source,
        terminalState: null,
        publicationState: "pending",
        replyMessageId: null,
        answerMessageId: null,
        answerPayload: null,
        clientMessageId: null,
        deliveryVia: null,
        blockedReason: null,
      });
    }
    const current = await links.get(teamId);
    if (
      !current ||
      !["active", "unreachable"].includes(current.state) ||
      current.remoteLinkId !== link.remoteLinkId
    ) {
      await this.cancel(teamId, request.id);
      return;
    }
    try {
      await this.options.rpc(teamId).call({ type: "accept", requestId: request.id });
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        ["forbidden", "unauthorized", "not_found"].includes(error.code)
      )
        await this.cancel(teamId, request.id);
      throw error;
    }
    await this.reconcileOne(local);
  }

  async reconnect(teamId: DeploymentId): Promise<void> {
    for (const request of await this.options.requests.forTeam(teamId)) {
      try {
        await this.#receipt(request);
        const current = (await this.options.requests.get(teamId, request.requestId))!;
        const outcome = await this.options.runs.outcome(current);
        if (["pending", "working", "needs_you"].includes(outcome.state))
          await this.options.rpc(teamId).call({ type: "accept", requestId: request.requestId });
        await this.reconcileOne(current);
      } catch (error) {
        await this.#failure(request, error);
      }
    }
  }

  async #receipt(request: PersonalTeamRequest): Promise<boolean> {
    const receipt = await this.options
      .rpc(request.teamId)
      .call({ type: "receipt", requestId: request.requestId });
    if (receipt.kind !== "receipt") throw linkError("bad_request");
    if (receipt.messageId === null) return false;
    await this.options.requests.publication(
      request.teamId,
      request.requestId,
      "accepted",
      receipt.messageId,
    );
    return true;
  }

  async #failure(request: PersonalTeamRequest, error: unknown): Promise<void> {
    if (
      error instanceof OpensteerError &&
      ["forbidden", "unauthorized", "not_found"].includes(error.code)
    ) {
      await this.cancel(
        request.teamId,
        request.requestId,
        error.code === "unauthorized"
          ? "The team link was revoked."
          : error.code === "not_found"
            ? "The team or reply thread is no longer available."
            : "Team access was removed or the channel is people-only.",
      );
      return;
    }
    // A frozen answer remains sending until the same operation can reconcile on reconnect.
    if (
      error instanceof OpensteerError &&
      ["runner_offline", "timeout", "internal"].includes(error.code)
    )
      return;
    throw error;
  }

  async reconcileOne(request: PersonalTeamRequest): Promise<void> {
    const { requests, runs } = this.options;
    const outcome = await runs.outcome(request);
    if (!["done", "failed", "stopped", "cancelled"].includes(outcome.state)) return;
    const terminalState = outcome.state as NonNullable<PersonalTeamRequest["terminalState"]>;
    this.#lastStatus.delete(`${request.teamId}:${request.requestId}`);
    const current = (await requests.get(request.teamId, request.requestId))!;
    if (current.publicationState === "pending")
      await this.#publish(
        { ...current, terminalState, runId: outcome.runId },
        outcome.finalMessage,
        outcome.answerMessageId,
      );
    if ((await requests.get(request.teamId, request.requestId))?.publicationState === "pending")
      return;
    try {
      await this.options
        .rpc(request.teamId)
        .call({ type: "status", requestId: request.requestId, state: terminalState, steps: [] });
      await requests.terminal(request.teamId, request.requestId, outcome.runId, terminalState);
    } catch (error) {
      await this.#failure(current, error);
      if (
        error instanceof OpensteerError &&
        ["forbidden", "unauthorized", "not_found"].includes(error.code)
      )
        await requests.terminal(request.teamId, request.requestId, outcome.runId, terminalState);
    }
  }

  async runChanged(runId: RunId, progress?: PrivateTeamProgress): Promise<void> {
    const request = await this.options.requests.forRun(runId);
    if (!request) return;
    try {
      await this.reconcileOne(request);
      const current = await this.options.requests.get(request.teamId, request.requestId);
      if (
        current?.terminalState === null &&
        progress &&
        ["working", "needs_you"].includes(progress.state)
      )
        await this.status(request.teamId, request.requestId, progress);
    } catch (error) {
      if (!(error instanceof OpensteerError) || !["runner_offline", "timeout"].includes(error.code))
        throw error;
    }
  }

  async #publish(
    request: PersonalTeamRequest,
    finalMessage: string | null,
    answerMessageId: MessageId | null,
  ): Promise<void> {
    const { requests } = this.options;
    try {
      if (
        !request.answerPayload &&
        finalMessage &&
        !TeamMarkdownSchema.safeParse(finalMessage).success
      ) {
        await requests.publication(
          request.teamId,
          request.requestId,
          "blocked",
          null,
          "The final answer exceeds the team message limit.",
        );
        return;
      }
      if (!request.answerPayload && finalMessage && request.runId)
        request = await requests.freeze(request.teamId, request.requestId, {
          runId: request.runId,
          via: "final",
          answerMessageId,
          payload: { bodyMarkdown: finalMessage, attachmentIds: [] },
          clientMessageId: teamOperationId("final", request.teamId, request.requestId),
        });
      if (await this.#receipt(request)) return;
      if (request.terminalState === "cancelled") {
        await requests.publication(
          request.teamId,
          request.requestId,
          "blocked",
          null,
          "The team request was cancelled.",
        );
        return;
      }
      if (request.answerPayload && request.clientMessageId && request.runId) {
        const result = await this.options.rpc(request.teamId).call({
          type: "post",
          publication: true,
          runId: request.runId,
          clientMessageId: request.clientMessageId,
          channelId: request.source.channelId,
          ...(request.source.threadRootId ? { threadRootId: request.source.threadRootId } : {}),
          requestId: request.requestId,
          ...request.answerPayload,
        });
        if (result.kind !== "receipt" || result.messageId === null) throw linkError("bad_request");
        await requests.publication(request.teamId, request.requestId, "accepted", result.messageId);
      } else {
        await requests.publication(
          request.teamId,
          request.requestId,
          "blocked",
          null,
          "The Run ended without an answer to post.",
        );
      }
    } catch (error) {
      await this.#failure(request, error);
    }
  }

  async status(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    progress: PrivateTeamProgress,
  ): Promise<void> {
    const terminal = ["failed", "stopped", "cancelled"].includes(progress.state);
    if (terminal) {
      const request = await this.options.requests.get(teamId, requestId);
      if (request) await this.reconcileOne(request);
      return;
    }
    const key = `${teamId}:${requestId}`;
    if (
      progress.state !== "needs_you" &&
      Date.now() - (this.#lastStatus.get(key) ?? -Infinity) < 1000
    )
      return;
    this.#lastStatus.set(key, Date.now());
    await this.options
      .rpc(teamId)
      .call({ type: "status", requestId, ...publicTeamStatus(progress) });
  }

  async cancel(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    reason = "The team request was cancelled.",
  ): Promise<void> {
    this.#lastStatus.delete(`${teamId}:${requestId}`);
    const request = await this.options.requests.get(teamId, requestId);
    if (request) {
      await this.options.requests.terminal(teamId, requestId, request.runId, "cancelled");
      if (request.publicationState !== "accepted")
        await this.options.requests.publication(teamId, requestId, "blocked", null, reason);
    }
    await this.options.admission.cancelTeamRequest({ teamId, requestId });
  }

  async revoked(teamId: DeploymentId): Promise<void> {
    await this.options.links.state(teamId, "revoked");
    for (const request of await this.options.requests.forTeam(teamId))
      await this.cancel(teamId, request.requestId, "The team link was revoked.");
  }
}
