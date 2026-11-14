import { isDeepStrictEqual } from "node:util";
import {
  MessageIdSchema,
  type AgentEvent,
  type TeamRunDelivery,
  OpensteerError,
  type DeploymentId,
  type RunId,
  type ThreadId,
  type TeamAgentRequestId,
  type TeamTaskOrigin,
  type TeamMessageId,
  type UserId,
  type TeamAgentRequestState,
  type TeamAskDecision,
  type TeamAskOutcome,
} from "@opensteer/core";
import {
  PersonalTeamRequestSchema,
  PersonalTeamRequestMirrorSchema,
  type PersonalTeamRequestMirror,
  type PersonalTeamRequest,
} from "@opensteer/protocol";
import { sql, type Insertable, type Kysely, type Selectable } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { personalTeamReturnPost } from "./personal-team-return-provenance.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { appendHostDeploymentEvent, eventFromRow } from "./deployment-events.js";

export class PersonalTeamRequestsStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly #onPublished: ((taskId: ThreadId) => Promise<void>) | undefined;
  readonly #onDeliveryEvent: ((event: AgentEvent) => void) | undefined;
  constructor(
    database: Kysely<DatabaseSchema>,
    onPublished?: (taskId: ThreadId) => Promise<void>,
    onDeliveryEvent?: (event: AgentEvent) => void,
  ) {
    this.database = database;
    this.#onPublished = onPublished;
    this.#onDeliveryEvent = onDeliveryEvent;
  }

  async prunePosts() {
    await this.database
      .deleteFrom("personalTeamPosts")
      .where("createdAt", "<=", new Date(Date.now() - 14 * 86400000))
      .execute();
  }

  async pendingPosts(teamId: DeploymentId) {
    await this.prunePosts();
    return this.database
      .selectFrom("personalTeamPosts")
      .selectAll()
      .where("teamDeploymentId", "=", teamId)
      .where("messageId", "is", null)
      .execute();
  }

  async forgetPost(teamId: DeploymentId, clientMessageId: string, localLinkId: string) {
    await this.database
      .deleteFrom("personalTeamPosts")
      .where("teamDeploymentId", "=", teamId)
      .where("clientMessageId", "=", clientMessageId)
      .where("localLinkId", "=", localLinkId)
      .execute();
  }

  post(teamId: DeploymentId, clientMessageId: string) {
    return this.database
      .selectFrom("personalTeamPosts")
      .selectAll()
      .where("teamDeploymentId", "=", teamId)
      .where("clientMessageId", "=", clientMessageId)
      .executeTakeFirst();
  }

  async recordPost(
    input: Omit<Insertable<DatabaseSchema["personalTeamPosts"]>, "targetBindings"> & {
      readonly askOutcomes?: readonly TeamAskOutcome[] | undefined;
    },
  ) {
    const { askOutcomes, ...post } = input;
    const targetBindings = (askOutcomes ?? []).flatMap((ask) =>
      ask.outcome === "queued" &&
      ask.handle &&
      ask.requestId &&
      input.mentionedAgentHandles.includes(`${ask.handle}-agent`)
        ? [{ ownerUserId: ask.ownerUserId, handle: ask.handle, requestId: ask.requestId }]
        : [],
    );
    await this.prunePosts();
    await withPersonalTransaction(this.database, async (tx) => {
      await tx
        .insertInto("personalTeamPosts")
        .values({
          ...post,
          targetBindings: sql`${JSON.stringify(targetBindings)}::jsonb`,
          attachmentIds: sql`${JSON.stringify(input.attachmentIds)}::jsonb`,
        })
        .onConflict((conflict) =>
          conflict.columns(["teamDeploymentId", "clientMessageId"]).doNothing(),
        )
        .execute();
      const saved = await tx
        .selectFrom("personalTeamPosts")
        .selectAll()
        .where("teamDeploymentId", "=", input.teamDeploymentId)
        .where("clientMessageId", "=", input.clientMessageId)
        .executeTakeFirstOrThrow();
      if (
        saved.localLinkId !== input.localLinkId ||
        saved.remoteLinkId !== input.remoteLinkId ||
        saved.runId !== input.runId ||
        saved.channelId !== input.channelId ||
        saved.threadRootId !== input.threadRootId ||
        saved.requestId !== input.requestId ||
        saved.bodyMarkdown !== input.bodyMarkdown ||
        JSON.stringify(saved.attachmentIds) !== JSON.stringify(input.attachmentIds) ||
        JSON.stringify(saved.mentionedAgentHandles) !==
          JSON.stringify(input.mentionedAgentHandles) ||
        (saved.messageId !== null &&
          input.messageId !== null &&
          saved.messageId !== input.messageId)
      )
        throw new OpensteerError({ code: "conflict", message: "Team post identity changed." });
      if (input.messageId !== null) {
        if (!targetBindings.length) {
          await tx
            .deleteFrom("personalTeamPosts")
            .where("teamDeploymentId", "=", input.teamDeploymentId)
            .where("clientMessageId", "=", input.clientMessageId)
            .execute();
        } else
          await tx
            .updateTable("personalTeamPosts")
            .set({
              messageId: input.messageId,
              targetBindings: sql`${JSON.stringify(targetBindings)}::jsonb`,
            })
            .where("teamDeploymentId", "=", input.teamDeploymentId)
            .where("clientMessageId", "=", input.clientMessageId)
            .where("messageId", "is", null)
            .execute();
      }
    });
  }

  async mirror(teamId: DeploymentId, requestId: TeamAgentRequestId) {
    const row = await this.database
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", requestId)
      .executeTakeFirst();
    return row ? personalTeamRequestMirrorFromRow(row) : null;
  }

  async mirrors(teamId: DeploymentId) {
    await this.pruneReturns(teamId);
    const rows = await this.database
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("teamDeploymentId", "=", teamId)
      .where((eb) =>
        eb.or([
          eb("terminalState", "is", null),
          eb("publicationState", "=", "pending"),
          eb.and([
            eb("kind", "=", "return"),
            eb("remoteState", "in", ["queued", "working", "needs_you"]),
          ]),
        ]),
      )
      .orderBy("createdAt")
      .orderBy("requestId")
      .execute();
    return rows.map(personalTeamRequestMirrorFromRow);
  }

  async pruneReturns(teamId: DeploymentId) {
    await this.database
      .deleteFrom("personalTeamRequests")
      .where("teamDeploymentId", "=", teamId)
      .where("kind", "=", "return")
      .where((eb) =>
        eb.or([
          eb("createdAt", "<=", new Date(Date.now() - 14 * 86400000)),
          eb("finishedAt", "<=", new Date(Date.now() - 14 * 86400000)),
          eb(
            "requestId",
            "in",
            eb
              .selectFrom("personalTeamRequests")
              .select("requestId")
              .where("teamDeploymentId", "=", teamId)
              .where("kind", "=", "return")
              .where("terminalState", "is not", null)
              .orderBy("createdAt", "desc")
              .orderBy("requestId", "desc")
              .offset(128),
          ),
        ]),
      )
      .execute();
  }

  async observe(
    input: PersonalTeamRequestMirror & { readonly createdAt: string },
  ): Promise<boolean> {
    await this.pruneReturns(input.teamId);
    const rejected =
      input.kind === "return" && !(await personalTeamReturnPost(this.database, input));
    const returnPayload =
      rejected && input.returnPayload
        ? { ...input.returnPayload, bodyMarkdown: null, attachments: [] }
        : input.returnPayload;
    const saved = await this.database
      .insertInto("personalTeamRequests")
      .values({
        teamDeploymentId: input.teamId,
        requestId: input.requestId,
        kind: input.kind,
        remoteState: input.remoteState,
        presentation: input.presentation,
        returnPayload,
        consentExpiresAt: input.consentExpiresAt,
        localDecision: null,
        decisionAt: null,
        returnAdmission: rejected ? "undeliverable" : null,
        triggerMessageId: input.triggerMessageId,
        localTaskId: null,
        localInputId: null,
        runId: null,
        source: input.source,
        publicationState: rejected ? "blocked" : "pending",
        terminalState: rejected ? "done" : null,
        acceptedMessageId: null,
        createdAt: input.kind === "return" ? new Date() : input.createdAt,
        finishedAt: rejected ? new Date() : null,
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning("requestId")
      .executeTakeFirst();
    const current = await this.mirror(input.teamId, input.requestId);
    if (
      !current ||
      current.kind !== input.kind ||
      current.triggerMessageId !== input.triggerMessageId ||
      !isDeepStrictEqual(current.presentation, input.presentation) ||
      !isDeepStrictEqual(
        current.returnPayload,
        current.terminalState && input.returnPayload
          ? { ...input.returnPayload, bodyMarkdown: null, attachments: [] }
          : input.returnPayload,
      )
    )
      throw new OpensteerError({ code: "conflict", message: "Team request presentation changed" });
    await this.pruneReturns(input.teamId);
    return Boolean(saved);
  }

  async decide(
    ownerId: UserId,
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    decision: TeamAskDecision,
  ) {
    return withPersonalTransaction(this.database, async (tx) => {
      await requirePersonalOwner(tx, ownerId);
      const row = await tx
        .selectFrom("personalTeamRequests")
        .selectAll()
        .where("teamDeploymentId", "=", teamId)
        .where("requestId", "=", requestId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.kind !== "ask")
        throw new OpensteerError({ code: "not_found", message: "Pending team ask not found." });
      if (row.terminalState === "failed" && !row.localTaskId) {
        if (decision !== "decline")
          throw new OpensteerError({
            code: "conflict",
            message: row.blockedReason ?? "This team ask has ended.",
          });
        const saved = await tx
          .updateTable("personalTeamRequests")
          .set({ blockedReason: null })
          .where("teamDeploymentId", "=", teamId)
          .where("requestId", "=", requestId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return personalTeamRequestMirrorFromRow(saved);
      }
      if (row.localDecision) {
        if (row.localDecision !== decision)
          throw new OpensteerError({
            code: "conflict",
            message: "This team ask was already decided on another device.",
          });
        return personalTeamRequestMirrorFromRow(row);
      }
      if (
        row.remoteState !== "awaiting_approval" ||
        row.terminalState ||
        !row.consentExpiresAt ||
        row.consentExpiresAt <= new Date()
      )
        throw new OpensteerError({
          code: "conflict",
          message: "This team ask is no longer awaiting approval.",
        });
      const saved = await tx
        .updateTable("personalTeamRequests")
        .set({ localDecision: decision, decisionAt: new Date() })
        .where("teamDeploymentId", "=", teamId)
        .where("requestId", "=", requestId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return personalTeamRequestMirrorFromRow(saved);
    });
  }

  async failDecision(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    reason: string,
  ): Promise<void> {
    await withPersonalTransaction(this.database, async (tx) => {
      await tx
        .updateTable("personalTeamRequests")
        .set({
          terminalState: "failed",
          publicationState: "blocked",
          blockedReason: reason,
          finishedAt: new Date(),
        })
        .where("teamDeploymentId", "=", teamId)
        .where("requestId", "=", requestId)
        .where("kind", "=", "ask")
        .where("localTaskId", "is", null)
        .where("terminalState", "is", null)
        .execute();
    });
  }

  async remote(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    remoteState: TeamAgentRequestState,
  ) {
    await this.database
      .updateTable("personalTeamRequests")
      .set({ remoteState })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", requestId)
      .execute();
  }

  async get(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
  ): Promise<PersonalTeamRequest | null> {
    const row = await this.database
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("localTaskId", "is not", null)
      .where("localInputId", "is not", null)
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", requestId)
      .executeTakeFirst();
    return row ? this.#view(row) : null;
  }

  async record(input: PersonalTeamRequest): Promise<PersonalTeamRequest> {
    await this.database
      .insertInto("personalTeamRequests")
      .values({
        teamDeploymentId: input.teamId,
        requestId: input.requestId,
        kind: input.kind,
        remoteState: input.remoteState,
        presentation: input.presentation,
        returnPayload: input.returnPayload,
        consentExpiresAt: input.consentExpiresAt,
        localDecision: input.localDecision,
        decisionAt: input.decisionAt,
        returnAdmission: input.returnAdmission,
        triggerMessageId: input.triggerMessageId,
        localTaskId: input.taskId,
        localInputId: MessageIdSchema.parse(input.inputId),
        runId: input.runId,
        source: input.source,
        answerMessageId: input.answerMessageId,
        answerPayload: input.answerPayload,
        clientMessageId: input.clientMessageId,
        deliveryVia: input.deliveryVia,
        blockedReason: input.blockedReason,
        publicationState: input.publicationState,
        terminalState: input.terminalState,
        acceptedMessageId: input.replyMessageId,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      })
      .onConflict((conflict) => conflict.columns(["teamDeploymentId", "requestId"]).doNothing())
      .execute();
    const saved = await this.get(input.teamId, input.requestId);
    if (
      !saved ||
      saved.triggerMessageId !== input.triggerMessageId ||
      saved.inputId !== input.inputId ||
      saved.taskId !== input.taskId
    ) {
      throw new OpensteerError({ code: "conflict", message: "Team request input changed" });
    }
    return saved;
  }

  async forTeam(teamId: DeploymentId): Promise<PersonalTeamRequest[]> {
    const rows = await this.database
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("localTaskId", "is not", null)
      .where("localInputId", "is not", null)
      .where("teamDeploymentId", "=", teamId)
      .where((eb) =>
        eb.or([eb("publicationState", "=", "pending"), eb("terminalState", "is", null)]),
      )
      .orderBy("createdAt")
      .orderBy("requestId")
      .execute();
    return rows.map((row) => this.#view(row));
  }

  async forRun(runId: RunId): Promise<PersonalTeamRequest | null> {
    const run = await this.database
      .selectFrom("runs")
      .select(["replyTarget", "threadId"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (run?.replyTarget?.kind !== "team-thread") return null;
    const row = await this.database
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("localTaskId", "is not", null)
      .where("localInputId", "is not", null)
      .where("teamDeploymentId", "=", run.replyTarget.teamId)
      .where("requestId", "=", run.replyTarget.requestId)
      .where("localTaskId", "=", run.threadId)
      .executeTakeFirst();
    return row ? this.#view({ ...row, runId }) : null;
  }

  async terminal(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    runId: RunId | null,
    state: NonNullable<PersonalTeamRequest["terminalState"]>,
  ): Promise<void> {
    await withPersonalTransaction(this.database, async (tx) => {
      await tx
        .updateTable("personalTeamRequests")
        .set({
          runId,
          terminalState: state,
          returnPayload: sql`case when kind = 'return' then return_payload || '{"bodyMarkdown":null,"attachments":[]}'::jsonb else return_payload end`,
          finishedAt: new Date().toISOString(),
          publicationState: sql`case when local_task_id is null then 'blocked' else publication_state end`,
        })
        .where("teamDeploymentId", "=", teamId)
        .where("requestId", "=", requestId)
        .where("terminalState", "is", null)
        .execute();
    });
  }

  async freeze(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    input: {
      readonly runId: RunId;
      readonly via: "final" | "tool";
      readonly clientMessageId: string;
      readonly answerMessageId: PersonalTeamRequest["answerMessageId"];
      readonly payload: NonNullable<PersonalTeamRequest["answerPayload"]>;
    },
  ): Promise<PersonalTeamRequest> {
    const result = await this.#change(teamId, requestId, (row) =>
      row.answerPayload === null && row.publicationState === "pending"
        ? {
            runId: input.runId,
            answerPayload: input.payload,
            answerMessageId: input.answerMessageId,
            clientMessageId: input.clientMessageId,
            deliveryVia: input.via,
            explicitReply: input.via === "tool",
          }
        : null,
    );
    return result;
  }

  async clearFreeze(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    clientMessageId: string,
  ): Promise<void> {
    await this.#change(teamId, requestId, (row) =>
      row.publicationState === "pending" &&
      row.deliveryVia === "tool" &&
      row.clientMessageId === clientMessageId
        ? {
            answerPayload: null,
            answerMessageId: null,
            clientMessageId: null,
            deliveryVia: null,
            explicitReply: false,
          }
        : null,
    );
  }

  async publication(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    state: "accepted" | "blocked",
    messageId: PersonalTeamRequest["replyMessageId"] = null,
    reason: string | null = null,
  ): Promise<void> {
    const saved = await this.#change(teamId, requestId, (row) => {
      if (row.publicationState !== "pending") return null;
      return {
        publicationState: state,
        acceptedMessageId: messageId,
        blockedReason: state === "blocked" ? (reason ?? "The team request was cancelled.") : null,
      };
    });
    if (state === "accepted" && messageId !== null) await this.#onPublished?.(saved.taskId);
  }

  async #change(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    change: (
      row: Selectable<DatabaseSchema["personalTeamRequests"]>,
    ) => import("kysely").Updateable<DatabaseSchema["personalTeamRequests"]> | null,
  ): Promise<PersonalTeamRequest> {
    const result = await withPersonalTransaction(this.database, async (tx) => {
      const observed = await tx
        .selectFrom("personalTeamRequests")
        .selectAll()
        .where("teamDeploymentId", "=", teamId)
        .where("requestId", "=", requestId)
        .executeTakeFirstOrThrow();
      if (!observed.localTaskId || !observed.localInputId)
        throw new OpensteerError({
          code: "conflict",
          message: "Team request has no admitted input",
        });
      const run = await tx
        .selectFrom("runs")
        .select(["id", "threadId", "environmentId"])
        .where("threadId", "=", observed.localTaskId)
        .where("seedInputId", "=", observed.localInputId)
        .where(sql<string>`reply_target->>'requestId'`, "=", requestId)
        .where(sql<string>`reply_target->>'teamId'`, "=", teamId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const row = await tx
        .selectFrom("personalTeamRequests")
        .selectAll()
        .where("teamDeploymentId", "=", teamId)
        .where("requestId", "=", requestId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const patch = change(row);
      if (!patch) return { saved: this.#view(row), event: null };
      const saved = await tx
        .updateTable("personalTeamRequests")
        .set(patch)
        .where("teamDeploymentId", "=", teamId)
        .where("requestId", "=", requestId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const delivery: TeamRunDelivery = {
        state:
          saved.publicationState === "accepted"
            ? "sent"
            : saved.publicationState === "blocked"
              ? "blocked"
              : "sending",
        via: saved.deliveryVia ?? (saved.explicitReply ? "tool" : "final"),
        answerMessageId: saved.answerMessageId,
        teamMessageId: saved.acceptedMessageId,
        reason: saved.blockedReason,
      };
      const event = run
        ? await appendHostDeploymentEvent(tx, {
            type: "run.delivery-updated",
            runId: run.id,
            threadId: run.threadId,
            environmentId: run.environmentId,
            data: { delivery },
          })
        : null;
      return { saved: this.#view(saved), event };
    });
    if (result.event) this.#onDeliveryEvent?.(result.event);
    return result.saved;
  }

  async replyTask(
    ownerId: UserId,
    input: TeamTaskOrigin & { readonly replyMessageId: TeamMessageId },
  ) {
    return this.database.transaction().execute(async (tx) => {
      await requirePersonalOwner(tx, ownerId);
      const empty = { taskId: null, completedAt: null };
      const request = await tx
        .selectFrom("personalTeamRequests as p")
        .innerJoin("threads as t", "t.id", "p.localTaskId")
        .innerJoin("runs as r", (join) =>
          join
            .onRef("r.threadId", "=", "p.localTaskId")
            .onRef("r.seedInputId", "=", "p.localInputId")
            .on(
              sql<boolean>`r.reply_target->>'requestId' = p.request_id and r.reply_target->>'teamId' = p.team_deployment_id and r.reply_target->>'kind' = 'team-thread'`,
            ),
        )
        .select(["t.id as taskId", "r.id as runId", "r.completedAt"])
        .where("t.createdBy", "=", ownerId)
        .where("t.teamId", "=", input.teamId)
        .where("t.channelId", "=", input.channelId)
        .where("t.threadRootId", "=", input.threadRootId)
        .where("p.teamDeploymentId", "=", input.teamId)
        .where("p.acceptedMessageId", "=", input.replyMessageId)
        .where("p.publicationState", "=", "accepted")
        .where("p.explicitReply", "=", false)
        .where("r.status", "=", "completed")
        .executeTakeFirst();
      if (!request) return empty;
      const row = await tx
        .selectFrom("deploymentEvents")
        .selectAll()
        .where("runId", "=", request.runId)
        .where("type", "=", "run.completed")
        .orderBy("sequence", "desc")
        .executeTakeFirst();
      const event = row ? eventFromRow(row) : null;
      if (event?.type !== "run.completed" || !event.data.replyMessageId) return empty;
      const message = await tx
        .selectFrom("messages")
        .select("sequence")
        .where("id", "=", event.data.replyMessageId)
        .where("runId", "=", request.runId)
        .where("threadId", "=", request.taskId)
        .where("kind", "=", "assistant")
        .where("addressedToUserId", "is", null)
        .executeTakeFirst();
      return message
        ? { taskId: request.taskId, completedAt: request.completedAt!.toISOString() }
        : empty;
    });
  }

  #view(row: Selectable<DatabaseSchema["personalTeamRequests"]>): PersonalTeamRequest {
    return PersonalTeamRequestSchema.parse(personalTeamRequestMirrorFromRow(row));
  }
}

export function personalTeamRequestMirrorFromRow(
  row: Selectable<DatabaseSchema["personalTeamRequests"]>,
): PersonalTeamRequestMirror {
  return PersonalTeamRequestMirrorSchema.parse({
    teamId: row.teamDeploymentId,
    requestId: row.requestId,
    kind: row.kind,
    remoteState: row.remoteState,
    presentation: row.presentation,
    returnPayload: row.returnPayload,
    consentExpiresAt: row.consentExpiresAt?.toISOString() ?? null,
    localDecision: row.localDecision,
    decisionAt: row.decisionAt?.toISOString() ?? null,
    returnAdmission: row.returnAdmission,
    triggerMessageId: row.triggerMessageId,
    taskId: row.localTaskId,
    inputId: row.localInputId,
    runId: row.runId,
    publicationState: row.publicationState,
    terminalState: row.terminalState,
    replyMessageId: row.acceptedMessageId,
    source: row.source,
    answerMessageId: row.answerMessageId,
    answerPayload: row.answerPayload,
    clientMessageId: row.clientMessageId,
    deliveryVia: row.deliveryVia,
    blockedReason: row.blockedReason,
  });
}
