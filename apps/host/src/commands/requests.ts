import { createHash } from "node:crypto";
import {
  isRaisedBeforeEffect,
  OpensteerError,
  RequestJsonObjectSchema,
  requestTitleMaxLength,
  type CommandRequestOutcome,
  type CommandRequestPart,
  type Request,
  type RequestId,
  type RequestPresentation,
  type RequestResponse,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  admitCommand,
  commandRequestLifetimeMs,
  commandSubject,
  type CommandRequestOrigin,
  type CommandRequestStore,
  type DatabaseSchema,
} from "@opensteer/database";
import { hostApi, type HostApiCommand, type HostApiCommandOutput } from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import {
  commandAgentOutput,
  commandEffect,
  commandResourceKey,
  commandRow,
  type CommandResource,
  type CommandRow,
} from "@opensteer/protocol/command-table";
import {
  commandAskedFace,
  commandEditor,
  commandGives,
  commandSentence,
} from "@opensteer/protocol/command-words";
import { sql, type Kysely } from "kysely";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { CommandAsk } from "./dispatch.js";
import type { PersonActor } from "./actor.js";

/**
 * The root of a proposer's lineage: the top task of a task tree for a Run, the automation for a
 * program, the connection for any of its sessions and Runs. The one open ask, the cap and the
 * remembered decline all count per root, so a child task, another run of the same automation or
 * another session of the same connection is the same proposer. Made only by
 * `proposerLineageKey`.
 */
export type ProposerLineageKey = string & { readonly __proposerLineage: unique symbol };

/** The lineage root of an agent the Home authenticated, from the Home's own rows. */
export async function proposerLineageKey(
  database: Kysely<DatabaseSchema>,
  caller: AgentCaller,
): Promise<ProposerLineageKey> {
  const connectionId =
    caller.kind === "connection" ? caller.connectionId : caller.agentConnection?.agentConnectionId;
  if (connectionId) return `connection:${connectionId}` as ProposerLineageKey;
  if (caller.kind === "program") {
    const triggerId =
      caller.program.kind === "watch"
        ? caller.program.triggerId
        : (
            await database
              .selectFrom("triggerOccurrences")
              .select("triggerId")
              .where("id", "=", caller.program.occurrenceId)
              .executeTakeFirstOrThrow()
          ).triggerId;
    return `automation:${triggerId}` as ProposerLineageKey;
  }
  if (caller.kind !== "run")
    throw new OpensteerError({ code: "internal", message: "Unknown proposer" });
  return `task:${await rootTask(database, caller.thread.id)}` as ProposerLineageKey;
}

/** The top task of a task tree, by the parent each task was made under. */
export async function rootTask(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
): Promise<ThreadId> {
  const { rows } = await sql<{ id: ThreadId }>`with recursive up as (
      select id, parent_thread_id, 0 as depth from threads where id = ${threadId}
      union all
      select parent.id, parent.parent_thread_id, up.depth + 1
      from threads parent join up on parent.id = up.parent_thread_id where up.depth < 64
    ) select id from up order by depth desc limit 1`.execute(database);
  return rows[0]?.id ?? threadId;
}

/** Who proposed a command, as the person knows them. Built by the tool that carried it. */
export interface CommandProposer {
  readonly kind: CommandRequestPart["proposer"]["kind"];
  /** The engine, the automation or the connected agent's label. */
  readonly name: string;
  readonly taskTitle: string | null;
  readonly key: ProposerLineageKey;
  /** The connection whose lineage it works in, if any, and its grant revision when it asked. */
  readonly connectionId?: string;
  readonly grantRevision?: number;
}

/** What an agent's proposal came to: a Request the person has, or what became of it. */
export type CommandProposed =
  | {
      readonly status: "pending";
      readonly requestId: RequestId;
      /** The same ask was already open (or this call already opened it). */
      readonly existing: boolean;
    }
  | { readonly status: "declined"; readonly requestId: RequestId }
  | { readonly status: "expired"; readonly requestId: RequestId }
  | { readonly status: "withdrawn"; readonly requestId: RequestId }
  /** Closed without an answer: the agent could no longer ask for it, or its task ended. */
  | { readonly status: "closed"; readonly requestId: RequestId }
  /** The person approved it: what it came to. */
  | {
      readonly status: "answered";
      readonly requestId: RequestId;
      readonly outcome: CommandRequestOutcome;
    };

