import { withDatabaseTransaction } from "./connection.js";
import {
  agentDelegationMaxDepth,
  threadAccessModeAtMost,
  threadInReach,
  OpensteerError,
  type EnvironmentId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type TriggerOccurrenceId,
  type TriggerId,
  type TriggerRevisionId,
  type TriggerWatchActivationId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { type Kysely, type Transaction } from "kysely";
import { assertActiveGrant } from "./execution-authority.js";
import { WATCH_OBSERVATIONS_PER_HOUR } from "@opensteer/triggers";
import { assertActiveTriggerExecutionBinding, assertActiveWatchBinding } from "./trigger-store.js";
import type { DatabaseSchema } from "./schema.js";

export const agentControlMaxDelegationDepth = agentDelegationMaxDepth;

export type AgentControlAction =
  | "assignment.cancel"
  | "machine.full-disk-access.request"
  | "browser.access.request"
  | "browser.sign-in"
  | "browser.profile.create"
  | "browser.profile.list"
  | "browser.session.close"
  | "browser.session.list"
  | "browser.tab.read"
  | "browser.tab.write"
  | "browser.session.open"
  | "request.list"
  | "request.withdraw"
  | "thread.delegate"
  | "thread.list"
  | "thread.message"
  | "person.message"
  | "person.show"
  | "thread.read"
  | "thread.write"
  | "trigger.read"
  | "trigger.write"
  | "project.create"
  | "environment.list"
  | "project.list";

export type AgentControlActionClass = Exclude<AgentControlAction, "person.message">;

/**
 * The Trigger control path reaches the same actions the Run path does, so it is
 * bounded by the same class ledger: a Trigger program that could delegate or
 * message Threads without an admission class would be unbounded.
 */
type TriggerControlAction = AgentControlAction;

export type TriggerControlActionClass = AgentControlActionClass;

export interface AgentControlAdmissionInput {
  readonly accessMode?: import("@opensteer/core").ThreadAccessMode;
  readonly targetThreadIds?: readonly ThreadId[];
  readonly action: AgentControlAction;
  readonly bindingGeneration: number;
  readonly environmentId: EnvironmentId;
  readonly membershipGeneration: number;
  readonly requestedBy: UserId;
  readonly requestFingerprint: string;
  readonly requestId: string;
  readonly runId: RunId;
  readonly runnerBootId: string;
  readonly runnerId: RunnerId;
  readonly sourceThreadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

export interface AgentControlAdmissionResult {
  readonly actionClass: AgentControlActionClass;
  readonly wasDuplicate: boolean;
}

export interface TriggerControlAdmissionInput {
  readonly accessMode?: import("@opensteer/core").ThreadAccessMode;
  readonly targetThreadIds?: readonly ThreadId[];
  readonly action: TriggerControlAction;
  readonly environmentId: EnvironmentId;
  readonly executionGeneration: number;
  readonly occurrenceId: TriggerOccurrenceId;
  readonly requestedBy: UserId;
  readonly requestFingerprint: string;
  readonly requestId: string;
  readonly runnerBootId: string;
  readonly runnerId: RunnerId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}

export interface TriggerControlAdmissionResult {
  readonly actionClass: TriggerControlActionClass;
  readonly wasDuplicate: boolean;
}

export interface WatchControlAdmissionInput {
  readonly accessMode?: import("@opensteer/core").ThreadAccessMode;
  readonly targetThreadIds?: readonly ThreadId[];
  readonly action: "thread.delegate" | "thread.message";
  readonly activationId: TriggerWatchActivationId;
  readonly anchorThreadId: ThreadId;
  readonly createdBy: UserId;
  readonly environmentId: EnvironmentId;
  readonly executionGeneration: number;
  readonly membershipGeneration: number;
  readonly observationId: string;
  readonly requestFingerprint: string;
  readonly requestId: string;
  readonly revisionId: TriggerRevisionId;
  readonly triggerId: TriggerId;
  readonly workspaceId: WorkspaceId;
}

export interface WatchControlAdmissionResult {
  readonly wasDuplicate: boolean;
}

const actionClasses: Readonly<Record<AgentControlAction, AgentControlActionClass>> = {
  "assignment.cancel": "assignment.cancel",
  "machine.full-disk-access.request": "machine.full-disk-access.request",
  "browser.access.request": "browser.access.request",
  "browser.sign-in": "browser.sign-in",
  "browser.profile.create": "browser.profile.create",
  "browser.profile.list": "browser.profile.list",
  "browser.session.close": "browser.session.close",
  "browser.session.list": "browser.session.list",
  "browser.tab.read": "browser.tab.read",
  "browser.tab.write": "browser.tab.write",
  "browser.session.open": "browser.session.open",
  "request.list": "request.list",
  "request.withdraw": "request.withdraw",
  "thread.delegate": "thread.delegate",
  "thread.list": "thread.list",
  "thread.message": "thread.message",
  "person.message": "thread.message",
  "person.show": "person.show",
  "thread.read": "thread.read",
  "thread.write": "thread.write",
  "trigger.read": "trigger.read",
  "trigger.write": "trigger.write",
  "project.create": "project.create",
  "project.list": "project.list",
  "environment.list": "environment.list",
};

export async function admitAgentControlRequest(
  database: Kysely<DatabaseSchema>,
  input: AgentControlAdmissionInput,
  executionNow: () => number = Date.now,
): Promise<AgentControlAdmissionResult> {
  return withDatabaseTransaction(database, (transaction) =>
    admitAgentControlRequestInTransaction(transaction, input, "admit", executionNow),
  );
}

/**
 * `check` runs every admission test without the source fence or the receipt,
 * so a mutation can refuse a dead binding before its own
 * work; the mutation still admits with `admit` once its lock order allows.
 */
export type AdmissionMode = "admit" | "check";

export async function admitAgentControlRequestInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: AgentControlAdmissionInput,
  mode: AdmissionMode = "admit",
  executionNow: () => number = Date.now,
): Promise<AgentControlAdmissionResult> {
  if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) {
    throw new TypeError("Agent-control request fingerprint must be a SHA-256 hex digest");
  }
  const actionClass = actionClasses[input.action];
  {
    const run = await transaction
      .selectFrom("runs")
      .select(["id", "status", "threadId"])
      .where("id", "=", input.runId)
      .$if(mode === "admit", (query) => query.forNoKeyUpdate())
      .executeTakeFirst();
    if (!run) {
      throw new OpensteerError({ code: "not_found", message: "Agent-control Run not found" });
    }
    if (run.threadId !== input.sourceThreadId) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Agent-control Run does not belong to the claimed source Thread",
      });
    }
    // The ledger is an active-execution idempotency receipt, not a
    // capability that survives its Run. Exact retries still require the same
    // live binding before their immutable receipt can be replayed.
    if (run.status !== "starting" && run.status !== "running" && run.status !== "waiting") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Agent-control Run is no longer active",
      });
    }
    // Agent-control is tool use: a stopped Run's calls are refused even while
    // its Runner still reports how the Run ends.
    await assertActiveGrant(
      transaction,
      {
        bindingGeneration: input.bindingGeneration,
        environmentId: input.environmentId,
        membershipGeneration: input.membershipGeneration,
        requestedBy: input.requestedBy,
        runId: input.runId,
        runnerBootId: input.runnerBootId,
        runnerId: input.runnerId,
        threadId: input.sourceThreadId,
        workspaceId: input.workspaceId,
      },
      executionNow,
    );

    await assertOperationTargets(transaction, input.sourceThreadId, input);
    const existing = await transaction
      .selectFrom("agentControlRequests")
      .selectAll()
      .where("runId", "=", input.runId)
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.action !== input.action ||
        existing.actionClass !== actionClass ||
        existing.requestFingerprint !== input.requestFingerprint ||
        existing.sourceThreadId !== input.sourceThreadId
      ) {
        throw requestIdConflict(input.requestId);
      }
      return {
        actionClass,
        wasDuplicate: true,
      };
    }

    if (mode === "check") return { actionClass, wasDuplicate: false };

    await transaction
      .insertInto("agentControlRequests")
      .values({
        action: input.action,
        actionClass,
        requestFingerprint: input.requestFingerprint,
        requestId: input.requestId,
        runId: input.runId,
        sourceThreadId: input.sourceThreadId,
      })
      .executeTakeFirstOrThrow();
    return {
      actionClass,
      wasDuplicate: false,
    };
  }
}

