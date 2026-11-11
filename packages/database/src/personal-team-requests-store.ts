import {
  MessageIdSchema,
  OpensteerError,
  type DeploymentId,
  type RunId,
  type TeamAgentRequestId,
} from "@opensteer/core";
import { PersonalTeamRequestSchema, type PersonalTeamRequest } from "@opensteer/protocol";
import type { Kysely, Selectable } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export class PersonalTeamRequestsStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
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
    await this.database
      .updateTable("personalTeamRequests")
      .set({ publicationState: state, acceptedMessageId: messageId })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", requestId)
      .execute();
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
