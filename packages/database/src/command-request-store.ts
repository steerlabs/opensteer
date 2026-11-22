import {
  CommandRequestPartSchema,
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

/** How long a proposed command waits for the person, as a connected agent's operation does. */
export const commandRequestLifetimeMs = 24 * 60 * 60_000;
/** How long a declined ask is answered at once as declined, for the same proposer and thing. */
export const commandDeclineMemoryMs = 24 * 60 * 60_000;
/**
 * Open command Requests one proposer may hold: a task rarely needs more than a few decisions at a
 * time, and Needs you is a list a person reads on a phone.
 */
export const commandRequestsPerProposer = 5;
/**
 * Open command Requests a Home holds from all its agents: under the 50 entries of a Needs-you
 * page, so agents' proposals never crowd out what else waits for the person.
 */
export const commandRequestsPerHome = 30;

/** Where a proposed command came from: exactly one execution the Home issued. */
export type CommandRequestOrigin =
  | { readonly runId: RunId }
  | { readonly occurrenceId: TriggerOccurrenceId }
  | { readonly watchActivationId: TriggerWatchActivationId }
  | { readonly agentSessionId: AgentSessionId };

export type CommandRequestOpened =
  | { readonly status: "pending"; readonly request: Request; readonly replayed: boolean }
  | { readonly status: "declined"; readonly request: Request };

/** The column as written: the part, validated, so a stored row always reads back. */
function partValue(part: CommandRequestPart) {
  return jsonValue(CommandRequestPartSchema.parse(part));
}

const pendingCommand = (database: Kysely<DatabaseSchema>, owner: UserId) =>
  database
    .selectFrom("requests")
    .where("requestedBy", "=", owner)
    .where("status", "=", "pending")
    .where("command", "is not", null);

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
   * arguments is the open one; with other arguments it is a conflict; a decline of it in the last
   * day is answered at once as declined; past the limits nothing opens.
   */
  async open(input: {
    readonly ownerUserId: UserId;
    readonly callId: string;
    readonly origin: CommandRequestOrigin;
    readonly originatingThreadId: ThreadId;
    readonly part: CommandRequestPart;
    readonly presentation: RequestPresentation;
  }): Promise<CommandRequestOpened> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const now = this.#now();
      const owner = input.ownerUserId;
      // The same call (the agent's own key) replays its Request, whatever happened since.
      const replay = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("callId", "=", input.callId)
        .where("requestedBy", "=", owner)
        .where("command", "is not", null)
        .executeTakeFirst();
      if (replay) return { status: "pending", request: requestFromRow(replay), replayed: true };
      const declined = await transaction
        .selectFrom("requests")
        .selectAll()
        .where("requestedBy", "=", owner)
        .where("status", "=", "declined")
        .where(sql<boolean>`command->>'askKey' = ${input.part.askKey}`)
        .where("resolvedAt", ">", new Date(now.getTime() - commandDeclineMemoryMs))
        .orderBy("resolvedAt", "desc")
        .executeTakeFirst();
      if (declined) return { status: "declined", request: requestFromRow(declined) };
      const open = await pendingCommand(transaction, owner)
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
        return { status: "pending", request: requestFromRow(open), replayed: true };
      }
      const counts = await pendingCommand(transaction, owner)
        .select([
          sql<number>`count(*)::integer`.as("home"),
          sql<number>`count(*) filter (where command->'proposer'->>'key' = ${input.part.proposer.key})::integer`.as(
            "proposer",
          ),
        ])
        .executeTakeFirstOrThrow();
      if (counts.proposer >= commandRequestsPerProposer || counts.home >= commandRequestsPerHome)
        throw new OpensteerError({
          code: "resource_exhausted",
          reason: "command-requests-full",
          message:
            counts.proposer >= commandRequestsPerProposer
              ? `You have ${commandRequestsPerProposer} changes waiting for the person. Wait for an answer, or withdraw one.`
              : "The person has many changes waiting. Wait for an answer before asking for more.",
        });
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
        status: "pending",
        request: await refreshRequestState(transaction, created.request.id),
        replayed: false,
      };
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
  }): Promise<{ readonly request: Request; readonly part: CommandRequestPart }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const row = await this.#lockPending(transaction, input);
      const part = CommandRequestPartSchema.parse(row.command);
      input.accept(part);
      const now = this.#now();
      const resolved = await transaction
        .updateTable("requests")
        .set({
          status: "fulfilled",
          resolvedAt: now,
          resolvedBy: input.resolvedBy,
          response: jsonValue({ kind: "external", value: { decision: "fulfilled" } }),
          settlementProvenance: await readRequestSettlementProvenance(
            transaction,
            input.resolvedBy,
            input.settlementSessionId,
          ),
          command: partValue({ ...part, outcome: { status: "running" } }),
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
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
      await transaction
        .updateTable("requests")
        .set({ command: partValue({ ...part, outcome }) })
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
   * It is settled `unknown`, and the agent is told so; the Home never runs it again.
   */
  async recoverRunning(): Promise<readonly RequestId[]> {
    const rows = await this.#database
      .selectFrom("requests")
      .select("id")
      .where("status", "=", "fulfilled")
      .where(sql<boolean>`command->'outcome'->>'status' = 'running'`)
      .execute();
    for (const { id } of rows) await this.settle(id, { status: "unknown" });
    return rows.map(({ id }) => id);
  }

  /** Asks no one answered within their lifetime end; the agent is told, and may ask again. */
  async expire(now = this.#now()): Promise<readonly RequestId[]> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const rows = await transaction
        .selectFrom("requests")
        .select(["id", "originatingThreadId"])
        .where("status", "=", "pending")
        .where("command", "is not", null)
        .where("createdAt", "<=", new Date(now.getTime() - commandRequestLifetimeMs))
        .orderBy("id")
        .execute();
      if (rows.length === 0) return [];
      await lockRequestThreads(
        transaction,
        rows.map((row) => row.originatingThreadId),
      );
      const expired = await transaction
        .updateTable("requests")
        .set({
          status: "cancelled",
          cancellationReason: "source-closed",
          resolvedAt: now,
          resolvedBy: null,
          command: sql`command || '{"expired": true}'::jsonb`,
        })
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .where("status", "=", "pending")
        .returningAll()
        .execute();
      for (const row of expired) {
        if (row.originatingAgentSessionId) {
          await refreshRequestState(transaction, row.id);
          continue;
        }
        await transaction
          .insertInto("requestContinuations")
          .values({
            requestId: row.id,
            status: "waiting",
            reason: null,
            attemptedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflict((conflict) => conflict.column("requestId").doNothing())
          .execute();
        await refreshRequestState(transaction, row.id);
      }
      return expired.map((row) => row.id);
    });
  }

  async #lockPending(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly requestId: RequestId;
      readonly expectedRevision: string;
      readonly resolvedBy: UserId;
    },
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
    if (row.status !== "pending")
      throw new OpensteerError({ code: "conflict", message: "Request is no longer pending" });
    if (row.createdAt.getTime() <= this.#now().getTime() - commandRequestLifetimeMs)
      throw new OpensteerError({
        code: "conflict",
        reason: "request-expired",
        message: "This Request expired. The agent may ask again.",
      });
    assertRequestRevision(row, input.expectedRevision);
    await lockActiveDurableRequestAuthority(transaction, requestFromRow(row));
    return row;
  }
}
