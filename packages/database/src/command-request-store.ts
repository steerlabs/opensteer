import { commandNotFoundMessage } from "./resource-access.js";
import {
  commandAgentStatus,
  commandRequestReportedFailure,
  commandRequestAnswers,
  CommandRequestPartSchema,
  createId,
  OpensteerError,
  type CommandRequestOutcome,
  type CommandRequestPart,
  type Request,
  type RequestId,
  type RequestPresentation,
  type RequestResponse,
  type RunId,
  type ThreadId,
  type TriggerOccurrenceId,
  type TriggerWatchActivationId,
  type AgentSessionId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { outsideProse } from "@opensteer/protocol/command-review";
import { commitPersonalMutation } from "./personal-mutation.js";
import {
  assertRequestRevision,
  lockRequestThreads,
  refreshRequestState,
  requestFromRow,
} from "./request-persistence.js";
import { readRequestSettlementProvenance, requestSettlementActor } from "./request-settlement.js";
import {
  enqueueContinuation,
  lockActiveDurableRequestAuthority,
  type RequestStore,
} from "./request-store.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

/** Where a proposed command came from: exactly one execution the Home issued. */
export type CommandRequestOrigin =
  | { readonly runId: RunId }
  | { readonly occurrenceId: TriggerOccurrenceId }
  | { readonly watchActivationId: TriggerWatchActivationId }
  | { readonly agentSessionId: AgentSessionId };

export type CommandRequestOpened =
  | { readonly status: "pending"; readonly request: Request; readonly replayed: boolean }
  | {
      readonly status: "declined" | "withdrawn" | "closed" | "person-says-done" | "done-by-person";
      readonly requestId: RequestId;
    }
  | {
      readonly status: "answered";
      readonly requestId: RequestId;
      readonly outcome: CommandRequestOutcome;
    };

/** What became of a command Request, as its proposer and the person's activity read it. */
export function commandRequestState(row: {
  readonly id: RequestId;
  readonly status: string;
  readonly command: unknown;
  readonly response?: unknown;
}): Exclude<CommandRequestOpened, { readonly status: "pending" }> | undefined {
  const part = CommandRequestPartSchema.parse(row.command);
  if (row.status === "withdrawn") return { status: "withdrawn", requestId: row.id };
  const status = commandAgentStatus({
    status: row.status,
    response: (row.response ?? null) as never,
    command: part,
  });
  switch (status) {
    case "pending":
      return undefined;
    case "declined":
    case "person-says-done":
    case "done-by-person":
    case "closed":
      return { status, requestId: row.id };
    default:
      return {
        status: "answered",
        requestId: row.id,
        outcome: part.outcome ?? { status: "running" },
      };
  }
}

const approvalRunningWords = "You approved this, and it is being done.";

/** The card's words once the person has answered, so every app reads what happened. */
export function settledPresentation(
  presentation: RequestPresentation,
  part: CommandRequestPart,
  outcome: CommandRequestOutcome,
): RequestPresentation {
  const sentence = part.sentence ?? part.summary;
  const reportedFailure = commandRequestReportedFailure(outcome);
  const [title, said] =
    outcome.status === "done"
      ? ["Done", "You approved this, and it was done."]
      : outcome.status === "failed"
        ? [
            "Did not happen",
            reportedFailure
              ? outsideProse(reportedFailure)
              : "You approved this, but the Home refused it, so nothing changed.",
          ]
        : outcome.status === "unknown"
          ? outcome.progress
            ? [
                outcome.progress.kind === "partial"
                  ? "Partly done"
                  : outcome.progress.kind === "pending"
                    ? "Still pending"
                    : "May have happened",
                `You approved this. ${outsideProse(outcome.progress.message)}`,
              ]
            : [
                "May have happened",
                "You approved this, but the Home could not tell whether it finished. It may have happened: check before doing it again. The Home will not run it again.",
              ]
          : ["Approved", approvalRunningWords];
  const rest = presentation.detail?.split("\n\n") ?? [];
  if (rest[0] === approvalRunningWords) rest.shift();
  return {
    ...presentation,
    title: `${title}: ${sentence}`.slice(0, 240),
    detail: [said, ...rest].join("\n\n").slice(0, 16_000),
  };
}

/** The column as written: the part, validated, so a stored row always reads back. */
function partValue(part: CommandRequestPart) {
  return jsonValue(CommandRequestPartSchema.parse(part));
}

/** How long the person's no to a proposal answers the same proposal again. */
export const declineRemembered = 24 * 60 * 60_000;

/**
 * The person's attention, bounded: at most this many asks of one proposer (a connection, a Run's
 * task tree, an automation) wait at once; and after this many noes to one proposer about the same
 * type and thing within `declineRemembered`, it is answered as declined about it until they pass.
 */
export const commandAskLimits = { pendingPerProposer: 5, declinesBeforeQuiet: 3 } as const;

/** What reads as nothing there to an agent: the door's own words (rule 5). */
const unavailable = () =>
  new OpensteerError({ code: "not_found", message: commandNotFoundMessage });

const pendingCommand = (database: Kysely<DatabaseSchema>, owner: UserId) =>
  database
    .selectFrom("requests")
    .where("requestedBy", "=", owner)
    .where("status", "=", "pending")
    .where("command", "is not", null);

/**
 * What answers a proposal before any Request is written, in one place for the check made before
 * the Home looks anything up and the one made in the transaction that writes it: the same call
 * again (its Request, whatever became of it); the same ask open (that one, or a conflict for other
 * arguments); the same proposal the person declined within a day; the person's noes to this
 * proposer about this thing; and the proposer's asks already waiting.
 */
async function answeredBeforeAsking(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly ownerUserId: UserId;
    readonly callId: string;
    readonly part: Pick<CommandRequestPart, "askKey" | "argumentsDigest" | "proposer">;
    readonly now: Date;
  },
): Promise<CommandRequestOpened | null> {
  const owner = input.ownerUserId;
  const replay = await database
    .selectFrom("requests")
    .selectAll()
    .where("callId", "=", input.callId)
    .where("requestedBy", "=", owner)
    .where("command", "is not", null)
    .executeTakeFirst();
  if (replay) {
    const stored = CommandRequestPartSchema.parse(replay.command);
    // The same key with other arguments is another call, not this one again.
    if (stored.argumentsDigest !== input.part.argumentsDigest)
      throw new OpensteerError({
        code: "conflict",
        reason: "idempotency-conflict",
        message: "That key was used for a different proposal. Use a new key.",
      });
    return (
      commandRequestState(replay) ?? {
        status: "pending" as const,
        request: requestFromRow(replay),
        replayed: true,
      }
    );
  }
  const open = await pendingCommand(database, owner)
    .selectAll()
    .where(sql<boolean>`command->>'askKey' = ${input.part.askKey}`)
    .executeTakeFirst();
  if (open) {
    const stored = CommandRequestPartSchema.parse(open.command);
    if (stored.argumentsDigest !== input.part.argumentsDigest)
      throw new OpensteerError({
        code: "conflict",
        reason: "command-already-asked",
        message: "You already asked about this. Wait for the answer, or withdraw that Request.",
      });
    return { status: "pending" as const, request: requestFromRow(open), replayed: true };
  }
  const since = new Date(input.now.getTime() - declineRemembered);
  const declines = await database
    .selectFrom("requests")
    .select(["id", "command", "response"])
    .where("requestedBy", "=", owner)
    .where("status", "=", "declined")
    .where("command", "is not", null)
    .where(sql<boolean>`command->>'askKey' = ${input.part.askKey}`)
    .where("resolvedAt", ">", since)
    .orderBy("resolvedAt", "desc")
    .execute();
  // Only the person's no counts; their saying they did it themselves is no refusal.
  const noes = declines.filter(
    (row) =>
      commandAgentStatus({ status: "declined", response: row.response as never }) === "declined",
  );
  // The same proposal the person declined is answered as declined, with nothing opened.
  const same = noes.find(
    (row) =>
      CommandRequestPartSchema.parse(row.command).argumentsDigest === input.part.argumentsDigest,
  );
  if (same) return { status: "declined", requestId: same.id };
  // After enough noes about this thing, this proposer is answered no about it for a while.
  if (noes.length >= commandAskLimits.declinesBeforeQuiet)
    return { status: "declined", requestId: noes[0]!.id };
  const waiting = await pendingCommand(database, owner)
    .select(sql<number>`count(*)::int`.as("count"))
    .where(sql<boolean>`command->'proposer'->>'key' = ${input.part.proposer.key}`)
    .executeTakeFirstOrThrow();
  if (waiting.count >= commandAskLimits.pendingPerProposer)
    throw new OpensteerError({
      code: "conflict",
      reason: "too-many-asks",
      // Counted for the whole lineage: in a later Run of the same task, earlier asks are its own.
      message: `You already have ${commandAskLimits.pendingPerProposer} asks waiting for the person, earlier ones included. See them with opensteer_state, area requests, and withdraw one before asking again.`,
    });
  return null;
}

