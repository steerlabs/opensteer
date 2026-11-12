import {
  MessageIdSchema,
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
import type { Kysely, Selectable } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { eventFromRow } from "./deployment-events.js";

export class PersonalTeamRequestsStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly #onPublished: ((taskId: ThreadId) => Promise<void>) | undefined;
  constructor(database: Kysely<DatabaseSchema>, onPublished?: (taskId: ThreadId) => Promise<void>) {
    this.database = database;
    this.#onPublished = onPublished;
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
      .where("publicationState", "=", "pending")
      .orderBy("createdAt")
      .orderBy("requestId")
      .execute();
    return rows.map((row) => this.#view(row));
  }

  async forRun(runId: RunId): Promise<PersonalTeamRequest | null> {
    const run = await this.database
      .selectFrom("runs")
      .select(["teamRequestId", "threadId"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!run?.teamRequestId) return null;
    const row = await this.database
      .selectFrom("personalTeamRequests")
      .selectAll()
      .where("requestId", "=", run.teamRequestId)
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

  async publication(
    teamId: DeploymentId,
    requestId: TeamAgentRequestId,
    state: "accepted" | "blocked",
    messageId: PersonalTeamRequest["replyMessageId"] = null,
  ): Promise<void> {
    const request = await this.database
      .updateTable("personalTeamRequests")
      .set({ publicationState: state, acceptedMessageId: messageId })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", requestId)
      .returning("localTaskId")
      .executeTakeFirst();
    if (request && state === "accepted" && messageId !== null)
      await this.#onPublished?.(request.localTaskId);
  }

  async prepareExplicitReply(teamId: DeploymentId, requestId: TeamAgentRequestId): Promise<void> {
    // Persist before sending: even a lost receipt must never attribute this reply to a later final.
    await this.database
      .updateTable("personalTeamRequests")
      .set({ explicitReply: true })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", requestId)
      .execute();
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
            .onRef("r.teamRequestId", "=", "p.requestId"),
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
    });
  }
}