/**
 * A Trigger program has no Run, so its Occurrence namespaces its domain receipts.
 */
export async function admitTriggerControlRequest(
  database: Kysely<DatabaseSchema>,
  input: TriggerControlAdmissionInput,
): Promise<TriggerControlAdmissionResult> {
  return withDatabaseTransaction(database, (transaction) =>
    admitTriggerControlRequestInTransaction(transaction, input),
  );
}

export async function admitTriggerControlRequestInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: TriggerControlAdmissionInput,
  mode: AdmissionMode = "admit",
): Promise<TriggerControlAdmissionResult> {
  if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) {
    throw new TypeError("Trigger-control request fingerprint must be a SHA-256 hex digest");
  }
  const actionClass = actionClasses[input.action];
  {
    const occurrence = await transaction
      .selectFrom("triggerOccurrences")
      .select("id")
      .where("id", "=", input.occurrenceId)
      .$if(mode === "admit", (query) => query.forNoKeyUpdate())
      .executeTakeFirst();
    if (!occurrence) {
      throw new OpensteerError({
        code: "not_found",
        message: "Trigger-control Occurrence not found",
      });
    }
    await assertActiveTriggerExecutionBinding(transaction, {
      environmentId: input.environmentId,
      executionGeneration: input.executionGeneration,
      occurrenceId: input.occurrenceId,
      requestedBy: input.requestedBy,
      runnerBootId: input.runnerBootId,
      runnerId: input.runnerId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
    });

    await assertOperationTargets(transaction, input.threadId, input);
    const existing = await transaction
      .selectFrom("triggerControlRequests")
      .selectAll()
      .where("occurrenceId", "=", input.occurrenceId)
      .where("requestId", "=", input.requestId)
      .executeTakeFirst();
    if (existing) {
      if (
        existing.action !== input.action ||
        existing.actionClass !== actionClass ||
        existing.requestFingerprint !== input.requestFingerprint
      ) {
        throw triggerRequestIdConflict(input.requestId);
      }
      return { actionClass, wasDuplicate: true };
    }

    if (mode === "check") return { actionClass, wasDuplicate: false };

    await transaction
      .insertInto("triggerControlRequests")
      .values({
        action: input.action,
        actionClass,
        occurrenceId: input.occurrenceId,
        requestFingerprint: input.requestFingerprint,
        requestId: input.requestId,
      })
      .executeTakeFirstOrThrow();
    return { actionClass, wasDuplicate: false };
  }
}