/** The form field an app without the command part answers; whatever it sends declines. */
export const commandDecisionFieldId = "decision";
const approvingNeedsAnUpdatedApp = "Approving this needs an up-to-date Opensteer app.";
const maxResultBytes = 64 * 1_024;
/** A name inside the Home's sentence is cut, so the sentence itself always fits whole. */
const maxNameLength = 80;
/** What the proposer is told of a refusal: the Home's words, never the handler's. */
export const commandRefusedWords = "The Home refused it, so nothing changed.";

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** The command as an agent may store it: no key, no value only the person types. */
export function proposedCommand(row: CommandRow, command: HostApiCommand): Record<string, unknown> {
  const copy = structuredClone(command) as Record<string, unknown>;
  delete copy.idempotencyKey;
  for (const path of row.secretFields ?? []) {
    const keys = path.split(".");
    let at: unknown = copy;
    for (const key of keys.slice(0, -1))
      at = typeof at === "object" && at !== null ? (at as Record<string, unknown>)[key] : undefined;
    if (typeof at === "object" && at !== null) delete (at as Record<string, unknown>)[keys.at(-1)!];
  }
  return copy;
}

/**
 * The person's Requests for commands agents propose: what the person sees is the change itself,
 * in the Home's words, never the agent's; approving runs the command as the person, on the
 * person's session, through the door; a secret is typed on the person's screen and never stored.
 */
export class CommandRequestService {
  readonly #store: CommandRequestStore;
  readonly #database: Kysely<DatabaseSchema>;
  readonly #requests: { get(id: RequestId): Promise<Request | null> };
  readonly #expiry: CommandRequestExpiry | undefined;
  constructor(options: {
    readonly store: CommandRequestStore;
    readonly database: Kysely<DatabaseSchema>;
    readonly requests: { get(id: RequestId): Promise<Request | null> };
    /** The one timer for the earliest open ask's end; armed as asks open. */
    readonly expiry?: CommandRequestExpiry;
  }) {
    this.#store = options.store;
    this.#database = options.database;
    this.#requests = options.requests;
    this.#expiry = options.expiry;
  }

