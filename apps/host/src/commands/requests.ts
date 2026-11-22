import { createHash } from "node:crypto";
import {
  OpensteerError,
  RequestJsonObjectSchema,
  type CommandRequestOutcome,
  type CommandRequestPart,
  type Request,
  type RequestId,
  type RequestPresentation,
  type RequestResponse,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type {
  CommandRequestOrigin,
  CommandRequestStore,
  DatabaseSchema,
} from "@opensteer/database";
import { hostApi, type HostApiCommand, type HostApiCommandOutput } from "@opensteer/protocol";
import {
  commandAgentOutput,
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
import type { Kysely } from "kysely";
import type { CommandAsk } from "./dispatch.js";
import type { PersonActor } from "./actor.js";

/** Who proposed a command, as the person knows them. Built by the tool that carried it. */
export interface CommandProposer {
  readonly kind: CommandRequestPart["proposer"]["kind"];
  /** The engine, the automation or the connected agent's label. */
  readonly name: string;
  readonly taskTitle: string | null;
  /** One proposer: its task, its automation or its connection. */
  readonly key: string;
}

/** What an agent's proposal came to: a Request the person has, or a decline remembered for it. */
export type CommandProposed =
  | {
      readonly status: "pending";
      readonly requestId: RequestId;
      /** The same ask was already open (or this call already opened it). */
      readonly existing: boolean;
    }
  | { readonly status: "declined"; readonly requestId: RequestId };

/** The form field an app without the command part answers; whatever it sends declines. */
export const commandDecisionFieldId = "decision";
const approvingNeedsAnUpdatedApp = "Approving this needs an up-to-date Opensteer app.";
const maxResultBytes = 64 * 1_024;

/** One canonical JSON text: object keys sorted, so the same arguments digest the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
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
  constructor(options: {
    readonly store: CommandRequestStore;
    readonly database: Kysely<DatabaseSchema>;
    readonly requests: { get(id: RequestId): Promise<Request | null> };
  }) {
    this.#store = options.store;
    this.#database = options.database;
    this.#requests = options.requests;
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
    const named = commandSentence(input.command, () => names);
    const who = input.proposer.taskTitle
      ? `${input.proposer.name}, from the task “${input.proposer.taskTitle}”,`
      : input.proposer.name;
    const summary = `${who} wants to: ${named}`.slice(0, 240);
    const gives = commandGives(input.command, face);
    const reason = input.reason?.trim().slice(0, 500) || null;
    const part: CommandRequestPart = {
      type: input.command.type,
      family: row.family,
      face: row.faces[face]!.class,
      summary,
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
      presentation: commandPresentation(part, named),
    });
    return opened.status === "declined"
      ? { status: "declined", requestId: opened.request.id }
      : { status: "pending", requestId: opened.request.id, existing: opened.replayed };
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
    },
    run: (person: PersonActor, command: HostApiCommand) => Promise<HostApiCommandOutput>,
    person: (proposal: NonNullable<PersonActor["proposal"]>) => PersonActor,
  ): Promise<CommandRequestOutcome> {
    const pending = await this.#requests.get(input.requestId);
    if (!pending?.command || pending.requestedBy !== actor.userId)
      throw new OpensteerError({ code: "not_found", message: "Request not found" });
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
    await this.#store.beginApproval({
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      resolvedBy: actor.userId,
      settlementSessionId: actor.session.id,
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
      const result = JSON.parse(JSON.stringify(commandAgentOutput(command, output) ?? null));
      outcome =
        JSON.stringify(result).length <= maxResultBytes
          ? { status: "done", result }
          : { status: "done" };
    } catch (error) {
      outcome = refusedBeforeEffect(error)
        ? {
            status: "failed",
            code: (error as OpensteerError).code,
            message: (error as OpensteerError).message.slice(0, 2_000),
          }
        : { status: "unknown" };
    }
    await this.#store.settle(input.requestId, outcome);
    return outcome;
  }

  /** The governed thing as the person's apps name it, where the Home can tell cheaply. */
  async #name(resource: CommandResource, owner: UserId): Promise<string | null> {
    const id = resource.id;
    const database = this.#database;
    const quoted = (value: string | null | undefined) => (value ? `“${value}”` : null);
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

/** What an app shows that does not read the command part: true, and enough by itself. */
export function commandPresentation(
  part: CommandRequestPart,
  sentence: string,
): RequestPresentation {
  const lines = [
    `What changes: ${sentence}`,
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

function changesWhatWasAsked(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    reason: "command-changed",
    message: "That changes what was asked. Change only how, not what.",
  });
}

/** A refusal the Home gave before any effect: the command did not happen. Anything else may have. */
function refusedBeforeEffect(error: unknown): boolean {
  return (
    error instanceof OpensteerError &&
    ["bad_request", "conflict", "not_found", "forbidden", "unauthorized"].includes(error.code)
  );
}
