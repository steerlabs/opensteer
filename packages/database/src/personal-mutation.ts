import { clientSendKeyWireReserve } from "@opensteer/protocol/transcript";
import type { DatabaseSchema } from "./schema.js";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  DeploymentId,
  EnvironmentId,
  ExecutionNodeId,
  MessageId,
  RequestId,
  RunAttemptId,
  RunId,
  RunnerId,
  ThreadId,
} from "@opensteer/core";
import {
  PersonalChangeSchema,
  personalChangesFrameMaxBytes,
  personalShellEntityKinds,
} from "@opensteer/protocol/personal-sync";
import {
  isConstraintViolation,
  isTransactionConflict,
  withDatabaseTransaction,
} from "./connection.js";
import { inheritExecutionClock } from "./personal-transaction.js";
import type {
  ClientChangeOperation,
  ClientEntityKind,
  ClientSyncStateTable,
  DurablePersonalResourceKind,
  PersonalAttentionTable,
  PersonalScopeKey,
  TranscriptItemTable,
} from "./personal-state-schema.js";
import type { RevokedRunGrant } from "./run-grants.js";
import { publishThreadSummary, writeThreadSummary } from "./thread-status.js";
import { writeThreadQueues } from "./personal-queue-view.js";

import { refreshAssignmentWorkerSummaries } from "./assignment-store.js";

const retainedRows = 4_096;
// Pruning frees this many rows at once, so most commits that fill the feed delete nothing.
const pruneChunkRows = 512;
const maxCommitRows = 128;
const maxChangeBytes = 8 * 1024;
const maxCommitBytes = personalChangesFrameMaxBytes;
const scopeEnvelopeReserve = 1024;

type TargetDb = Kysely<DatabaseSchema>;
export type PersonalMutationTransaction = Transaction<DatabaseSchema>;
type ScopeAuthority = PersonalScopeKey | "deployment";
type State = Selectable<ClientSyncStateTable>;
type Counter = "pendingRequestCount" | "needsYouCount" | "unreadTaskCount";

interface ChangeIdentity {
  readonly scopeKey: PersonalScopeKey;
  readonly entityKind: ClientEntityKind;
  readonly entityId: string;
  readonly operation: ClientChangeOperation;
}

interface Change extends ChangeIdentity {
  readonly payload: Record<string, unknown>;
  readonly bytes: number;
}

function postgresJsonOverhead(value: unknown): number {
  if (Array.isArray(value))
    return (
      Math.max(0, value.length - 1) +
      value.reduce<number>((size, item) => size + postgresJsonOverhead(item), 0)
    );
  if (value === null || typeof value !== "object") return 0;
  const entries = Object.values(value);
  return (
    Math.max(0, entries.length * 2 - 1) +
    entries.reduce<number>((size, item) => size + postgresJsonOverhead(item), 0)
  );
}

function validChangeScope(identity: ChangeIdentity) {
  const kind = identity.entityKind;
  if (kind === "scope") return false;
  const shell = (personalShellEntityKinds as readonly string[]).includes(kind);
  if (identity.scopeKey === "shell") return shell;
  if (shell) return false;
  const root = identity.scopeKey.startsWith("thread:");
  if (kind === "run-queue" || kind === "queue-entry" || kind === "assignment") return root;
  if (kind === "node") return !root;
  return true;
}

interface CommitNotice {
  readonly deploymentId: DeploymentId;
  readonly head: string;
  readonly floor: string;
  readonly changedScopes: ReadonlySet<string>;
  readonly resourceKinds: ReadonlySet<DurablePersonalResourceKind>;
}

