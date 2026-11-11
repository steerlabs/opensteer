import {
  OpensteerError,
  RunIdSchema,
  type AgentEvent,
  type EnvironmentId,
  type RunnerId,
  type RunId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { TransactionScopeChanged, withDatabaseTransaction } from "./connection.js";
import { projectOriginFromRow, projectWorkIsCurrent } from "./execution-authority.js";
import { ProjectRuntimeSnapshotSchema } from "./project-runtime-settings-store.js";
import { reserveProjectRuntime, fenceProjectHumanRoot } from "./project-work-store.js";
import {
  cancelProjectRunRequests,
  finalizeProjectRunTransaction,
  reserveProjectWorkStop,
  type ProjectRunRequestCancellation,
} from "./run-finalization.js";
import { recoverRunTransaction } from "./run-recovery.js";
import { projectAssignmentEventsInTransaction } from "./assignment-store.js";
import { threadPathLinks } from "./store-primitives.js";

export class ProjectRunRecoveryStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly dependencies: {
    readonly currentRunner: (
      environmentId: EnvironmentId,
    ) => { readonly runnerId: RunnerId; readonly runnerBootId: string } | null;
    readonly cancelRequests?: ProjectRunRequestCancellation | undefined;
    readonly publish: (events: readonly AgentEvent[]) => void;
  };
  constructor(
    database: Kysely<DatabaseSchema>,
    dependencies: ProjectRunRecoveryStore["dependencies"],
  ) {
    this.database = database;
    this.dependencies = dependencies;
  }

  async recover(input: {
    readonly runId: RunId;
    readonly expectedBindingGeneration: number | null;
  }): Promise<{ readonly state: "recovered" | "cancelled" | "unavailable" }> {
    RunIdSchema.parse(input.runId);
    await assertProjectAuthority(this.database);
    const outcome = await withDatabaseTransaction(
      this.database,
      async (transaction) => {
        const observed = await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
          .selectAll("runs")
          .select([
            "threads.workspaceId",
            "principals.kind as principalKind",
            "principals.workspaceId as principalWorkspaceId",
          ])
          .where("runs.id", "=", input.runId)
          .executeTakeFirst();
        const unavailable = { state: "unavailable" as const, events: [] as readonly AgentEvent[] };
        if (
          !observed ||
          observed.principalKind !== "project" ||
          observed.principalWorkspaceId !== observed.workspaceId
        )
          return unavailable;
        const origin = projectOriginFromRow(observed);
        if (origin?.originConnectionId)
          await transaction
            .selectFrom("agentConnections")
            .select("id")
            .where("id", "=", origin.originConnectionId)
            .forShare()
            .execute();
        const reserved = await transaction
          .selectFrom("runs")
          .selectAll()
          .where("threadId", "=", observed.threadId)
          .where((eb) =>
            eb.or([
              eb("id", "=", input.runId),
              eb("status", "in", ["queued", "starting", "running", "waiting"]),
            ]),
          )
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const run = reserved.find((row) => row.id === input.runId);
        if (
          !run ||
          run.bindingGeneration !== input.expectedBindingGeneration ||
          !["starting", "running", "waiting"].includes(run.status)
        )
          return unavailable;
        if (run.authoritySource.kind === "trigger-occurrence") {
          const { TriggerOccurrenceIdSchema } = await import("@opensteer/core");
          await transaction
            .selectFrom("triggerOccurrences")
            .select("id")
            .where("id", "=", TriggerOccurrenceIdSchema.parse(run.authoritySource.occurrenceId))
            .forShare()
            .execute();
        }
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", observed.workspaceId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        const currentRuns = await transaction
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", run.threadId)
          .where("status", "in", ["queued", "starting", "running", "waiting"])
          .execute();
        if (currentRuns.some((row) => !reserved.some((held) => held.id === row.id)))
          throw new TransactionScopeChanged();
        const sourceCurrent = await projectWorkIsCurrent(transaction, run);
        const peer = this.dependencies.currentRunner(run.environmentId);
        if (sourceCurrent) {
          if (!peer) return unavailable;
          const snapshot = ProjectRuntimeSnapshotSchema.parse(run.authoritySource.projectRuntime);
          try {
            await reserveProjectRuntime(
              transaction,
              observed.workspaceId,
              origin,
              (runnerId) => runnerId === peer.runnerId,
              snapshot,
            );
          } catch (error) {
            if (error instanceof OpensteerError) return unavailable;
            throw error;
          }
        }
        const session = await transaction
          .selectFrom("providerSessions")
          .selectAll()
          .where("id", "=", run.providerSessionId)
          .executeTakeFirst();
        if (
          sourceCurrent &&
          session &&
          peer &&
          session.runnerId === peer.runnerId &&
          session.runnerBootId === peer.runnerBootId &&
          session.leaseExpiresAt &&
          session.leaseExpiresAt.getTime() > Date.now()
        )
          return unavailable;
        await reserveProjectWorkStop(transaction, {
          runIds: reserved.map((row) => row.id),
          workspaceIds: [observed.workspaceId],
        });
        const failure = {
          code: "runner_restarted",
          message: "The Project execution binding was lost",
          retryable: false,
          status: "failed" as const,
        };
        const result = await recoverRunTransaction(
          transaction,
          { runId: run.id, now: new Date(), failure, links: threadPathLinks },
          {
            authorityIsCurrent: async (tx, row) => {
              const thread = await tx
                .selectFrom("threads")
                .select("status")
                .where("id", "=", row.threadId)
                .executeTakeFirst();
              return thread?.status !== "archived" && (await projectWorkIsCurrent(tx, row));
            },
            finalize: (tx, finalization) =>
              finalizeProjectRunTransaction(tx, {
                ...finalization,
                cancelRequests: this.dependencies.cancelRequests,
              }),
            cancelRequests: () =>
              cancelProjectRunRequests(
                transaction,
                { runId: run.id, reason: "process-lost", resolvedAt: new Date() },
                this.dependencies.cancelRequests,
              ),
            fenceAuthority: async () => {
              if (origin) await fenceProjectHumanRoot(transaction, origin);
            },
            retireCommands: async () => {
              await transaction
                .updateTable("commands")
                .set({
                  status: "failed",
                  lastError: {
                    code: "project_binding_lost",
                    message: "Project execution binding was retired for recovery",
                  },
                  updatedAt: new Date(),
                })
                .where("runId", "=", run.id)
                .where((eb) =>
                  eb.or([
                    eb.and([
                      eb("type", "=", "run.execute.project"),
                      eb("status", "in", ["pending", "dispatched", "unknown"]),
                    ]),
                    eb.and([
                      eb("type", "=", "run.control.project"),
                      eb("status", "in", ["pending", "dispatched"]),
                    ]),
                  ]),
                )
                .execute();
            },
            messageAuthority: (row) => ({
              actorPrincipalId: row.actorPrincipalId,
              requestedBy: row.requestedBy,
              membershipGeneration: row.membershipGeneration,
              initiatorGeneration: row.initiatorGeneration,
              originConnectionId: row.originConnectionId,
              authoritySource: row.authoritySource,
            }),
            commandAuthority: (row) => ({
              type: "run.execute.project",
              membershipGeneration: row.membershipGeneration,
              initiatorGeneration: row.initiatorGeneration,
              originConnectionId: row.originConnectionId,
            }),
            assignmentActivity: async (tx, runId) => {
              const assignments = await tx
                .selectFrom("delegations")
                .selectAll()
                .where("childRunId", "=", runId)
                .where("status", "=", "open")
                .orderBy("id")
                .execute();
              const events: AgentEvent[] = [];
              for (const assignment of assignments)
                events.push(
                  ...(await projectAssignmentEventsInTransaction(
                    tx,
                    assignment,
                    "assignment.updated",
                    runId,
                  )),
                );
              return events;
            },
          },
        );
        return {
          state:
            result.status === "recovered"
              ? ("recovered" as const)
              : result.status === "terminal"
                ? ("cancelled" as const)
                : ("unavailable" as const),
          events: result.events,
        };
      },
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
    this.dependencies.publish(outcome.events);
    return { state: outcome.state };
  }
}
