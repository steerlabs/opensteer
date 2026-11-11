import {
  TeamSourceSchema,
  OpensteerError,
  type DeploymentId,
  type RunId,
  type TeamAgentRequestId,
  type TeamBlobId,
} from "@opensteer/core";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import { PersonalTeamChannelFoldersStore } from "@opensteer/database/personal-team-channel-folders-store";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import {
  TeamAgentRequestSchema,
  type PersonalTeamRequest,
  type TeamAgentRequest,
} from "@opensteer/protocol";
import type { TeamSource } from "@opensteer/core";
import type { TaskAdmissionPort } from "../threads/task-admission.js";
import { linkError, type TeamLinkRpc } from "../team-link-endpoint/contracts.js";
import { publicTeamStatus, type PrivateTeamProgress } from "./status.js";

export interface PersonalTeamRunPort {
  /** Reads the durable input/Run outcome, including outcomes finalized while the link process was stopped. */
  outcome(request: PersonalTeamRequest): Promise<{
    readonly runId: RunId | null;
    readonly state:
      "pending" | "working" | "needs_you" | "done" | "failed" | "stopped" | "cancelled";
    readonly finalMessage: string | null;
  }>;
}
export interface PersonalTeamRequestsOptions {
  readonly links: PersonalTeamLinksStore;
  readonly requests: PersonalTeamRequestsStore;
  readonly folders: PersonalTeamChannelFoldersStore;
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

  async deliver(
    teamId: DeploymentId,
    value: { readonly request: TeamAgentRequest; readonly source: TeamSource },
  ): Promise<void> {
    const previous = this.#work.get(teamId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#admit(teamId, value));
    this.#work.set(teamId, next);
    try {
      await next;
    } finally {
      if (this.#work.get(teamId) === next) this.#work.delete(teamId);
    }
  }

  async #admit(
    teamId: DeploymentId,
    value: { readonly request: TeamAgentRequest; readonly source: TeamSource },
  ): Promise<void> {
    const { links, requests, admission, folders } = this.options;
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
    if (local && (local.terminalState !== null || local.publicationState === "accepted")) {
      await this.reconcileOne(local);
      return;
    }
    if (["done", "failed", "stopped", "cancelled"].includes(request.state)) {
      if (local) await this.cancel(teamId, request.id);
      return;
    }
    if (!local) {
      const receipt = await admission.admitTeamRequest({
        origin: { teamId, channelId: request.channelId, threadRootId: request.threadRootId },
        requestId: request.id,
        triggerMessageId: request.triggerMessageId,
        source,
        folder: await folders.get(teamId, request.channelId),
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
      const outcome = await this.options.runs.outcome(request);
      if (["done", "failed", "stopped", "cancelled"].includes(outcome.state)) {
        await this.reconcileOne(request);
        continue;
      }
      try {
        const receipt = await this.options
          .rpc(teamId)
          .call({ type: "receipt", requestId: request.requestId });
        if (receipt.kind !== "receipt") throw linkError("bad_request");
        if (receipt.messageId !== null)
          await this.options.requests.publication(
            teamId,
            request.requestId,
            "accepted",
            receipt.messageId,
          );
        else await this.options.rpc(teamId).call({ type: "accept", requestId: request.requestId });
      } catch (error) {
        if (
          error instanceof OpensteerError &&
          ["forbidden", "unauthorized", "not_found"].includes(error.code)
        )
          await this.cancel(teamId, request.requestId);
        else throw error;
      }
    }
  }

  async reconcileOne(request: PersonalTeamRequest): Promise<void> {
    const { requests, runs } = this.options;
    const outcome = await runs.outcome(request);
    if (!["done", "failed", "stopped", "cancelled"].includes(outcome.state)) return;
    const terminalState = outcome.state as NonNullable<PersonalTeamRequest["terminalState"]>;
    await requests.terminal(request.teamId, request.requestId, outcome.runId, terminalState);
    this.#lastStatus.delete(`${request.teamId}:${request.requestId}`);
    if (request.publicationState !== "pending") return;
    await this.#publish({ ...request, terminalState, runId: outcome.runId }, outcome.finalMessage);
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

  async #publish(request: PersonalTeamRequest, finalMessage: string | null): Promise<void> {
    const { requests } = this.options;
    try {
      const rpc = this.options.rpc(request.teamId);
      const receipt = await rpc.call({ type: "receipt", requestId: request.requestId });
      if (receipt.kind !== "receipt") throw linkError("bad_request");
      if (receipt.messageId !== null) {
        await requests.publication(
          request.teamId,
          request.requestId,
          "accepted",
          receipt.messageId,
        );
        return;
      }
      if (finalMessage !== null) {
        await this.reply(request, finalMessage, []);
      } else {
        await rpc.call({
          type: "status",
          requestId: request.requestId,
          state: request.terminalState === "done" ? "failed" : (request.terminalState ?? "failed"),
          steps: [],
        });
        await requests.publication(request.teamId, request.requestId, "accepted");
      }
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        ["forbidden", "unauthorized", "not_found"].includes(error.code)
      ) {
        await requests.publication(request.teamId, request.requestId, "blocked");
        return;
      }
      throw error;
    }
  }

  async reply(
    request: PersonalTeamRequest,
    bodyMarkdown: string,
    attachmentIds: readonly TeamBlobId[],
  ) {
    const result = await this.options.rpc(request.teamId).call({
      type: "reply",
      requestId: request.requestId,
      bodyMarkdown,
      attachmentIds: [...attachmentIds],
    });
    if (result.kind !== "receipt" || result.messageId === null) throw linkError("bad_request");
    await this.options.requests.publication(
      request.teamId,
      request.requestId,
      "accepted",
      result.messageId,
    );
    return { messageId: result.messageId, source: request.source };
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

  async cancel(teamId: DeploymentId, requestId: TeamAgentRequestId): Promise<void> {
    this.#lastStatus.delete(`${teamId}:${requestId}`);
    const request = await this.options.requests.get(teamId, requestId);
    if (request) {
      await this.options.requests.terminal(teamId, requestId, request.runId, "cancelled");
      if (request.publicationState !== "accepted")
        await this.options.requests.publication(teamId, requestId, "blocked");
    }
    await this.options.admission.cancelTeamRequest({ teamId, requestId });
  }

  async revoked(teamId: DeploymentId): Promise<void> {
    await this.options.links.state(teamId, "revoked");
    for (const request of await this.options.requests.forTeam(teamId))
      await this.cancel(teamId, request.requestId);
  }
}