export type PersonalCommitReaction =
  | { readonly type: "executionDeadlinesChanged" }
  | { readonly type: "executionCommandsChanged" }
  | { readonly type: "continuationsChanged" }
  | { readonly type: "automationFailuresChanged" }
  | { readonly type: "deadlinesChanged" }
  | { readonly type: "grantsRevoked"; readonly grants: readonly RevokedRunGrant[] }
  | { readonly type: "runnerRevoked"; readonly runnerId: RunnerId }
  | { readonly type: "triggerSchedulesChanged" }
  | { readonly type: "authorityChanged"; readonly scopes: ReadonlySet<ScopeAuthority> }
  | {
      readonly type: "requestChanged";
      readonly requestId: RequestId;
      readonly kind: DatabaseSchema["requests"]["kind"];
      readonly status: DatabaseSchema["requests"]["status"];
      readonly opened: boolean;
      readonly threadId: ThreadId;
      readonly runId: RunId | null;
    }
  | {
      readonly type: "runChanged";
      readonly environmentId: EnvironmentId;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly transition:
        | "started"
        | "status"
        | "background"
        | "foreground"
        | "restarted"
        | "finishing"
        | "usage-limit";
    }
  | {
      readonly type: "teamStep";
      readonly runId: RunId;
      readonly toolName: string;
      readonly isIntegration: boolean;
    }
  | {
      readonly type: "runFinished";
      readonly attemptOnly?: true;
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly attemptId: RunAttemptId | null;
      readonly bindingGeneration: number | null;
      readonly outcome: "completed" | "failed" | "interrupted";
    }
  | {
      readonly type: "nodeProgressPlacement";
      readonly runId: RunId;
      readonly attemptId: RunAttemptId;
      readonly nodeId: ExecutionNodeId;
      readonly parentNodeId: ExecutionNodeId | null;
      readonly active: boolean;
    }
  | {
      readonly type: "runLiveClosed";
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly attemptId: RunAttemptId | null;
      readonly bindingGeneration: number | null;
    }
  | {
      readonly type: "liveClosed";
      readonly itemId: string;
      readonly runId: RunId;
      readonly attemptId: RunAttemptId | null;
      readonly bindingGeneration: number | null;
      readonly threadId: ThreadId;
      readonly nodeId: ExecutionNodeId | null;
      readonly afterSequence: string;
    };

interface PersonalMutationHooks {
  wake(notice: CommitNotice): void;
  react?(reaction: PersonalCommitReaction): void | Promise<void>;
  suspend?(scopes: ReadonlySet<ScopeAuthority>): {
    committed(): void;
    rolledBack(): void;
  };
  onFailure(error: unknown, operation: "wake" | "authority" | "reaction"): void;
}

const hooks = new WeakMap<TargetDb, PersonalMutationHooks>();
const active = new WeakMap<PersonalMutationTransaction, Mutation>();

export function installPersonalMutationHooks(database: TargetDb, listener: PersonalMutationHooks) {
  if (hooks.has(database)) throw new Error("Personal mutation hooks are already installed");
  hooks.set(database, listener);
  return () => {
    if (hooks.get(database) === listener) hooks.delete(database);
  };
}

function notify(
  listener: PersonalMutationHooks | undefined,
  operation: Parameters<PersonalMutationHooks["onFailure"]>[1],
  callback: () => void | Promise<unknown>,
) {
  const onFailure = (error: unknown) => {
    try {
      listener?.onFailure(error, operation);
    } catch {
      // A diagnostic callback cannot undo the committed mutation or its acknowledgement.
    }
  };
  try {
    const pending = callback();
    if (pending) void pending.catch(onFailure);
  } catch (error) {
    onFailure(error);
  }
}

type TranscriptPlacement = Pick<
  Selectable<TranscriptItemTable>,
  "position" | "visible" | "nodeId" | "isTurnStart"
>;
type ProjectionWrite = () => Promise<void>;

