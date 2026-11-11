import { type Kysely } from "kysely";
import {
  CommandIdSchema,
  RunnerIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerWatchActivationIdSchema,
  nonTerminalRunStatuses,
  threadReportBatchMaxEntries,
  threadReportBatchMaxSerializedBytes,
  type RunnerId,
  type AgentEvent,
  type MessageId,
} from "@opensteer/core";
import { HarnessInstanceCatalogSchema, runExecuteInputsMax } from "@opensteer/protocol";
import {
  assertActiveProjectBinding,
  readProjectRunBinding,
  projectWorkIsCurrent,
} from "./execution-authority.js";
import {
  projectExchangeFromRow,
  projectExchangeKey,
  reserveProjectRuntime,
} from "./project-work-store.js";
import { ProjectRuntimeSnapshotSchema } from "./project-runtime-settings-store.js";
import { TransactionScopeChanged, withDatabaseTransaction } from "./connection.js";
import { freezeRunInitialContext } from "./thread-inbox.js";
import { messageFromRow, threadInputFromRow } from "./thread-row-mappers.js";
import { issueRunGrant } from "./run-grants.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { projectThreadState } from "./thread-status.js";
import { type RunRow, type ThreadRow } from "./schema.js";
import { projectOriginFromRow } from "./execution-authority.js";
import {
  createId,
  OpensteerError,
  ProjectRunBindingSchema,
  type ProjectRunBinding,
} from "@opensteer/core";
import { PrincipalIdSchema } from "@opensteer/channel-core";
import { ProjectRunControlSchema, type ProjectRunControl } from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { jsonValue, lockWorkspaceRow } from "./store-primitives.js";
import type { DatabaseSchema } from "./schema.js";

export interface ProjectRequestControlPort {
  find(
    transaction: Transaction<DatabaseSchema>,
    input: { readonly binding: ProjectRunBinding; readonly idempotencyKey: string },
  ): Promise<ProjectRunControl | null>;
  enqueue(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly binding: ProjectRunBinding;
      readonly idempotencyKey: string;
      readonly control: ProjectRunControl;
    },
  ): Promise<{ readonly created: boolean }>;
}

export const StoredProjectControlSchema = z.strictObject({
  binding: ProjectRunBindingSchema,
  control: ProjectRunControlSchema,
  correlationId: z.string().uuid(),
});

function controlIdentity(binding: ProjectRunBinding, idempotencyKey: string): string {
  if (!idempotencyKey || idempotencyKey.includes("\0") || Buffer.byteLength(idempotencyKey) > 4096)
    throw new OpensteerError({
      code: "bad_request",
      message: "Project control identity is invalid",
    });
  return `project-control:${createHash("sha256")
    .update(canonicalJson(["project-control-v1", binding, idempotencyKey]))
    .digest("hex")}`;
}

function controlConflict(): never {
  throw new OpensteerError({
    code: "conflict",
    reason: "idempotency-conflict",
    message: "Project control identity was reused with different content",
  });
}

/** The caller reserves the Run before Workspace/Request fences; enqueue never contacts a Runner. */
export class ProjectExecutionStore implements ProjectRequestControlPort {
  async find(
    transaction: Transaction<DatabaseSchema>,
    input: { readonly binding: ProjectRunBinding; readonly idempotencyKey: string },
  ): Promise<ProjectRunControl | null> {
    const binding = ProjectRunBindingSchema.parse(input.binding);
    await assertProjectAuthority(transaction);
    const row = await transaction
      .selectFrom("commands")
      .select("payload")
      .where(
        "actorPrincipalId",
        "=",
        PrincipalIdSchema.parse(binding.authority.principal.principalId),
      )
      .where("idempotencyKey", "=", controlIdentity(binding, input.idempotencyKey))
      .where("type", "=", "run.control.project")
      .executeTakeFirst();
    if (!row) return null;
    const stored = StoredProjectControlSchema.parse(row.payload);
    if (!isDeepStrictEqual(stored.binding, binding)) controlConflict();
    return stored.control;
  }

