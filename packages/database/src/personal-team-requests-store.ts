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
} from "@opensteer/core";
import { PersonalTeamRequestSchema, type PersonalTeamRequest } from "@opensteer/protocol";
import { sql, type Kysely, type Selectable } from "kysely";
import type { DatabaseSchema } from "./schema.js";
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

  async get(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
  ): Promise<PersonalTeamRequest | null> {
    const row = await this.database
      .selectFrom("personalTeamRequests")
      .selectAll()
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
    if (run?.replyTarget?.kind !== "team") return null;
    const row = await this.database
      .selectFrom("personalTeamRequests")
      .selectAll()
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
    await this.database
      .updateTable("personalTeamRequests")
      .set({ runId, terminalState: state, finishedAt: new Date().toISOString() })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", requestId)
      .where("terminalState", "is", null)
      .execute();
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
              sql<boolean>`r.reply_target->>'requestId' = p.request_id and r.reply_target->>'teamId' = p.team_deployment_id and r.reply_target->>'kind' = 'team'`,
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
    return PersonalTeamRequestSchema.parse({
      teamId: row.teamDeploymentId,
      requestId: row.requestId,
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
}