class Mutation {
  readonly state: State & { now: Date };
  readonly sequence: string;
  readonly resourceKinds = new Set<DurablePersonalResourceKind>();
  readonly authorityScopes = new Set<ScopeAuthority>();
  readonly #scopes = new Map<PersonalScopeKey, Map<string, Change>>();
  readonly #resetScopes = new Set<PersonalScopeKey>();
  readonly #reactions = new Set<() => void | Promise<unknown>>();
  readonly #ownerReactions: PersonalCommitReaction[] = [];
  readonly #transcript = new Map<
    string,
    { placement?: TranscriptPlacement; writes: ProjectionWrite[] }
  >();
  readonly #attention = new Map<
    string,
    { kind: PersonalAttentionTable["kind"] | null; write: ProjectionWrite }
  >();
  readonly #receipts: ((head: string) => Promise<void>)[] = [];
  readonly touchedThreads = new Set<ThreadId>();
  readonly #summaries = new Set<ThreadId>();
  readonly #queues = new Map<ThreadId, Set<MessageId>>();
  readonly #inputQueues = new Set<ThreadId>();
  readonly #counters = {
    pendingRequestCount: 0,
    needsYouCount: 0,
    unreadTaskCount: 0,
  };
  #pendingRequestsChanged = false;
  #scopeChanges = 0;
  #scopeBytes = 0;
  #privacyPurge = false;
  #reset = false;
  #resetOnly = false;

  constructor(state: State & { now: Date }) {
    this.state = state;
    this.sequence = (BigInt(state.sequence) + 1n).toString();
  }

  get hasVisibleChange() {
    return (
      this.#reset ||
      this.#privacyPurge ||
      this.#pendingRequestsChanged ||
      this.#scopeChanges > 0 ||
      this.resourceKinds.size > 0
    );
  }

  change(identity: ChangeIdentity, build: () => Record<string, unknown> = () => ({})) {
    const scope = identity.scopeKey;
    if (this.#reset || this.#resetScopes.has(scope)) return;
    if (this.#resetOnly) {
      this.resetScope(scope);
      return;
    }
    const { scopeKey: _scopeKey, ...address } = identity;
    const parsed = PersonalChangeSchema.safeParse({
      ...address,
      sequence: this.sequence,
      ordinal: maxCommitRows - 1,
      ...(identity.operation === "remove" ? {} : { value: build() }),
    });
    if (!parsed.success || !validChangeScope(identity)) {
      this.resetScope(scope);
      return;
    }
    const change = parsed.data;
    const payload = "value" in change ? change.value : {};
    const viewId =
      "id" in payload
        ? payload.id
        : change.entityKind === "visit" && "threadId" in payload
          ? payload.threadId
          : null;
    const scopeMismatch =
      change.operation === "upsert" &&
      change.entityKind === "item" &&
      scope !==
        (change.value.nodeId
          ? `node:${change.value.nodeId}`
          : scope.startsWith("thread:")
            ? scope
            : null);
    const humanMessage =
      change.operation === "upsert" &&
      change.entityKind === "item" &&
      change.value.kind === "message" &&
      change.value.author?.kind === "human";
    const bytes =
      Buffer.byteLength(JSON.stringify(change)) + 1 + (humanMessage ? clientSendKeyWireReserve : 0);
    if (
      (viewId !== null && viewId !== identity.entityId) ||
      scopeMismatch ||
      "clientSendKey" in payload ||
      Buffer.byteLength(JSON.stringify(payload)) + postgresJsonOverhead(payload) > maxChangeBytes
    ) {
      this.resetScope(scope);
      return;
    }
    const changes = this.#scopes.get(scope) ?? new Map<string, Change>();
    const key = JSON.stringify([identity.entityKind, identity.entityId]);
    const prior = changes.get(key);
    changes.set(key, { ...identity, payload, bytes });
    this.#scopes.set(scope, changes);
    this.#scopeChanges += prior ? 0 : 1;
    this.#scopeBytes += bytes - (prior?.bytes ?? 0);
    let scopeBytes = 0;
    for (const change of changes.values()) scopeBytes += change.bytes;
    if (
      changes.size > maxCommitRows ||
      scopeBytes + Buffer.byteLength(scope) + scopeEnvelopeReserve > maxCommitBytes
    )
      this.#markReset(scope);
    this.#boundCommit();
  }

  /** The scope's subscribers get a fresh snapshot instead of this commit's rows. */
  resetScope(scope: PersonalScopeKey) {
    if (this.#reset || this.#resetScopes.has(scope)) return;
    this.#markReset(scope);
    this.#boundCommit();
  }

  #markReset(scope: PersonalScopeKey) {
    this.#resetScopes.add(scope);
    const previous = this.#scopes.get(scope);
    if (previous) {
      this.#scopeChanges -= previous.size;
      for (const change of previous.values()) this.#scopeBytes -= change.bytes;
    }
    const change: Change = {
      scopeKey: scope,
      entityKind: "scope",
      entityId: "scope",
      operation: "reset",
      payload: {},
      bytes: 160,
    };
    this.#scopes.set(scope, new Map([["scope", change]]));
    this.#scopeChanges++;
    this.#scopeBytes += change.bytes;
  }

  // An oversized commit is repaired by snapshots, never by closing sockets: a reset is not a revocation.
  #boundCommit() {
    if (this.#scopeChanges <= maxCommitRows && this.#scopeBytes <= maxCommitBytes) return;
    if (!this.#resetOnly) {
      this.#resetOnly = true;
      for (const scope of this.#scopes.keys()) this.#markReset(scope);
      this.#boundCommit();
      return;
    }
    this.#reset = true;
    this.#scopes.clear();
    this.#resetScopes.clear();
  }

  bumpResource(kind: DurablePersonalResourceKind) {
    this.resourceKinds.add(kind);
  }

  count(counter: Counter, delta: number) {
    if (!Number.isInteger(delta)) throw new Error("Invalid personal counter delta");
    this.#counters[counter] += delta;
  }

  /**
   * The set of pending Requests, or something the Waiting Requests list shows for one, changed:
   * the shell's `pendingRequestsRevision` takes this commit's sequence.
   */
  pendingRequestsChanged() {
    this.#pendingRequestsChanged = true;
  }

  purge(scope: ScopeAuthority) {
    this.#privacyPurge = true;
    this.authorityScopes.add(scope);
  }

  fence(scope: ScopeAuthority) {
    this.authorityScopes.add(scope);
  }

  reaction(dispatch: () => void | Promise<unknown>) {
    this.#reactions.add(dispatch);
  }
  react(reaction: PersonalCommitReaction) {
    if (
      (reaction.type === "executionCommandsChanged" || reaction.type === "deadlinesChanged") &&
      this.#ownerReactions.some(({ type }) => type === reaction.type)
    )
      return;
    this.#ownerReactions.push(reaction);
  }
  receipt(write: (head: string) => Promise<void>) {
    this.#receipts.push(write);
  }
  /** A Request or approval-gated input of this task changed; its pending count is recounted. */
  deferQueue(threadId: ThreadId, left: readonly MessageId[]) {
    const staged = this.#queues.get(threadId);
    if (staged) for (const id of left) staged.add(id);
    else this.#queues.set(threadId, new Set(left));
  }
  /** True the first time this commit changes the task's input queue. */
  firstInputQueueChange(threadId: ThreadId) {
    if (this.#inputQueues.has(threadId)) return false;
    this.#inputQueues.add(threadId);
    return true;
  }
  takeQueues() {
    const queues = [...this.#queues].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.#queues.clear();
    return queues;
  }
  deferSummary(threadId: ThreadId) {
    this.#summaries.add(threadId);
  }
  summaryPending(threadId: ThreadId) {
    return this.#summaries.has(threadId);
  }
  summaryWritten(threadId: ThreadId) {
    this.#summaries.delete(threadId);
  }
  takeSummaries() {
    const ids = [...this.#summaries].sort();
    this.#summaries.clear();
    return ids;
  }
  touchThread(threadId: ThreadId) {
    this.touchedThreads.add(threadId);
  }

  transcriptPlacement(id: string) {
    return this.#transcript.get(id)?.placement;
  }

  stageTranscript(id: string, placement: TranscriptPlacement | undefined, write: ProjectionWrite) {
    const staged = this.#transcript.get(id) ?? { writes: [] };
    if (placement) staged.placement = placement;
    staged.writes.push(write);
    this.#transcript.set(id, staged);
  }

  attentionKind(id: string) {
    return this.#attention.get(id)?.kind;
  }

  stageAttention(id: string, kind: PersonalAttentionTable["kind"] | null, write: ProjectionWrite) {
    this.#attention.set(id, { kind, write });
  }

  async write(tx: PersonalMutationTransaction): Promise<CommitNotice> {
    // Source rows and position counters are already settled before derived rows lock.
    for (const id of [...this.#transcript.keys()].sort())
      for (const write of this.#transcript.get(id)!.writes) await write();
    const state = this.state;
    const { deploymentId } = state;
    const head = this.hasVisibleChange ? this.sequence : state.sequence;
    const changes = this.#privacyPurge
      ? []
      : Array.from(this.#scopes.values()).flatMap((scope) => [...scope.values()]);
    const at = new Date(Math.max(state.now.getTime(), state.lastCommitAt.getTime()));
    let floor = state.prunedThroughSequence;
    let count = state.retainedChangeCount;
    for (const write of this.#receipts) await write(head);
    for (const id of [...this.#attention.keys()].sort()) await this.#attention.get(id)!.write();
    const feed = () => tx.deleteFrom("clientChanges").where("deploymentId", "=", deploymentId);
    if (this.#reset || this.#privacyPurge) {
      floor = head;
      if (count > 0) count -= Number((await feed().executeTakeFirst()).numDeletedRows);
    } else if (count + changes.length > retainedRows) {
      // Rounds the cut up to a whole commit, so a replay never sees part of one.
      const cut = Math.min(count, count + changes.length - retainedRows + pruneChunkRows) - 1;
      const pruned = await feed()
        .where("sequence", "<=", (eb) =>
          eb
            .selectFrom("clientChanges")
            .select("sequence")
            .where("deploymentId", "=", deploymentId)
            .orderBy("sequence")
            .orderBy("ordinal")
            .offset(cut)
            .limit(1),
        )
        .returning("sequence")
        .execute();
      count -= pruned.length;
      for (const { sequence } of pruned) if (BigInt(sequence) > BigInt(floor)) floor = sequence;
    }
    if (changes.length) {
      await tx
        .insertInto("clientChanges")
        .values(
          changes.map((change, ordinal) => ({
            deploymentId,
            sequence: head,
            scopeKey: change.scopeKey,
            ordinal,
            entityKind: change.entityKind,
            entityId: change.entityId,
            operation: change.operation,
            payload: change.payload,
            createdAt: at,
          })),
        )
        .execute();
      count += changes.length;
    }
    if (
      this.hasVisibleChange ||
      count !== state.retainedChangeCount ||
      floor !== state.prunedThroughSequence ||
      Object.values(this.#counters).some(Boolean) ||
      this.#pendingRequestsChanged
    ) {
      const revisions = { ...state.resourceRevisions };
      for (const kind of this.resourceKinds) revisions[kind] = head;
      await tx
        .updateTable("clientSyncState")
        .set({
          sequence: head,
          prunedThroughSequence: floor,
          retainedChangeCount: count,
          lastCommitAt: this.hasVisibleChange ? at : state.lastCommitAt,
          resourceRevisions: revisions,
          pendingRequestCount: state.pendingRequestCount + this.#counters.pendingRequestCount,
          needsYouCount: state.needsYouCount + this.#counters.needsYouCount,
          unreadTaskCount: state.unreadTaskCount + this.#counters.unreadTaskCount,
          ...(this.#pendingRequestsChanged ? { pendingRequestsRevision: head } : {}),
        })
        .where("deploymentId", "=", deploymentId)
        .execute();
    }
    return {
      deploymentId,
      head,
      floor,
      resourceKinds: this.resourceKinds,
      changedScopes: new Set([
        ...this.#scopes.keys(),
        ...(Object.values(this.#counters).some(Boolean) || this.#pendingRequestsChanged
          ? ["shell"]
          : []),
        ...this.authorityScopes,
        ...(this.authorityScopes.size ? ["authority"] : []),
        ...(this.#reset || this.#privacyPurge ? ["deployment"] : []),
      ]),
    };
  }

  publish(listener: PersonalMutationHooks | undefined, notice: CommitNotice) {
    if (listener) notify(listener, "wake", () => listener.wake(notice));
    for (const dispatch of this.#reactions) notify(listener, "reaction", dispatch);
    if (listener?.react)
      for (const reaction of this.#ownerReactions)
        notify(listener, "reaction", () =>
          listener.react?.(
            reaction.type === "liveClosed" ? { ...reaction, afterSequence: notice.head } : reaction,
          ),
        );
    if (listener?.react && this.authorityScopes.size)
      notify(listener, "reaction", () =>
        listener.react?.({ type: "authorityChanged", scopes: this.authorityScopes }),
      );
  }
}

export type PersonalMutation = Pick<
  Mutation,
  | "sequence"
  | "state"
  | "change"
  | "resetScope"
  | "count"
  | "pendingRequestsChanged"
  | "bumpResource"
  | "purge"
  | "fence"
  | "receipt"
  | "touchThread"
  | "deferSummary"
  | "deferQueue"
  | "firstInputQueueChange"
  | "summaryPending"
  | "summaryWritten"
  | "reaction"
  | "react"
  | "transcriptPlacement"
  | "stageTranscript"
  | "attentionKind"
  | "stageAttention"
>;

/** The Personal mutation this transaction commits, if it is one. */
export function activePersonalMutation(
  tx: PersonalMutationTransaction,
): PersonalMutation | undefined {
  return active.get(tx);
}

export async function commitPersonalMutation<Result>(
  database: TargetDb,
  action: (tx: PersonalMutationTransaction, mutation: PersonalMutation) => Promise<Result>,
  retryDiscovery?: (error: unknown) => boolean,
  mode?: "non-retrying",
): Promise<Result> {
  if (database.isTransaction) {
    const tx = database as PersonalMutationTransaction;
    const mutation = active.get(tx);
    if (!mutation) throw new Error("Personal mutation was called outside its deployment fence");
    return action(tx, mutation);
  }
  const listener = hooks.get(database);
  let suspended: ReturnType<NonNullable<PersonalMutationHooks["suspend"]>> | undefined;
  const actionUnderFence = async (tx: PersonalMutationTransaction) => {
    inheritExecutionClock(database, tx);
    const state = await tx
      .selectFrom("clientSyncState")
      .selectAll()
      .select(sql<Date>`clock_timestamp()`.as("now"))
      .forNoKeyUpdate()
      .limit(1)
      .executeTakeFirstOrThrow();
    if (!state.ready) throw new Error("Personal current state is unready");
    const mutation = new Mutation(state);
    active.set(tx, mutation);
    const result = await action(tx, mutation);
    for (const id of [...mutation.touchedThreads].sort())
      if (await recountPendingRequests(tx, id)) {
        await publishThreadSummary(tx, id);
        await refreshAssignmentWorkerSummaries(tx, id);
      }
    // Each task's queue and summary are published once, from the commit's final rows.
    for (;;) {
      const queues = mutation.takeQueues();
      for (const [id, left] of queues) await writeThreadQueues(tx, id, [...left]);
      const summaries = mutation.takeSummaries();
      for (const id of summaries) await writeThreadSummary(tx, id);
      if (!queues.length && !summaries.length) break;
    }
    const notice = await mutation.write(tx);
    if (mutation.authorityScopes.size) {
      if (!listener?.suspend) throw new Error("Personal authority mutation has no dispatch fence");
      suspended = listener.suspend(mutation.authorityScopes);
    }
    return { result, notice, mutation };
  };
  const rollback = (error: unknown) => {
    if (suspended)
      notify(listener, "authority", () => {
        if (isTransactionConflict(error) || isConstraintViolation(error)) suspended?.rolledBack();
        else suspended?.committed();
      });
    suspended = undefined;
    return retryDiscovery?.(error) ?? false;
  };
  const committed =
    mode === "non-retrying"
      ? await database
          .transaction()
          .execute(actionUnderFence)
          .catch((error: unknown) => {
            rollback(error);
            throw error;
          })
      : await withDatabaseTransaction(database, actionUnderFence, undefined, rollback);
  if (suspended) notify(listener, "authority", () => suspended?.committed());
  committed.mutation.publish(listener, committed.notice);
  return committed.result;
}

/** Requests and approval-gated inputs both wait on the person. */
async function recountPendingRequests(tx: PersonalMutationTransaction, threadId: ThreadId) {
  const pending = sql<number>`(select count(*) from requests
      where originating_thread_id = threads.id and status = 'pending')
    + (select count(*) from thread_inputs
      where thread_id = threads.id and state = 'awaiting-approval')`;
  const changed = await tx
    .updateTable("threads")
    .set({ pendingRequestCount: pending })
    .where("id", "=", threadId)
    .where("pendingRequestCount", "<>", pending)
    .returning("id")
    .executeTakeFirst();
  return changed !== undefined;
}

export function wakeExecutionCommands(tx: PersonalMutationTransaction) {
  return commitPersonalMutation(tx, async (_tx, mutation) => {
    mutation.react({ type: "executionCommandsChanged" });
  });
}

/** A schedule's next fire time moved; the Host re-arms its schedule deadline at commit. */
export function wakeTriggerSchedules(tx: PersonalMutationTransaction) {
  return commitPersonalMutation(tx, async (_tx, mutation) => {
    mutation.react({ type: "triggerSchedulesChanged" });
  });
}

export function wakeRequestDeadlines(tx: PersonalMutationTransaction) {
  return commitPersonalMutation(tx, async (_tx, mutation) => {
    mutation.react({ type: "deadlinesChanged" });
  });
}