  /** Opens the person's Request for a command the door put to the person. */
  async propose(input: {
    readonly ownerUserId: UserId;
    readonly command: HostApiCommand;
    readonly ask: CommandAsk;
    readonly face: number | undefined;
    readonly proposer: CommandProposer;
    readonly origin: CommandRequestOrigin;
    readonly originatingThreadId: ThreadId;
    /** The agent's own key for this call: the same call is the same Request. */
    readonly callKey: string;
    readonly reason?: string | undefined;
  }): Promise<CommandProposed> {
    const row = commandRow(input.command.type) as CommandRow;
    const face = commandAskedFace(input.command.type, input.face);
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(input.command);
    const stored = proposedCommand(row, input.command);
    const names = await this.#name(governs, input.ownerUserId);
    const named = commandSentence(input.command, () => names).slice(0, requestTitleMaxLength);
    const asker = askedBy(input.proposer);
    const summary = titleFirst(named, ` · ${asker}`);
    const gives = commandGives(input.command, face);
    const reason = input.reason?.trim().slice(0, 500) || null;
    const part: CommandRequestPart = {
      type: input.command.type,
      family: row.family,
      face: row.faces[face]!.class,
      summary,
      sentence: named,
      gives,
      command: RequestJsonObjectSchema.parse(JSON.parse(JSON.stringify(stored))),
      secretPaths: [...(row.secretFields ?? [])],
      governs: JSON.parse(JSON.stringify(governs)) as CommandRequestPart["governs"],
      askKey: digest([input.proposer.key, input.command.type, commandResourceKey(governs)]),
      argumentsDigest: digest(stored),
      proposer: { ...input.proposer },
      agentReason: reason,
      editor: commandEditor(input.command.type),
    };
    const opened = await this.#store.open({
      ownerUserId: input.ownerUserId,
      callId: `command:${input.proposer.key}:${input.callKey}`.slice(0, 512),
      origin: input.origin,
      originatingThreadId: input.originatingThreadId,
      part,
      presentation: commandPresentation(part, named, asker),
    });
    if (opened.status !== "pending") return opened;
    if (!opened.replayed)
      this.#expiry?.arm(new Date(Date.parse(opened.request.createdAt) + commandRequestLifetimeMs));
    return { status: "pending", requestId: opened.request.id, existing: opened.replayed };
  }

  /** An agent withdraws its own ask; another's is not there for it. */
  withdraw(input: {
    readonly ownerUserId: UserId;
    readonly requestId: RequestId;
    readonly proposerKey: ProposerLineageKey;
  }): Promise<CommandProposed> {
    return this.#store.withdraw(input);
  }

  /**
   * The person declines. Whatever an app sends through `request.respond` on a command Request,
   * a choice, a form, free text, is a decline: approving is never a form answer.
   */
  decline(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }) {
    return this.#store.decline(input);
  }

  /**
   * The person approves the command, as proposed or as they changed it on its screen. It must be
   * the same type and change the same thing; it runs as the person through `run`, the door. The
   * answer is recorded before it runs and its outcome after; an outcome lost in between is
   * `unknown`, and nothing runs it again.
   */
  async approve(
    actor: PersonActor,
    input: {
      readonly requestId: RequestId;
      readonly expectedRevision: string;
      readonly command: Readonly<Record<string, unknown>>;
      /** The approving call's own key: the same approval again answers with its outcome. */
      readonly idempotencyKey: string;
    },
    run: (person: PersonActor, command: HostApiCommand) => Promise<HostApiCommandOutput>,
    person: (proposal: NonNullable<PersonActor["proposal"]>) => PersonActor,
  ): Promise<CommandRequestOutcome> {
    const pending = await this.#requests.get(input.requestId);
    if (!pending?.command || pending.requestedBy !== actor.userId)
      throw new OpensteerError({ code: "not_found", message: "Request not found" });
    // The same approval again: what the first one came to, and nothing runs twice.
    if (pending.status !== "pending" && pending.command.approvalKey === input.idempotencyKey)
      return pending.command.outcome ?? { status: "running" };
    const parsed = hostApi["commands.dispatch"].payload.safeParse({
      ...input.command,
      type: pending.command.type,
      idempotencyKey: `command-request:${input.requestId}`,
    });
    if (!parsed.success)
      throw new OpensteerError({
        code: "bad_request",
        message: "That command is not valid as changed. Check its fields and approve again.",
      });
    const command = parsed.data;
    if (input.command.type !== undefined && input.command.type !== pending.command.type)
      throw changesWhatWasAsked();
    const row = commandRow(command.type) as CommandRow;
    const governs = (row.governs as (c: HostApiCommand) => CommandResource)(command);
    // A connection's ask is answerable only while it could still ask for this: a Disconnect or a
    // narrowing since closes it, and nothing runs.
    const connectionId = pending.command.proposer.connectionId;
    if (connectionId && !(await this.#stillAsks(actor.userId, connectionId, command))) {
      await this.#store.close(input.requestId);
      throw new OpensteerError({
        code: "forbidden",
        reason: "proposer-gone",
        message: "The agent that asked can no longer ask for this, so its Request closed.",
      });
    }
    const approved = RequestJsonObjectSchema.parse(
      JSON.parse(JSON.stringify(proposedCommand(row, command))),
    );
    await this.#store.beginApproval({
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      resolvedBy: actor.userId,
      settlementSessionId: actor.session.id,
      approvalKey: input.idempotencyKey,
      approved: {
        command: approved,
        changed: digest(approved) !== pending.command.argumentsDigest,
      },
      accept: (part) => {
        if (part.type !== command.type) throw changesWhatWasAsked();
        if (
          commandResourceKey(governs) !==
          commandResourceKey(part.governs as unknown as CommandResource)
        )
          throw changesWhatWasAsked();
      },
    });
    const approver = person({
      requestId: input.requestId,
      revision: input.expectedRevision,
      proposedBy: { ...pending.command.proposer },
    });
    let outcome: CommandRequestOutcome;
    try {
      const output = await run(approver, command);
      // Exactly what the door gives that agent for this command when it runs it itself.
      const result = JSON.parse(JSON.stringify(commandAgentOutput(command, output) ?? null));
      outcome =
        JSON.stringify(result).length <= maxResultBytes
          ? { status: "done", result }
          : { status: "done" };
    } catch (error) {
      // Unknown is the default: failed only where nothing can have left the Home, a command whose
      // handler changes the Home's database alone (a throw rolled it back), or a refusal marked
      // where it was raised, before anything was sent. The proposer reads the Home's words only.
      outcome =
        commandEffect(row) === "database" || isRaisedBeforeEffect(error)
          ? {
              status: "failed",
              code: error instanceof OpensteerError ? error.code : "internal",
              message: commandRefusedWords,
            }
          : { status: "unknown" };
    }
    await this.#store.settle(input.requestId, outcome);
    return outcome;
  }

  /** Whether the proposing connection could still ask for this command, as it is now. */
  async #stillAsks(owner: UserId, connectionId: string, command: HostApiCommand): Promise<boolean> {
    try {
      const admission = await admitCommand(this.#database, {
        ownerUserId: owner,
        subject: commandSubject(`connection:${connectionId}`),
        command,
      });
      return admission.answer !== "not_found";
    } catch (error) {
      if (error instanceof OpensteerError && ["forbidden", "not_found"].includes(error.code))
        return false;
      throw error;
    }
  }

  /** The governed thing as the person's apps name it, where the Home can tell cheaply. */
  async #name(resource: CommandResource, owner: UserId): Promise<string | null> {
    const id = resource.id;
    const database = this.#database;
    const quoted = (value: string | null | undefined) =>
      value
        ? `“${value.length > maxNameLength ? `${value.slice(0, maxNameLength - 1)}…` : value}”`
        : null;
    if (id === null) return null;
    switch (resource.kind) {
      case "task":
        return quoted(
          (
            await database
              .selectFrom("threads")
              .select("title")
              .where("id", "=", id as ThreadId)
              .where("createdBy", "=", owner)
              .executeTakeFirst()
          )?.title,
        );
      case "connection":
        return quoted(
          (
            await database
              .selectFrom("agentConnections")
              .select("label")
              .where("id", "=", id)
              .where("userId", "=", owner)
              .executeTakeFirst()
          )?.label,
        );
      case "device":
        return quoted(
          (
            await database
              .selectFrom("devices")
              .select("name")
              .where("id", "=", id as never)
              .executeTakeFirst()
          )?.name,
        );
      case "browser-profile":
        return quoted(
          (
            await database
              .selectFrom("browserProfiles")
              .select("name")
              .where("id", "=", id as never)
              .where("ownerId", "=", owner)
              .executeTakeFirst()
          )?.name,
        );
      case "automation":
        return quoted(
          (
            await database
              .selectFrom("triggers")
              .select("name")
              .where("id", "=", id as never)
              .where("createdBy", "=", owner)
              .executeTakeFirst()
          )?.name,
        );
      default:
        return null;
    }
  }
}