  async enqueue(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly binding: ProjectRunBinding;
      readonly idempotencyKey: string;
      readonly control: ProjectRunControl;
    },
  ): Promise<{ readonly created: boolean }> {
    const binding = ProjectRunBindingSchema.parse(input.binding);
    const control = ProjectRunControlSchema.parse(input.control);
    const prior = await this.find(transaction, { binding, idempotencyKey: input.idempotencyKey });
    if (prior) {
      if (!isDeepStrictEqual(prior, control)) controlConflict();
      return { created: false };
    }
    const run = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
      .innerJoin("grants", "grants.runId", "runs.id")
      .select([
        "runs.id",
        "runs.threadId",
        "runs.environmentId",
        "runs.actorPrincipalId",
        "runs.authoritySource",
        "runs.requestedBy",
        "runs.membershipGeneration",
        "runs.initiatorGeneration",
        "runs.originConnectionId",
        "runs.status",
        "runs.bindingGeneration as currentBindingGeneration",
        "threads.workspaceId",
        "principals.kind as principalKind",
        "principals.workspaceId as principalWorkspaceId",
        "grants.id as grantId",
        "grants.bindingGeneration",
        "grants.runnerId",
        "grants.runnerBootId",
        "grants.status as grantStatus",
      ])
      .where("runs.id", "=", binding.runId)
      .where("grants.id", "=", binding.grantId)
      .forNoKeyUpdate("runs")
      .executeTakeFirst();
    if (!run || run.principalKind !== "project" || run.principalWorkspaceId !== run.workspaceId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Project control binding is unavailable",
      });
    const origin = projectOriginFromRow(run);
    const durable = ProjectRunBindingSchema.parse({
      authority: {
        version: 1,
        principal: {
          kind: "project",
          workspaceId: run.workspaceId,
          principalId: run.actorPrincipalId,
        },
        origin,
      },
      bindingGeneration: run.bindingGeneration,
      environmentId: run.environmentId,
      grantId: run.grantId,
      runId: run.id,
      runnerBootId: run.runnerBootId,
      runnerId: run.runnerId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    if (!isDeepStrictEqual(durable, binding))
      throw new OpensteerError({
        code: "forbidden",
        message: "Project control binding does not match its stored origin",
      });
    await lockWorkspaceRow(transaction, run.workspaceId);
    const stopping = control.kind === "run.interrupt" || control.kind === "request.refuse";
    if (!stopping) {
      const live = await sql<{ valid: boolean }>`select public.opensteer_project_work_is_valid(
        ${run.threadId}, ${run.actorPrincipalId}, ${run.requestedBy}, ${run.membershipGeneration},
        ${run.initiatorGeneration}, ${run.originConnectionId}, ${jsonValue(run.authoritySource)}
      ) as valid`.execute(transaction);
      if (
        run.currentBindingGeneration !== binding.bindingGeneration ||
        run.grantStatus !== "active" ||
        !["starting", "running", "waiting"].includes(run.status) ||
        !live.rows[0]?.valid
      )
        throw new OpensteerError({
          code: "forbidden",
          message: "Project control authority has ended",
        });
    }
    const inserted = await transaction
      .insertInto("commands")
      .values({
        id: createId("command"),
        type: "run.control.project",
        status: "pending",
        dispatcherId: null,
        lastError: null,
        actorPrincipalId: run.actorPrincipalId,
        authoritySource: jsonValue(run.authoritySource),
        requestedBy: run.requestedBy,
        membershipGeneration: run.membershipGeneration,
        initiatorGeneration: run.initiatorGeneration,
        originConnectionId: run.originConnectionId,
        environmentId: run.environmentId,
        threadId: run.threadId,
        runId: run.id,
        originatingGrantId: binding.grantId,
        idempotencyKey: controlIdentity(binding, input.idempotencyKey),
        payload: jsonValue(
          StoredProjectControlSchema.parse({ binding, control, correlationId: randomUUID() }),
        ),
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) return { created: true };
    const winner = await this.find(transaction, { binding, idempotencyKey: input.idempotencyKey });
    if (!winner || !isDeepStrictEqual(winner, control)) controlConflict();
    return { created: false };
  }
}

const ProjectBindingAcquisitionSchema = z.strictObject({
  commandId: CommandIdSchema,
  runnerId: RunnerIdSchema,
  runnerBootId: z.string().min(1).max(255),
  leaseTokenHash: z.string().min(1).max(255),
  leaseExpiresAt: z.date(),
  dispatcherId: z.string().min(1).max(255),
});

export class ProjectBindingStore {
  readonly database: Kysely<DatabaseSchema>;
  readonly dependencies: {
    readonly runnerIsAttached: (runnerId: RunnerId, runnerBootId: string) => boolean;
  };
  constructor(database: Kysely<DatabaseSchema>, dependencies: ProjectBindingStore["dependencies"]) {
    this.database = database;
    this.dependencies = dependencies;
  }

  async acquire(input: z.input<typeof ProjectBindingAcquisitionSchema>) {
    const request = ProjectBindingAcquisitionSchema.parse(input);
    if (request.leaseExpiresAt.getTime() <= Date.now())
      throw new OpensteerError({
        code: "bad_request",
        message: "Project binding lease has already ended",
      });
    await assertProjectAuthority(this.database);
    return withDatabaseTransaction(
      this.database,
      async (transaction) => {
        const observed = await transaction
          .selectFrom("commands")
          .innerJoin("runs", "runs.id", "commands.runId")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .selectAll("runs")
          .select(["threads.workspaceId", "commands.type as commandType"])
          .where("commands.id", "=", request.commandId)
          .executeTakeFirst();
        if (!observed || observed.commandType !== "run.execute.project")
          throw new OpensteerError({
            code: "not_found",
            message: "Project Run command is unavailable",
          });
        const origin = projectOriginFromRow(observed);
        if (origin?.originConnectionId)
          await transaction
            .selectFrom("agentConnections")
            .select("id")
            .where("id", "=", origin.originConnectionId)
            .forShare()
            .execute();
        const runs = await transaction
          .selectFrom("runs")
          .selectAll()
          .where("threadId", "=", observed.threadId)
          .where((eb) =>
            eb.or([eb("id", "=", observed.id), eb("status", "in", nonTerminalRunStatuses)]),
          )
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const run = runs.find((row) => row.id === observed.id);
        if (!run)
          throw new OpensteerError({ code: "not_found", message: "Project Run is unavailable" });
        if (runs.some((row) => row.id !== run.id && row.runOrdinal < run.runOrdinal))
          throw new OpensteerError({
            code: "conflict",
            reason: "thread-busy",
            message: "Earlier Project work has not finished",
          });
        if (run.authoritySource.kind === "trigger-occurrence")
          await transaction
            .selectFrom("triggerOccurrences")
            .select("id")
            .where("id", "=", TriggerOccurrenceIdSchema.parse(run.authoritySource.occurrenceId))
            .forShare()
            .execute();
        await lockWorkspaceRow(transaction, observed.workspaceId);
        const expanded = await transaction
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", run.threadId)
          .where("status", "in", nonTerminalRunStatuses)
          .execute();
        if (expanded.some((row) => !runs.some((reserved) => reserved.id === row.id)))
          throw new TransactionScopeChanged();
        const snapshot = ProjectRuntimeSnapshotSchema.parse(run.authoritySource.projectRuntime);
        const runtime = await reserveProjectRuntime(
          transaction,
          observed.workspaceId,
          origin,
          (runnerId) =>
            runnerId === request.runnerId &&
            this.dependencies.runnerIsAttached(runnerId, request.runnerBootId),
          snapshot,
        );
        if (
          runtime.runnerId !== request.runnerId ||
          !this.dependencies.runnerIsAttached(runtime.runnerId, request.runnerBootId)
        )
          throw new OpensteerError({
            code: "conflict",
            reason: "computer-offline",
            message: "Project Runner is not attached with this boot",
          });
        const thread = await transaction
          .selectFrom("threads")
          .selectAll()
          .where("id", "=", run.threadId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        if (thread.inputQueuePaused || thread.status === "archived")
          throw new OpensteerError({
            code: "conflict",
            reason: "thread-unavailable",
            message: "Project Thread cannot start work",
          });
        if (run.authoritySource.kind === "watch-observation")
          await transaction
            .selectFrom("triggerWatchActivations")
            .select("id")
            .where(
              "id",
              "=",
              TriggerWatchActivationIdSchema.parse(run.authoritySource.activationId),
            )
            .forShare()
            .execute();
        if (!(await projectWorkIsCurrent(transaction, run)))
          throw new OpensteerError({
            code: "forbidden",
            message: "Project Run's admitted authority has ended",
          });
        const sessions = await transaction
          .selectFrom("providerSessions")
          .selectAll()
          .where("threadId", "=", run.threadId)
          .where((eb) => eb.or([eb("id", "=", run.providerSessionId), eb("active", "=", true)]))
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const session = sessions.find((row) => row.id === run.providerSessionId);
        if (!session || session.harnessInstanceId !== run.harnessInstanceId)
          throw new OpensteerError({
            code: "conflict",
            message: "Project Run has no exact provider session",
          });
        const catalog = await transaction
          .selectFrom("harnessCatalogs")
          .select("catalog")
          .where("harnessInstanceId", "=", run.harnessInstanceId)
          .forShare()
          .executeTakeFirstOrThrow();
        const parsedCatalog = HarnessInstanceCatalogSchema.parse(catalog.catalog);
        const continuationIdentity =
          "continuationIdentity" in parsedCatalog ? parsedCatalog.continuationIdentity : null;
        if (
          !continuationIdentity ||
          (session.continuationIdentity &&
            !isDeepStrictEqual(session.continuationIdentity, continuationIdentity))
        )
          throw new OpensteerError({
            code: "conflict",
            reason: "engine-unavailable",
            message: "Project engine continuation identity changed",
          });
        await transaction
          .selectFrom("delegations")
          .select("id")
          .where((eb) =>
            eb.or([eb("childThreadId", "=", thread.id), eb("parentThreadId", "=", thread.id)]),
          )
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
        const command = await transaction
          .selectFrom("commands")
          .selectAll()
          .where("id", "=", request.commandId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        if (run.bindingGeneration !== null) {
          const grant = await transaction
            .selectFrom("grants")
            .select("id")
            .where("runId", "=", run.id)
            .where("bindingGeneration", "=", run.bindingGeneration)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (!grant)
            throw new OpensteerError({ code: "conflict", message: "Project binding has ended" });
          const stored = await readProjectRunBinding(transaction, {
            runId: run.id,
            grantId: grant.id,
          });
          if (
            !stored ||
            stored.binding.runnerId !== request.runnerId ||
            stored.binding.runnerBootId !== request.runnerBootId
          )
            throw new OpensteerError({
              code: "conflict",
              reason: "binding-recovery-required",
              message: "A new Runner boot requires a new durable Project binding",
            });
          await assertActiveProjectBinding(transaction, stored.binding, this.dependencies);
          return {
            binding: stored.binding,
            snapshot,
            events: [] as AgentEvent[],
            leaseExpiresAt: session.leaseExpiresAt,
            created: false,
          };
        }
        if (run.status !== "queued" || command.status !== "pending")
          throw new OpensteerError({
            code: "conflict",
            message: "Project Run is not queued for dispatch",
          });
        for (const prior of sessions)
          if (prior.active && prior.id !== session.id)
            await transaction
              .updateTable("providerSessions")
              .set({ active: false, updatedAt: new Date() })
              .where("id", "=", prior.id)
              .execute();
        const generation = session.bindingGeneration + 1;
        await transaction
          .updateTable("providerSessions")
          .set({
            active: true,
            bindingGeneration: generation,
            runnerId: request.runnerId,
            runnerBootId: request.runnerBootId,
            leaseTokenHash: request.leaseTokenHash,
            leaseExpiresAt: request.leaseExpiresAt,
            status: "starting",
            continuationIdentity: jsonValue(continuationIdentity),
            updatedAt: new Date(),
          })
          .where("id", "=", session.id)
          .execute();
        const events = await claimProjectRunInputBatch(transaction, run, thread);
        await transaction
          .updateTable("commands")
          .set((eb) => ({
            status: "dispatched",
            dispatcherId: request.dispatcherId,
            attempts: eb("attempts", "+", 1),
            updatedAt: new Date(),
          }))
          .where("id", "=", command.id)
          .execute();
        await transaction
          .updateTable("runs")
          .set({ status: "starting", bindingGeneration: generation })
          .where("id", "=", run.id)
          .execute();
        events.push(
          await appendHostWorkspaceEvent(transaction, {
            type: "run.status",
            data: { status: "starting" },
            environmentId: run.environmentId,
            threadId: thread.id,
            workspaceId: thread.workspaceId,
            runId: run.id,
          }),
        );
        events.push(...(await projectThreadState(transaction, thread.id)));
        if (origin)
          await transaction
            .selectFrom("users")
            .select("id")
            .where("id", "=", origin.userId)
            .where("authorityGeneration", "=", String(origin.initiatorGeneration))
            .where("memberState", "=", "active")
            .where("admittedAt", "is not", null)
            .where("disabledAt", "is", null)
            .forShare()
            .executeTakeFirstOrThrow();
        const { grantId } = await issueRunGrant(transaction, {
          runId: run.id,
          bindingGeneration: generation,
          runnerBootId: request.runnerBootId,
          runnerId: request.runnerId,
          modelSelection: run.modelSelection,
        });
        const binding = ProjectRunBindingSchema.parse({
          authority: {
            version: 1,
            principal: {
              kind: "project",
              workspaceId: thread.workspaceId,
              principalId: run.actorPrincipalId,
            },
            origin,
          },
          bindingGeneration: generation,
          environmentId: run.environmentId,
          grantId,
          runId: run.id,
          runnerBootId: request.runnerBootId,
          runnerId: request.runnerId,
          threadId: thread.id,
          workspaceId: thread.workspaceId,
        });
        return { binding, snapshot, events, leaseExpiresAt: request.leaseExpiresAt, created: true };
      },
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
  }
}

async function claimProjectRunInputBatch(
  transaction: Transaction<DatabaseSchema>,
  run: RunRow,
  thread: ThreadRow,
) {
  if (run.reportContext !== null) return [] as AgentEvent[];
  const exchange = projectExchangeKey(projectExchangeFromRow(run, thread.workspaceId));
  const receipts = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("threadId", "=", thread.id)
    .where("state", "in", ["pending", "unknown"])
    .orderBy("messageId")
    .forNoKeyUpdate()
    .execute();
  const candidates = receipts.filter(
    (row) => projectExchangeKey(projectExchangeFromRow(row, thread.workspaceId)) === exchange,
  );
  const seed = candidates.find(
    (row) => row.messageId === run.seedInputId && row.state === "pending" && row.policy === "queue",
  );
  if (!seed)
    throw new OpensteerError({
      code: "conflict",
      message: "Project Run's queued seed is unavailable",
    });
  const rows = await transaction
    .selectFrom("messages")
    .selectAll()
    .where(
      "id",
      "in",
      candidates.map((row) => row.messageId),
    )
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
  const messages = new Map(rows.map((row) => [row.id, row]));
  const ordered = [...candidates].sort((a, b) => {
    const left = BigInt(messages.get(a.messageId)?.sequence ?? -1);
    const right = BigInt(messages.get(b.messageId)?.sequence ?? -1);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const reports: MessageId[] = [];
  const selected: MessageId[] = [seed.messageId];
  let reportBytes = 2;
  let eligibleReports = 0;
  const cancelledEvents: AgentEvent[] = [];
  for (const receipt of ordered) {
    if (!(await projectWorkIsCurrent(transaction, receipt))) {
      const cancelled = await transaction
        .updateTable("threadInputs")
        .set({
          state: "cancelled",
          cancelReason: "execution-authority-unavailable",
          updatedAt: new Date(),
        })
        .where("messageId", "=", receipt.messageId)
        .returningAll()
        .executeTakeFirstOrThrow();
      cancelledEvents.push(
        await appendHostWorkspaceEvent(transaction, {
          type: "thread-input.updated",
          data: { input: threadInputFromRow(cancelled) },
          workspaceId: thread.workspaceId,
          environmentId: thread.environmentId,
          threadId: thread.id,
          runId: cancelled.runId,
        }),
      );
      continue;
    }
    const message = messages.get(receipt.messageId);
    if (!message)
      throw new OpensteerError({
        code: "conflict",
        message: "Project input message is unavailable",
      });
    if (receipt.policy === "report") {
      eligibleReports += 1;
      const size = Buffer.byteLength(JSON.stringify(messageFromRow(message)), "utf8") + 1;
      if (
        reports.length < threadReportBatchMaxEntries &&
        reportBytes + size <= threadReportBatchMaxSerializedBytes
      ) {
        reports.push(receipt.messageId);
        reportBytes += size;
      }
    } else if (
      thread.role === "conversation" &&
      receipt.messageId !== seed.messageId &&
      receipt.policy === "queue" &&
      receipt.state === "pending" &&
      selected.length < runExecuteInputsMax
    )
      selected.push(receipt.messageId);
  }
  const initialContext = await freezeRunInitialContext(transaction, run, seed);
  const claimed = await transaction
    .updateTable("threadInputs")
    .set({ runId: run.id, state: "claimed", updatedAt: new Date() })
    .where("messageId", "in", [...selected, ...reports])
    .returningAll()
    .execute();
  await transaction
    .updateTable("messages")
    .set({ runId: run.id })
    .where("id", "in", [...selected, ...reports])
    .execute();
  await transaction
    .updateTable("runs")
    .set({
      initialContext: initialContext ? jsonValue(initialContext) : null,
      reportContext: jsonValue({
        messageIds: reports,
        omittedCount: eligibleReports - reports.length,
        throughSequence: (BigInt(thread.nextMessageSequence) - 1n).toString(),
      }),
    })
    .where("id", "=", run.id)
    .execute();
  const events: AgentEvent[] = [...cancelledEvents];
  for (const row of claimed)
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        type: "thread-input.updated",
        data: { input: threadInputFromRow(row) },
        workspaceId: thread.workspaceId,
        environmentId: thread.environmentId,
        threadId: thread.id,
        runId: run.id,
      }),
    );
  return events;
}
