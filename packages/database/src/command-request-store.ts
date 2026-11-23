import {
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
      readonly status: "declined" | "withdrawn" | "closed";
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
}): Exclude<CommandRequestOpened, { readonly status: "pending" }> | undefined {
  const part = CommandRequestPartSchema.parse(row.command);
  switch (row.status) {
    case "pending":
      return undefined;
    case "declined":
      return { status: "declined", requestId: row.id };
    case "withdrawn":
      return { status: "withdrawn", requestId: row.id };
    case "fulfilled":
      return {
        status: "answered",
        requestId: row.id,
        outcome: part.outcome ?? { status: "running" },
      };
    default:
      return { status: "closed", requestId: row.id };
  }
}

/** The card's words once the person has answered, so every app reads what happened. */
export function settledPresentation(
  presentation: RequestPresentation,
  part: CommandRequestPart,
  outcome: CommandRequestOutcome,
): RequestPresentation {
  const sentence = part.sentence ?? part.summary;
  const changed = part.approved?.changed ? " You changed it before approving." : "";
  const [title, said] =
    outcome.status === "done"
      ? ["Done", `You approved this, and it was done.${changed}`]
      : outcome.status === "failed"
        ? [
            "Did not happen",
            `You approved this, but the Home refused it, so nothing changed.${changed}`,
          ]
        : outcome.status === "unknown"
          ? [
              "May have happened",
              `You approved this, but the Home could not tell whether it finished. It may have happened: check before doing it again. The Home will not run it again.${changed}`,
            ]
          : ["Approved", `You approved this, and it is being done.${changed}`];
  const rest = presentation.detail?.split("\n\n");
  return {
    ...presentation,
    title: `${title}: ${sentence}`.slice(0, 240),
    detail: [said, ...(rest ?? [])].join("\n\n").slice(0, 16_000),
  };
}

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
   * arguments is the open one; with other arguments it is a conflict. That is the one rule: an
   * ask waits until the person answers or its proposer withdraws it, and a declined ask may be
   * asked again (whether to is the agent's judgement).
   */
  async open(input: {
    readonly ownerUserId: UserId;
    readonly callId: string;
    readonly origin: CommandRequestOrigin;
    readonly originatingThreadId: ThreadId;
    readonly part: CommandRequestPart;
    readonly presentation: RequestPresentation;
  }): Promise<CommandRequestOpened> {
    return this.#open(input);
  }

  #open(input: {
    readonly ownerUserId: UserId;
    readonly callId: string;
    readonly origin: CommandRequestOrigin;
    readonly originatingThreadId: ThreadId;
    readonly part: CommandRequestPart;
    readonly presentation: RequestPresentation;
  }): Promise<CommandRequestOpened> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const owner = input.ownerUserId;
      // The same call (the agent's own key) replays its Request, whatever happened since.
      const replay = await transaction
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
        return { status: "pending" as const, request: requestFromRow(open), replayed: true };
      }
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
  }): Promise<
    | { readonly status: "withdrawn"; readonly requestId: RequestId }
    | Exclude<CommandRequestOpened, { readonly status: "pending" }>
  > {
    return commitPersonalMutation(this.#database, async (transaction) => {
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
        .where("requestedBy", "=", input.ownerUserId)
        .where("command", "is not", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || CommandRequestPartSchema.parse(row.command).proposer.key !== input.proposerKey)
        throw new OpensteerError({ code: "not_found", message: "That item is unavailable." });
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
     * Whether its proposer could still ask for this command, read in this same transaction: a
     * Disconnect or a narrowing up to the commit is seen, and the ask closes with nothing run.
     */
    readonly stillAsks?: (transaction: Transaction<DatabaseSchema>) => Promise<boolean>;
  }): Promise<
    | { readonly request: Request; readonly part: CommandRequestPart; readonly closed?: never }
    | { readonly closed: true }
  > {
    return commitPersonalMutation(this.#database, async (transaction) => {
      // The proposer first: its connection row is held for share until this commits, so a
      // narrowing or a Disconnect waits for the approval or is seen by it (lock order: the
      // connection before the task and the Request).
      const asks = input.stillAsks ? await input.stillAsks(transaction) : true;
      const row = await this.#lockPending(transaction, input);
      const part = CommandRequestPartSchema.parse(row.command);
      input.accept(part);
      const now = this.#now();
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
            changed: input.approved.changed,
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
    for (const id of running) await this.settle(id, { status: "unknown" });
    return { recovered: running };
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
    assertRequestRevision(row, input.expectedRevision);
    await lockActiveDurableRequestAuthority(transaction, requestFromRow(row));
    return row;
  }
}