/** Who asked, marked as the agent's own: its name and its task's title are its words. */
function askedBy(proposer: CommandProposer): string {
  return proposer.taskTitle
    ? `Asked by the agent “${proposer.name}”, in its task “${proposer.taskTitle}”`
    : `Asked by the agent “${proposer.name}”`;
}

/** The Home's sentence first and whole; whatever follows is cut to fit the title. */
export function titleFirst(sentence: string, rest: string): string {
  const room = requestTitleMaxLength - sentence.length;
  if (room <= 1) return sentence.slice(0, requestTitleMaxLength);
  return rest.length <= room ? `${sentence}${rest}` : `${sentence}${rest.slice(0, room - 1)}…`;
}

/** What an app shows that does not read the command part: true, and enough by itself. */
export function commandPresentation(
  part: CommandRequestPart,
  sentence: string,
  asker: string,
): RequestPresentation {
  const lines = [
    `What changes: ${sentence}`,
    `${asker}.`,
    `As proposed: ${JSON.stringify(part.command)}`.slice(0, 4_000),
  ];
  if (part.gives) lines.push(part.gives);
  lines.push(approvingNeedsAnUpdatedApp);
  if (part.agentReason)
    lines.push(`The agent's own reason (its words, not checked): ${part.agentReason}`);
  return {
    kind: "form",
    title: part.summary,
    detail: lines.join("\n\n"),
    detailFormat: "plain",
    fields: [
      {
        id: commandDecisionFieldId,
        prompt: "Decline it here, or approve it in an up-to-date Opensteer app.",
        choices: [{ label: "Decline", value: "decline" }],
        custom: true,
        multiSelect: false,
        secret: false,
      },
    ],
  };
}

/**
 * One timer for the earliest open ask's end, and none while none is open: an idle Home does no
 * periodic work for asks. Each pass expires what is due and arms for the next.
 */
export class CommandRequestExpiry {
  readonly #store: CommandRequestStore;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #at: number | undefined;
  #stopped = false;
  constructor(store: CommandRequestStore, onError: (error: unknown) => void) {
    this.#store = store;
    this.#onError = onError;
  }
  /** Wakes at `at` unless an earlier wake is armed. */
  arm(at: Date | null): void {
    if (this.#stopped || at === null) return;
    const when = at.getTime();
    if (this.#at !== undefined && this.#at <= when) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#at = when;
    // A timer holds at most about 24.8 days; an ask lives one.
    this.#timer = setTimeout(() => void this.#pass(), Math.max(0, when - Date.now()));
    this.#timer.unref?.();
  }
  /** Whether a wake is armed. */
  get armed(): boolean {
    return this.#timer !== undefined;
  }
  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  async #pass(): Promise<void> {
    this.#timer = undefined;
    this.#at = undefined;
    try {
      await this.#store.expire();
      this.arm(await this.#store.nextExpiry());
    } catch (error) {
      this.#onError(error);
      // A failed pass is tried again; it never leaves asks unexpired for good.
      this.arm(new Date(Date.now() + 60_000));
    }
  }
}

function changesWhatWasAsked(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason: "command-changed",
    message: "That changes what was asked. Change only how, not what.",
  });
}