export async function admitWatchControlRequest(
  database: Kysely<DatabaseSchema>,
  input: WatchControlAdmissionInput,
): Promise<WatchControlAdmissionResult> {
  return withDatabaseTransaction(database, (transaction) =>
    admitWatchControlRequestInTransaction(transaction, input),
  );
}

export async function admitWatchControlRequestInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: WatchControlAdmissionInput,
  mode: AdmissionMode = "admit",
): Promise<WatchControlAdmissionResult> {
  if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) {
    throw new TypeError("Watch-control request fingerprint must be a SHA-256 hex digest");
  }
  const activation = await transaction
    .selectFrom("triggerWatchActivations")
    .select("id")
    .where("id", "=", input.activationId)
    .$if(mode === "admit", (query) => query.forNoKeyUpdate())
    .executeTakeFirst();
  if (!activation) {
    throw new OpensteerError({ code: "not_found", message: "Watch activation not found" });
  }
  await assertActiveWatchBinding(transaction, input);
  await assertOperationTargets(transaction, input.anchorThreadId, input);
  const existing = await transaction
    .selectFrom("watchControlRequests")
    .selectAll()
    .where("activationId", "=", input.activationId)
    .where("observationId", "=", input.observationId)
    .executeTakeFirst();
  if (existing) {
    if (
      existing.action !== input.action ||
      existing.requestFingerprint !== input.requestFingerprint
    ) {
      throw new OpensteerError({
        code: "conflict",
        details: { observationId: input.observationId },
        message: "Watch observation ID was already used with different input",
      });
    }
    return { wasDuplicate: true };
  }
  const window = await transaction
    .selectFrom("watchControlRequests")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("activationId", "=", input.activationId)
    .where("createdAt", ">=", new Date(Date.now() - 60 * 60 * 1_000))
    .executeTakeFirstOrThrow();
  if (safeCount(window.count) >= WATCH_OBSERVATIONS_PER_HOUR) {
    throw new OpensteerError({
      code: "resource_exhausted",
      details: { limit: WATCH_OBSERVATIONS_PER_HOUR },
      message: `Watch observation limit of ${WATCH_OBSERVATIONS_PER_HOUR} per hour was reached for this activation`,
    });
  }
  if (mode === "check") return { wasDuplicate: false };
  await transaction
    .insertInto("watchControlRequests")
    .values({
      action: input.action,
      activationId: input.activationId,
      observationId: input.observationId,
      requestFingerprint: input.requestFingerprint,
      requestId: input.requestId,
    })
    .executeTakeFirstOrThrow();
  return { wasDuplicate: false };
}

function safeCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OpensteerError({ code: "internal", message: "Invalid admission count" });
  }
  return parsed;
}

function requestIdConflict(requestId: string): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    details: { requestId },
    message: "Agent-control request ID was already used with different input",
  });
}

function triggerRequestIdConflict(requestId: string): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    details: { requestId },
    message: "Trigger-control request ID was already used with different input",
  });
}

async function assertOperationTargets(
  transaction: Transaction<DatabaseSchema>,
  sourceThreadId: ThreadId,
  input: {
    readonly accessMode?: import("@opensteer/core").ThreadAccessMode;
    readonly targetThreadIds?: readonly ThreadId[];
  },
): Promise<void> {
  if (!input.accessMode) return;
  const source = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", sourceThreadId)
    .executeTakeFirstOrThrow();
  if (!threadAccessModeAtMost(input.accessMode, source.accessMode))
    throw new OpensteerError({ code: "forbidden", message: "Caller access mode was reduced" });
  for (const id of input.targetThreadIds ?? []) {
    const target = await transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    if (
      !threadInReach(source, target) ||
      !threadAccessModeAtMost(target.accessMode, input.accessMode) ||
      !threadAccessModeAtMost(target.accessMode, source.accessMode)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Target Thread exceeds the caller's live reach or access mode",
      });
  }
}
