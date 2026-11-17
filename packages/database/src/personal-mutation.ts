import type { DatabaseSchema } from "./schema.js";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type {
  DeploymentId,
  EnvironmentId,
  ExecutionNodeId,
  RequestId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@opensteer/core";
import { PersonalChangeSchema } from "@opensteer/protocol/personal-sync";
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
  PersonalResourceKind,
  PersonalScopeKey,
} from "./personal-state-schema.js";

const retainedRows = 4_096;
const maxCommitRows = 128;
const maxChangeBytes = 8 * 1024;
const maxCommitBytes = 64 * 1024;
const scopeEnvelopeReserve = 1024;
const retentionMs = 24 * 60 * 60 * 1000;

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
  if (kind === "collection") return true;
  if (identity.scopeKey === "shell")
    return kind === "task" || kind === "visit" || kind === "attention";
  if (kind === "thread" || kind === "item" || kind === "request") return true;
  return kind === "run-queue" && identity.scopeKey.startsWith("thread:");
}

interface CommitNotice {
  readonly deploymentId: DeploymentId;
  readonly head: string;
  readonly floor: string;
  readonly nextExpiryAt: number | null;
}

export type PersonalCommitReaction =
  | {
      readonly type: "requestChanged";
      readonly requestId: RequestId;
      readonly kind: DatabaseSchema["requests"]["kind"];
      readonly status: DatabaseSchema["requests"]["status"];
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
  onFailure(error: unknown, operation: "wake" | "authority" | "observation" | "reaction"): void;
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
  callback: () => void | Promise<void>,
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

class Mutation {
  readonly state: State & { now: Date };
  readonly sequence: string;
  readonly resourceKinds = new Set<PersonalResourceKind>();
  readonly authorityScopes = new Set<ScopeAuthority>();
  readonly #scopes = new Map<PersonalScopeKey, Map<string, Change>>();
  readonly #invalidated = new Set<PersonalScopeKey>();
  readonly #reactions = new Set<() => void>();
  readonly #ownerReactions: PersonalCommitReaction[] = [];
  readonly #observations = new Set<() => void>();
  readonly #receipts: ((head: string) => Promise<void>)[] = [];
  readonly #counters = { pendingRequestCount: 0, needsYouCount: 0, unreadTaskCount: 0 };
  #scopeChanges = 0;
  #scopeBytes = 0;
  #privacyPurge = false;
  #reset = false;
  #invalidateOnly = false;

  constructor(state: State & { now: Date }) {
    this.state = state;
    this.sequence = (BigInt(state.sequence) + 1n).toString();
  }

  get hasVisibleChange() {
    return (
      this.#reset || this.#privacyPurge || this.#scopeChanges > 0 || this.resourceKinds.size > 0
    );
  }

  change(identity: ChangeIdentity, build: () => Record<string, unknown> = () => ({})) {
    const scope = identity.scopeKey;
    if (this.#reset || this.#invalidated.has(scope)) return;
    if (this.#invalidateOnly) {
      this.#invalidate(scope);
      this.#boundCommit();
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
      this.#invalidate(scope);
      this.#boundCommit();
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
    const bytes = Buffer.byteLength(JSON.stringify(change)) + 1;
    if (
      (viewId !== null && viewId !== identity.entityId) ||
      scopeMismatch ||
      Buffer.byteLength(JSON.stringify(payload)) + postgresJsonOverhead(payload) > maxChangeBytes
    ) {
      this.#invalidate(scope);
      this.#boundCommit();
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
      this.#invalidate(scope);
    this.#boundCommit();
  }

  #invalidate(scope: PersonalScopeKey) {
    this.#invalidated.add(scope);
    const previous = this.#scopes.get(scope);
    if (previous) {
      this.#scopeChanges -= previous.size;
      for (const change of previous.values()) this.#scopeBytes -= change.bytes;
    }
    const change: Change = {
      scopeKey: scope,
      entityKind: "collection",
      entityId: "scope",
      operation: "invalidate",
      payload: {},
      bytes: 160,
    };
    this.#scopes.set(scope, new Map([["scope", change]]));
    this.#scopeChanges++;
    this.#scopeBytes += change.bytes;
  }

  #boundCommit() {
    if (this.#scopeChanges <= maxCommitRows && this.#scopeBytes <= maxCommitBytes) return;
    if (!this.#invalidateOnly) {
      this.#invalidateOnly = true;
      for (const scope of this.#scopes.keys()) this.#invalidate(scope);
      this.#boundCommit();
      return;
    }
    this.#reset = true;
    this.#scopes.clear();
    this.#invalidated.clear();
    this.authorityScopes.add("deployment");
  }

  bumpResource(kind: PersonalResourceKind) {
    this.resourceKinds.add(kind);
  }

  count(counter: Counter, delta: number) {
    if (!Number.isInteger(delta)) throw new Error("Invalid personal counter delta");
    this.#counters[counter] += delta;
  }

  purge(scope: ScopeAuthority) {
    this.#privacyPurge = true;
    this.authorityScopes.add(scope);
  }

  fence(scope: ScopeAuthority) {
    this.authorityScopes.add(scope);
  }

  observation(install: () => void) {
    this.#observations.add(install);
  }
  reaction(dispatch: () => void) {
    this.#reactions.add(dispatch);
  }
  react(reaction: PersonalCommitReaction) {
    this.#ownerReactions.push(reaction);
  }
  receipt(write: (head: string) => Promise<void>) {
    this.#receipts.push(write);
  }

  async write(tx: PersonalMutationTransaction): Promise<CommitNotice> {
    const state = this.state;
    const { deploymentId } = state;
    const head = this.hasVisibleChange ? this.sequence : state.sequence;
    const changes = this.#privacyPurge
      ? []
      : Array.from(this.#scopes.values()).flatMap((scope) => [...scope.values()]);
    const at = new Date(Math.max(state.now.getTime(), state.lastCommitAt.getTime()));
    let floor = state.prunedThroughSequence;
    let count = state.retainedChangeCount;
    const keep = tx
      .selectFrom("clientChanges")
      .select("sequence")
      .where("deploymentId", "=", deploymentId);
    const earliest = keep.select("createdAt").orderBy("sequence").orderBy("ordinal").limit(1);
    const oldestBefore = count > 0 ? await earliest.executeTakeFirstOrThrow() : undefined;
    if (this.#reset || this.#privacyPurge) {
      floor = head;
    } else {
      const overshoot = count + changes.length - retainedRows;
      const countCut =
        overshoot > 0
          ? (
              await keep
                .orderBy("sequence")
                .orderBy("ordinal")
                .offset(overshoot - 1)
                .limit(1)
                .executeTakeFirst()
            )?.sequence
          : undefined;
      const before = state.now.getTime() - retentionMs;
      const ageCut =
        oldestBefore && oldestBefore.createdAt.getTime() <= before
          ? (
              await keep
                .select("createdAt")
                .orderBy("sequence")
                .orderBy("ordinal")
                .limit(maxCommitRows)
                .execute()
            ).findLast((row) => row.createdAt.getTime() <= before)?.sequence
          : undefined;
      for (const candidate of [countCut, ageCut]) {
        if (candidate !== undefined && BigInt(candidate) > BigInt(floor)) floor = candidate;
      }
    }
    if (BigInt(floor) > BigInt(state.prunedThroughSequence) && count > 0) {
      const prefix = tx
        .deleteFrom("clientChanges")
        .where("deploymentId", "=", deploymentId)
        .where("sequence", "<=", floor);
      count -= Number((await prefix.executeTakeFirst()).numDeletedRows);
    }
    for (const write of this.#receipts) await write(head);
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
      Object.values(this.#counters).some(Boolean)
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
        })
        .where("deploymentId", "=", deploymentId)
        .execute();
    }
    const oldest =
      count === 0
        ? null
        : oldestBefore && BigInt(oldestBefore.sequence) > BigInt(floor)
          ? oldestBefore
          : await earliest.executeTakeFirstOrThrow();
    return {
      deploymentId,
      head,
      floor,
      nextExpiryAt: oldest ? oldest.createdAt.getTime() + retentionMs : null,
    };
  }

  publish(listener: PersonalMutationHooks | undefined, notice: CommitNotice) {
    for (const install of this.#observations) notify(listener, "observation", install);
    if (listener) notify(listener, "wake", () => listener.wake(notice));
    for (const dispatch of this.#reactions) notify(listener, "reaction", dispatch);
    if (listener?.react)
      for (const reaction of this.#ownerReactions)
        notify(listener, "reaction", () =>
          listener.react?.(
            reaction.type === "liveClosed" ? { ...reaction, afterSequence: notice.head } : reaction,
          ),
        );
  }
}

export type PersonalMutation = Pick<
  Mutation,
  | "sequence"
  | "state"
  | "change"
  | "count"
  | "bumpResource"
  | "purge"
  | "fence"
  | "receipt"
  | "observation"
  | "reaction"
  | "react"
>;

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
      .forNoKeyUpdate()
      .limit(1)
      .executeTakeFirstOrThrow();
    if (!state.ready) throw new Error("Personal current state is unready");
    await tx
      .selectFrom("personalSettings")
      .select("singletonKey")
      .forNoKeyUpdate()
      .limit(1)
      .execute();
    const clock = await tx
      .selectNoFrom(sql<Date>`clock_timestamp()`.as("now"))
      .executeTakeFirstOrThrow();
    const mutation = new Mutation({ ...state, now: clock.now });
    active.set(tx, mutation);
    const result = await action(tx, mutation);
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