interface OpenInput {
  readonly ownerUserId: UserId;
  readonly callId: string;
  readonly origin: CommandRequestOrigin;
  readonly originatingThreadId: ThreadId;
  readonly part: CommandRequestPart;
  readonly presentation: RequestPresentation;
  /** The proposer's admission once more, first in the transaction that writes the Request. */
  readonly stillAsks?: (transaction: Transaction<DatabaseSchema>) => Promise<boolean>;
}

export class CommandRequestStore {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #requests: RequestStore;
  readonly #now: () => Date;
  constructor(database: Kysely<DatabaseSchema>, requests: RequestStore, now = () => new Date()) {
    this.#database = database;
    this.#requests = requests;
    this.#now = now;
  }

  /**
   * Opens the person's Request for a command an agent proposed, or answers from what is already
   * there: the same call again is the same Request; the same ask (proposer and thing) with the same
   * arguments is the open one; with other arguments it is a conflict. That is the one rule: an
   * ask waits until the person answers or its proposer withdraws it, and the same proposal the
   * person declined is answered as declined for a day (`declineRemembered`).
   */
  async open(input: OpenInput): Promise<CommandRequestOpened> {
    return this.#open(input);
  }

  /** What answers a proposal before the Home looks anything up for it (the same checks open makes). */
  answerBeforeAsking(input: {
    readonly ownerUserId: UserId;
    readonly callId: string;
    readonly part: Pick<CommandRequestPart, "askKey" | "argumentsDigest" | "proposer">;
  }): Promise<CommandRequestOpened | null> {
    return answeredBeforeAsking(this.#database, { ...input, now: this.#now() });
  }

  /**
   * The person's own command did what pending proposals asked for: every pending proposal of
   * this owner whose type and arguments digest are that command's (the digest leaves out the key
   * and every value only the person types) is settled as done by the person. The Home writes this,
   * after the person's command succeeded; no agent can.
   */
  async settleDoneByPerson(input: {
    readonly ownerUserId: UserId;
    readonly type: string;
    readonly argumentsDigest: string;
  }): Promise<readonly RequestId[]> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const matching = () =>
        pendingCommand(transaction, input.ownerUserId)
          .where(sql<boolean>`command->>'type' = ${input.type}`)
          .where(sql<boolean>`command->>'argumentsDigest' = ${input.argumentsDigest}`);
      // Their tasks first, then the Requests, in the order every lock is taken.
      const threads = await matching().select("originatingThreadId").distinct().execute();
      if (!threads.length) return [];
      await lockRequestThreads(
        transaction,
        threads.map(({ originatingThreadId }) => originatingThreadId),
      );
      const rows = await matching().selectAll().orderBy("id").forNoKeyUpdate().execute();
      const now = this.#now();
      const settled: RequestId[] = [];
      for (const row of rows) {
        const part = CommandRequestPartSchema.parse(row.command);
        const done = await transaction
          .updateTable("requests")
          .set({
            status: "fulfilled",
            resolvedAt: now,
            resolvedBy: input.ownerUserId,
            response: jsonValue({
              kind: "form",
              answers: { [commandRequestAnswers.field]: [commandRequestAnswers.doneByPerson] },
            }),
            command: partValue({ ...part, outcome: { status: "done" } }),
          })
          .where("id", "=", row.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirst();
        if (!done) continue;
        const request = requestFromRow(done);
        if (!request.originatingAgentSessionId)
          await enqueueContinuation(transaction, request, now);
        await refreshRequestState(transaction, request.id);
        settled.push(request.id);
      }
      return settled;
    });
  }

  /**
   * An approval left running with no effect in flight (its receipt was lost): its outcome is read
   * from the attempt the effect recorded. Only the record is written again; the effect never runs
   * again.
   */
  async reconcileRunning(requestId: RequestId): Promise<Request | null> {
    const row = await this.#database
      .selectFrom("requests")
      .select(["command", "requestedBy"])
      .where("id", "=", requestId)
      .executeTakeFirst();
    if (!row?.command) return null;
    const part = CommandRequestPartSchema.parse(row.command);
    if (part.outcome?.status !== "running") return null;
    const attempt = await this.#database
      .selectFrom("commandAttempts")
      .select(["state", "outcome"])
      .where("requestedBy", "=", row.requestedBy)
      .where("callerKey", "=", `request:${requestId}`)
      .where("idempotencyKey", "=", `command-request:${requestId}`)
      .orderBy("startedAt", "desc")
      .executeTakeFirst();
    return this.settle(
      requestId,
      attempt?.outcome ?? (attempt?.state === "done" ? { status: "done" } : { status: "unknown" }),
    );
  }

  /**
   * An approval whose proposer could no longer ask for it at the last admission, with the effect's
   * attempt (nothing ran): the Request closes, as an ask that ended before it was answered.
   */
  async closeRefusedApproval(requestId: RequestId): Promise<void> {
    await commitPersonalMutation(this.#database, async (transaction) => {
      const origin = await transaction
        .selectFrom("requests")
        .select("originatingThreadId")
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow();
      // Threads before requests, as everything else that settles a Request locks them.
      await lockRequestThreads(transaction, [origin.originatingThreadId]);
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", requestId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const part = CommandRequestPartSchema.parse(row.command);
      if (part.outcome?.status !== "running") return;
      const now = this.#now();
      const closed = await transaction
        .updateTable("requests")
        .set({
          status: "cancelled",
          cancellationReason: "authority-revoked",
          // No answer stands: the approval it began is not the person's answer any more.
          resolvedAt: now,
          resolvedBy: null,
          response: null,
          responseCommandId: null,
          settlementProvenance: null,
          presentation: jsonValue({
            ...row.presentation,
            title: part.summary,
            detail: row.presentation.detail?.replace(`${approvalRunningWords}\n\n`, ""),
          }),
          command: partValue({
            ...part,
            outcome: {
              status: "failed",
              code: "forbidden",
              message: "The agent that asked can no longer ask for this, so nothing changed.",
            },
          }),
        })
        .where("id", "=", requestId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(closed);
      if (!request.originatingAgentSessionId) await enqueueContinuation(transaction, request, now);
      await refreshRequestState(transaction, requestId);
    });
  }

  #open(input: OpenInput): Promise<CommandRequestOpened> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const owner = input.ownerUserId;
      // Whoever asks must still reach what it asks about as the Request is written: a grant
      // narrowed since the door admitted it reads like nothing there, and nothing opens.
      if (input.stillAsks && !(await input.stillAsks(transaction))) throw unavailable();
      const answered = await answeredBeforeAsking(transaction, {
        ownerUserId: owner,
        callId: input.callId,
        part: input.part,
        now: this.#now(),
      });
      if (answered) return answered;
      const origin = input.origin;
      const created = await this.#requests.create(
        {
          callId: input.callId,
          kind: "person.question",
          mode: "durable",
          requiredActor: "owner",
          originatingThreadId: input.originatingThreadId,
          requestedBy: owner,
          originatingRunId: "runId" in origin ? origin.runId : null,
          originatingOccurrenceId: "occurrenceId" in origin ? origin.occurrenceId : null,
          ...("watchActivationId" in origin
            ? { originatingWatchActivationId: origin.watchActivationId }
            : {}),
          ...("agentSessionId" in origin
            ? { originatingAgentSessionId: origin.agentSessionId }
            : {}),
          payload: { kind: "person.question" },
          presentation: input.presentation,
        } as never,
        transaction,
      );
      // A question with the very same card in this task is returned as that one: never adopt
      // another ask's Request as this one's.
      if (created.replayed)
        throw new OpensteerError({
          code: "conflict",
          reason: "command-already-asked",
          message: "You already asked about this. Wait for the answer, or withdraw that Request.",
        });
      // The open-ask index holds one ask per proposer and thing: a racing twin collides here.
      await transaction
        .updateTable("requests")
        .set({ command: partValue(input.part) })
        .where("id", "=", created.request.id)
        .execute()
        .catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "23505")
            throw new OpensteerError({
              code: "conflict",
              reason: "command-already-asked",
              message:
                "You already asked about this. Wait for the answer, or withdraw that Request.",
            });
          throw error;
        });
      return {
        status: "pending" as const,
        request: await refreshRequestState(transaction, created.request.id),
        replayed: false,
      };
    });
  }

  /** An agent withdraws its own ask, by its lineage; another's reads as not there. */
  async withdraw(input: {
    readonly ownerUserId: UserId;
    readonly requestId: RequestId;
    readonly proposerKey: string;
    /**
     * Under a connection's grant: whether the caller still reaches what the ask governs, read in
     * this transaction. One it no longer reaches reads as one that never existed (rule 5).
     */
    readonly reaches?: (
      transaction: Kysely<DatabaseSchema>,
      part: CommandRequestPart,
    ) => Promise<boolean>;
  }): Promise<
    | { readonly status: "withdrawn"; readonly requestId: RequestId }
    | Exclude<CommandRequestOpened, { readonly status: "pending" }>
  > {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const asked = await transaction
        .selectFrom("requests")
        .select(["originatingThreadId", "command"])
        .where("id", "=", input.requestId)
        .where("requestedBy", "=", input.ownerUserId)
        .where("command", "is not", null)
        .executeTakeFirst();
      const askedPart = asked ? CommandRequestPartSchema.parse(asked.command) : null;
      // The caller's reach first, in this transaction: a connection is taken before any task.
      if (
        !asked ||
        !askedPart ||
        askedPart.proposer.key !== input.proposerKey ||
        (input.reaches && !(await input.reaches(transaction, askedPart)))
      )
        throw unavailable();
      await lockRequestThreads(transaction, [asked.originatingThreadId]);
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", input.requestId)
        .where("requestedBy", "=", input.ownerUserId)
        .where("command", "is not", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const part = row ? CommandRequestPartSchema.parse(row.command) : null;
      if (!row || !part || part.proposer.key !== input.proposerKey) throw unavailable();
      const settled = commandRequestState(row);
      if (settled) return settled;
      const now = this.#now();
      const withdrawn = await transaction
        .updateTable("requests")
        .set({ status: "withdrawn", resolvedAt: now, resolvedBy: input.ownerUserId })
        .where("id", "=", row.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(withdrawn);
      if (!request.originatingAgentSessionId) await enqueueContinuation(transaction, request, now);
      await refreshRequestState(transaction, request.id);
      return { status: "withdrawn" as const, requestId: request.id };
    });
  }

  /**
   * Closes an ask its proposer can no longer make (its connection ended, or its grant no longer
   * covers it): nothing runs, and the agent that asked is told.
   */
  async close(requestId: RequestId): Promise<void> {
    await commitPersonalMutation(this.#database, async (transaction) => {
      const origin = await transaction
        .selectFrom("requests")
        .select("originatingThreadId")
        .where("id", "=", requestId)
        .executeTakeFirst();
      if (!origin) return;
      await lockRequestThreads(transaction, [origin.originatingThreadId]);
      const row = await transaction
        .updateTable("requests")
        .set({
          status: "cancelled",
          cancellationReason: "authority-revoked",
          resolvedAt: this.#now(),
          resolvedBy: null,
        })
        .where("id", "=", requestId)
        .where("status", "=", "pending")
        .where("command", "is not", null)
        .returningAll()
        .executeTakeFirst();
      if (!row) return;
      const request = requestFromRow(row);
      if (!request.originatingAgentSessionId)
        await enqueueContinuation(transaction, request, this.#now());
      await refreshRequestState(transaction, request.id);
    });
  }

  /**
   * The person declines. Whatever an app sends through `request.respond` on a command Request is a
   * decline, since approving is never a form answer; any words in it are handed to the agent.
   */
  async decline(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<{ readonly request: Request }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const row = await this.#lockPending(transaction, input);
      const now = this.#now();
      const resolved = await transaction
        .updateTable("requests")
        .set({
          status: "declined",
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          response: jsonValue(input.response),
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      const request = requestFromRow(resolved);
      // A Run or a program wakes with the answer; a connected agent reads it through its tool.
      if (!request.originatingAgentSessionId) await enqueueContinuation(transaction, request, now);
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      return { request: await refreshRequestState(transaction, request.id) };
    });
  }

  /**
   * Phase one of an approval: the person's answer is recorded and the command marked running, in
   * one transaction. Nothing has run yet; if the Home stops before phase two, the outcome is
   * `unknown` and the command never runs again.
   */
  async beginApproval(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    /** The command the person approves must change what was asked: the same type and thing. */
    readonly accept: (part: CommandRequestPart) => void;
    /** The approving call's key, and the command that will run, kept apart from the proposal. */
    readonly approvalKey: string;
    readonly approved: NonNullable<CommandRequestPart["approved"]>;
    /**
     * The Home's words for the Request computed again in this transaction, under its lock: a new
     * part and card when they no longer read as the person reviewed them, else null. Then the
     * Request is written anew under a new revision and nothing is approved.
     */
    readonly checkWords?: (
      transaction: Transaction<DatabaseSchema>,
      part: CommandRequestPart,
    ) => Promise<{
      readonly part: CommandRequestPart;
      readonly presentation: RequestPresentation;
    } | null>;
    /**
     * Whether its proposer could still ask for this command, read in this same transaction: a
     * Disconnect or a narrowing up to the commit is seen, and the ask closes with nothing run.
     */
    readonly stillAsks?: (transaction: Transaction<DatabaseSchema>) => Promise<boolean>;
  }): Promise<
    | {
        readonly request: Request;
        readonly part: CommandRequestPart;
        readonly closed?: never;
        readonly replayed?: never;
        readonly changed?: never;
      }
    | { readonly closed: true; readonly replayed?: never; readonly changed?: never }
    | {
        readonly replayed: CommandRequestOutcome;
        readonly closed?: never;
        readonly changed?: never;
      }
    | { readonly changed: true; readonly closed?: never; readonly replayed?: never }
  > {
    // The same approval sent twice at once: the one that waited reads what the first came to.
    return this.#beginApproval(input).catch((error: unknown) => {
      if (error instanceof ApprovalReplay) return { replayed: error.outcome };
      throw error;
    });
  }
  #beginApproval(input: Parameters<CommandRequestStore["beginApproval"]>[0]) {
    return commitPersonalMutation(this.#database, async (transaction) => {
      // The proposer first: its connection row is held for share until this commits, so a
      // narrowing or a Disconnect waits for the approval or is seen by it (lock order: the
      // connection before the task and the Request).
      const asks = input.stillAsks ? await input.stillAsks(transaction) : true;
      // An answer passes the Request's origin rule; closing the ask of a proposer that may no
      // longer ask only takes authority away, so it closes even once that origin has ended.
      const row = await this.#lockPending(transaction, input, {
        checkConnection: asks,
        approvalKey: input.approvalKey,
      });
      const part = CommandRequestPartSchema.parse(row.command);
      input.accept(part);
      const now = this.#now();
      // Only once the proposer may still ask are the Home's words looked up again (rule 5).
      const rewritten = asks && input.checkWords ? await input.checkWords(transaction, part) : null;
      if (rewritten) {
        await transaction
          .updateTable("requests")
          .set({
            command: partValue(rewritten.part),
            presentation: jsonValue(rewritten.presentation),
          })
          .where("id", "=", row.id)
          .execute();
        await refreshRequestState(transaction, row.id);
        return { changed: true as const };
      }
      if (!asks) {
        const closed = await transaction
          .updateTable("requests")
          .set({
            status: "cancelled",
            cancellationReason: "authority-revoked",
            resolvedAt: now,
            resolvedBy: null,
          })
          .where("id", "=", row.id)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        const request = requestFromRow(closed);
        if (!request.originatingAgentSessionId)
          await enqueueContinuation(transaction, request, now);
        await refreshRequestState(transaction, request.id);
        return { closed: true as const };
      }
      const resolved = await transaction
        .updateTable("requests")
        .set({
          status: "fulfilled",
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          response: jsonValue({ kind: "external", value: { decision: "fulfilled" } }),
          presentation: jsonValue(
            settledPresentation(row.presentation, part, { status: "running" }),
          ),
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
          command: partValue({
            ...part,
            outcome: { status: "running" },
            approvalKey: input.approvalKey,
            approved: input.approved,
          }),
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      // The command's own record: the person ran it, on this session, at this agent's proposal.
      await transaction
        .insertInto("securityAudit")
        .values({
          id: createId("securityAudit"),
          action: "command.approved",
          actorUserId: input.resolvedBy,
          actorSessionId: (input.settlementSessionId ?? null) as never,
          requestId: row.id,
          targetType: part.governs.kind,
          targetId: part.governs.id,
          metadata: jsonValue({
            type: part.type,
            proposedBy: {
              kind: part.proposer.kind,
              name: part.proposer.name,
              key: part.proposer.key,
            },
          }),
        })
        .execute();
      await requestSettlementActor(transaction, input.resolvedBy, input.settlementSessionId);
      await refreshRequestState(transaction, row.id);
      return { request: requestFromRow(resolved), part };
    });
  }

  /** Phase two: what the approved command came to, then the agent that asked is woken. */
  async settle(requestId: RequestId, outcome: CommandRequestOutcome): Promise<Request> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const row = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", requestId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const part = CommandRequestPartSchema.parse(row.command);
      // Only a running approval settles, once: unknown stays unknown.
      if (part.outcome?.status !== "running") return requestFromRow(row);
      // `fulfilled` means the person said yes; the card's own words now say what happened.
      await transaction
        .updateTable("requests")
        .set({
          command: partValue({ ...part, outcome }),
          presentation: jsonValue(settledPresentation(row.presentation, part, outcome)),
        })
        .where("id", "=", requestId)
        .execute();
      const request = await refreshRequestState(transaction, requestId);
      if (!request.originatingAgentSessionId)
        await enqueueContinuation(transaction, request, this.#now());
      return request;
    });
  }

  /**
   * After a restart: an approval that was running when the Home stopped may have taken effect.
   * It is settled `unknown`, and the agent is told so; the Home never runs it again. Served by
   * its own partial index, however many Requests the Home has.
   */
  async recoverRunning(): Promise<{ readonly recovered: readonly RequestId[] }> {
    const rows = await this.#database
      .selectFrom("requests")
      .select("id")
      // Literal, as the partial index is written, so it serves every plan.
      .where(sql<boolean>`status = 'fulfilled' and (command->'outcome'->>'status') = 'running'`)
      .execute();
    const running = rows.map((row) => row.id);
    for (const id of running) await this.reconcileRunning(id);
    return { recovered: running };
  }

  async #lockPending(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly requestId: RequestId;
      readonly expectedRevision: string;
      readonly resolvedBy: UserId;
    },
    options?: { readonly checkConnection?: boolean; readonly approvalKey?: string },
  ) {
    const origin = await transaction
      .selectFrom("requests")
      .select("originatingThreadId")
      .where("id", "=", input.requestId)
      .executeTakeFirst();
    if (origin) await lockRequestThreads(transaction, [origin.originatingThreadId]);
    const row = await transaction
      .selectFrom("requests")
      .selectAll()
      .where("id", "=", input.requestId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!row || row.command === null || row.requestedBy !== input.resolvedBy)
      throw new OpensteerError({ code: "not_found", message: "Request not found" });
    if (row.status !== "pending" && options?.approvalKey !== undefined) {
      const part = CommandRequestPartSchema.safeParse(row.command);
      if (part.success && part.data.approvalKey === options.approvalKey)
        throw new ApprovalReplay(part.data.outcome ?? { status: "running" });
    }
    if (row.status !== "pending")
      throw new OpensteerError({ code: "conflict", message: "Request is no longer pending" });
    assertRequestRevision(row, input.expectedRevision);
    await lockActiveDurableRequestAuthority(transaction, requestFromRow(row), options);
    return row;
  }
}

/** The approval this key already made, found under the Request's lock: answered, not repeated. */
class ApprovalReplay extends Error {
  readonly outcome: CommandRequestOutcome;
  constructor(outcome: CommandRequestOutcome) {
    super("This approval was already made");
    this.outcome = outcome;
  }
}
