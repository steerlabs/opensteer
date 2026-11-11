import {
  OpensteerError,
  nonTerminalRunStatuses,
  type AgentEvent,
  type MessageId,
  type RequestId,
  type RunId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { sql, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { RequestLockSetChanged } from "./request-workspace-locks.js";
import { ProjectWorkStopStore, reserveProjectWorkStop } from "./run-finalization.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { projectThreadState } from "./thread-status.js";
import { threadInputFromRow } from "./thread-row-mappers.js";

export type ProjectWorkRevocationRoot =
  | { readonly kind: "member"; readonly userId: UserId; readonly memberGenerationCutoff: number }
  | {
      readonly kind: "membership";
      readonly userId: UserId;
      readonly workspaceId: WorkspaceId;
      readonly membershipGenerationCutoff: number;
    }
  | {
      readonly kind: "connection";
      readonly userId: UserId;
      readonly workspaceId: WorkspaceId;
      readonly connectionId: string;
      readonly memberGenerationCutoff: number;
      readonly membershipGenerationCutoff: number;
    };

export interface ProjectWorkRevocationScope {
  readonly runIds: readonly RunId[];
  readonly workspaceIds: readonly WorkspaceId[];
}

/** Q supplies projectRequestRevocationHooks(requests, the same workStopPort). */
export interface ProjectRequestRevocationHooks {
  discover(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly ProjectWorkRevocationRoot[],
  ): Promise<ProjectWorkRevocationScope>;
  cancel(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly ProjectWorkRevocationRoot[],
  ): Promise<void>;
}

export interface PlannedManagerlessRequestHooks {
  discover(
    transaction: Transaction<DatabaseSchema>,
    workspaceIds: readonly WorkspaceId[],
  ): Promise<ProjectWorkRevocationScope>;
  /** The writer established final eligibility; this must not read the old users row. */
  cancelPlanned(
    transaction: Transaction<DatabaseSchema>,
    workspaceIds: readonly WorkspaceId[],
  ): Promise<void>;
}

type Scope = ProjectWorkRevocationScope & {
  readonly activeRunIds: readonly RunId[];
  readonly continuationIds: readonly RequestId[];
  readonly managerlessRunIds: readonly RunId[];
  readonly inputIds: readonly MessageId[];
  readonly threadIds: readonly import("@opensteer/core").ThreadId[];
};

/** Inclusive selectors apply only to the immutable root on the work, never current person state. */
export function projectRevocationRootPredicate(
  roots: readonly ProjectWorkRevocationRoot[],
  table: "runs" | "threadInputs",
) {
  const column = (name: string) => sql.ref(`${table}.${name}`);
  const predicates = roots.map((root) => {
    const cutoffs = [
      ...(root.kind !== "membership" ? [root.memberGenerationCutoff] : []),
      ...(root.kind !== "member" ? [root.membershipGenerationCutoff] : []),
    ];
    if (cutoffs.some((cutoff) => !Number.isSafeInteger(cutoff) || cutoff < 1))
      throw new OpensteerError({ code: "bad_request", message: "Invalid captured root cutoff" });
    return sql<boolean>`(${sql.join(
      [
        sql`${column("requestedBy")} = ${root.userId}`,
        ...(root.kind !== "membership"
          ? [sql`${column("initiatorGeneration")} <= ${String(root.memberGenerationCutoff)}`]
          : []),
        ...(root.kind !== "member"
          ? [
              sql`threads.workspace_id = ${root.workspaceId}`,
              sql`${column("membershipGeneration")} <= ${String(root.membershipGenerationCutoff)}`,
            ]
          : []),
        ...(root.kind === "connection"
          ? [sql`${column("originConnectionId")} = ${root.connectionId}`]
          : []),
      ],
      sql` and `,
    )})`;
  });
  return predicates.length
    ? sql<boolean>`(${sql.join(predicates, sql` or `)})`
    : sql<boolean>`false`;
}

export class ProjectWorkRevocationStore implements ProjectRequestRevocationHooks {
  readonly requests: ProjectRequestRevocationHooks;
  readonly work: ProjectWorkStopStore;
  readonly plannedManagerless: (transaction: Transaction<DatabaseSchema>) => readonly WorkspaceId[];
  readonly managerlessRequests: PlannedManagerlessRequestHooks | undefined;
  private readonly discovered = new WeakMap<Transaction<DatabaseSchema>, Scope>();

  constructor(input: {
    readonly requests: ProjectRequestRevocationHooks;
    readonly work: ProjectWorkStopStore;
    readonly plannedManagerless?: ProjectWorkRevocationStore["plannedManagerless"];
    readonly managerlessRequests?: PlannedManagerlessRequestHooks;
  }) {
    this.requests = input.requests;
    this.work = input.work;
    this.plannedManagerless = input.plannedManagerless ?? (() => []);
    this.managerlessRequests = input.managerlessRequests;
  }

  private async scope(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly ProjectWorkRevocationRoot[],
  ): Promise<Scope> {
    await assertProjectAuthority(transaction);
    const planned = [...new Set(this.plannedManagerless(transaction))].sort();
    if (planned.length && !this.managerlessRequests)
      throw new OpensteerError({
        code: "conflict",
        message: "Planned managerless cancellation requires Q's final-plan Request hook",
      });
    const active = roots.length
      ? await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
          .select(["runs.id", "runs.threadId", "threads.workspaceId"])
          .where("principals.kind", "=", "project")
          .whereRef("principals.workspaceId", "=", "threads.workspaceId")
          .where("runs.status", "in", nonTerminalRunStatuses)
          .where(projectRevocationRootPredicate(roots, "runs"))
          .execute()
      : [];
    const inputs = roots.length
      ? await transaction
          .selectFrom("threadInputs")
          .innerJoin("threads", "threads.id", "threadInputs.threadId")
          .innerJoin("principals", "principals.id", "threadInputs.actorPrincipalId")
          .select([
            "threadInputs.messageId",
            "threadInputs.runId",
            "threads.id",
            "threads.workspaceId",
          ])
          .where("principals.kind", "=", "project")
          .whereRef("principals.workspaceId", "=", "threads.workspaceId")
          .where("threadInputs.state", "in", ["pending", "claimed", "unknown"])
          .where(projectRevocationRootPredicate(roots, "threadInputs"))
          .execute()
      : [];
    const continuations =
      roots.length || planned.length
        ? await transaction
            .selectFrom("requestContinuations")
            .innerJoin("requests", "requests.id", "requestContinuations.requestId")
            .innerJoin("runs", "runs.id", "requests.originatingRunId")
            .innerJoin("threads", "threads.id", "runs.threadId")
            .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
            .select([
              "requestContinuations.requestId",
              "runs.id",
              "runs.requestedBy",
              "threads.workspaceId",
            ])
            .where("principals.kind", "=", "project")
            .whereRef("principals.workspaceId", "=", "threads.workspaceId")
            .where("requestContinuations.status", "in", ["waiting", "queued"])
            .where((eb) =>
              eb.or([
                projectRevocationRootPredicate(roots, "runs"),
                ...(planned.length
                  ? [
                      eb.and([
                        eb("runs.requestedBy", "is", null),
                        eb("threads.workspaceId", "in", planned),
                      ]),
                    ]
                  : []),
              ]),
            )
            .execute()
        : [];
    const requests = await this.requests.discover(transaction, roots);
    const managerless =
      planned.length && this.managerlessRequests
        ? await this.managerlessRequests.discover(transaction, planned)
        : { runIds: [], workspaceIds: [] };
    const runIds = [
      ...new Set([
        ...active.map((row) => row.id),
        ...inputs.flatMap((row) => (row.runId ? [row.runId] : [])),
        ...continuations.map((row) => row.id),
        ...requests.runIds,
        ...managerless.runIds,
      ]),
    ].sort();
    const runs = runIds.length
      ? await transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select(["threads.id", "threads.workspaceId"])
          .where("runs.id", "in", runIds)
          .execute()
      : [];
    return {
      runIds,
      workspaceIds: [
        ...new Set([
          ...runs.map((row) => row.workspaceId),
          ...inputs.map((row) => row.workspaceId),
          ...requests.workspaceIds,
          ...managerless.workspaceIds,
          ...planned,
        ]),
      ].sort(),
      activeRunIds: active.map((row) => row.id).sort(),
      continuationIds: continuations.map((row) => row.requestId).sort(),
      managerlessRunIds: [
        ...new Set(continuations.filter((row) => row.requestedBy === null).map((row) => row.id)),
      ].sort(),
      inputIds: inputs.map((row) => row.messageId).sort(),
      threadIds: [
        ...new Set([...runs.map((row) => row.id), ...inputs.map((row) => row.id)]),
      ].sort(),
    };
  }

  async discover(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly ProjectWorkRevocationRoot[],
  ): Promise<ProjectWorkRevocationScope> {
    const scope = await this.scope(transaction, roots);
    this.discovered.set(transaction, scope);
    return { runIds: scope.runIds, workspaceIds: scope.workspaceIds };
  }

  async cancel(
    transaction: Transaction<DatabaseSchema>,
    roots: readonly ProjectWorkRevocationRoot[],
  ): Promise<void> {
    const before = this.discovered.get(transaction);
    const scope = await this.scope(transaction, roots);
    if (
      !before ||
      scope.runIds.some((id) => !before.runIds.includes(id)) ||
      scope.workspaceIds.some((id) => !before.workspaceIds.includes(id))
    )
      throw new RequestLockSetChanged(scope.workspaceIds);
    // The authority writer already holds the complete sorted Run and Workspace prefix.
    if (scope.continuationIds.length) {
      await transaction
        .selectFrom("requestContinuations")
        .select("requestId")
        .where("requestId", "in", [...scope.continuationIds])
        .orderBy("requestId")
        .forNoKeyUpdate()
        .execute();
    }
    await reserveProjectWorkStop(transaction, scope);
    await this.requests.cancel(transaction, roots);
    await this.work.stop(transaction, {
      runIds: scope.activeRunIds,
      reason: "authority-revoked",
      requestEvents: [],
    });
    const planned = [...new Set(this.plannedManagerless(transaction))].sort();
    if (planned.length && this.managerlessRequests)
      await this.managerlessRequests.cancelPlanned(transaction, planned);
    if (scope.managerlessRunIds.length)
      await this.work.stop(transaction, {
        runIds: scope.managerlessRunIds,
        reason: "no-eligible-manager",
        requestEvents: [],
      });
    if (scope.continuationIds.length)
      await transaction
        .updateTable("requestContinuations")
        .set({
          status: "undeliverable",
          reason: "execution-authority-unavailable",
          attemptedAt: new Date(),
          updatedAt: new Date(),
        })
        .where("requestId", "in", [...scope.continuationIds])
        .where("status", "in", ["waiting", "queued"])
        .execute();
    const events: AgentEvent[] = [];
    if (scope.inputIds.length) {
      const inputs = await transaction
        .updateTable("threadInputs")
        .set({
          state: "cancelled",
          cancelReason: "execution-authority-unavailable",
          updatedAt: new Date(),
        })
        .where("messageId", "in", [...scope.inputIds])
        .where("state", "in", ["pending", "claimed", "unknown"])
        .returningAll()
        .execute();
      for (const input of inputs) {
        const thread = await transaction
          .selectFrom("threads")
          .select(["workspaceId", "environmentId"])
          .where("id", "=", input.threadId)
          .executeTakeFirstOrThrow();
        events.push(
          await appendHostWorkspaceEvent(transaction, {
            type: "thread-input.updated",
            data: { input: threadInputFromRow(input) },
            ...thread,
            threadId: input.threadId,
            runId: input.runId,
          }),
        );
      }
    }
    for (const threadId of scope.threadIds)
      events.push(...(await projectThreadState(transaction, threadId)));
    this.work.collectEvents(transaction, events);
  }
}
