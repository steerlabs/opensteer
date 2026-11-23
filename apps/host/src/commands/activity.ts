import type { AgentCommandActivity, ThreadId, UserId } from "@opensteer/core";
import { CommandRequestPartSchema } from "@opensteer/core";
import { commandRequestState, type DatabaseSchema } from "@opensteer/database";
import {
  commandTable,
  type Command,
  type CommandResource,
  type CommandType,
} from "@opensteer/protocol/command-table";
import {
  commandAskedWords,
  commandDoneWords,
  commandTitles,
} from "@opensteer/protocol/command-words";
import { sql, type Kysely } from "kysely";

/** Whose activity: one connection's, or one task's. */
export type CommandActivityOf =
  | { readonly connectionId: string; readonly threadId?: never }
  | { readonly threadId: ThreadId; readonly connectionId?: never };

/** The span of a page of operations: older than `before`, and no older than `since`. */
export interface CommandActivitySpan {
  readonly before?: { readonly createdAt: Date; readonly id: string } | undefined;
  readonly since?: Date | undefined;
}

const pageLimit = 100;
const sentenceLimit = 600;

/**
 * The commands an agent sent through the door, as the person's activity shows them beside its
 * operations (C5): the door's own records, read as a second source. A command that ran at once
 * is its ledger row; one that asked is its Request, asked, then approved or ended. Each says,
 * in the Home's words, who sent it and from which task.
 */
export async function commandActivity(
  database: Kysely<DatabaseSchema>,
  naming: { name(resource: CommandResource, owner: UserId): Promise<string | null> },
  input: { readonly userId: UserId } & CommandActivityOf & CommandActivitySpan,
): Promise<readonly AgentCommandActivity[]> {
  const callerKey = sql<string>`commands.authority_source->>'callerKey'`;
  let ledger = database
    .selectFrom("commands")
    .select(["commands.id", "commands.type", "commands.payload", "commands.status"])
    .select(["commands.createdAt", callerKey.as("callerKey")])
    .where("commands.requestedBy", "=", input.userId)
    .where(sql<string>`commands.authority_source->>'kind'`, "=", "mcp");
  ledger = input.connectionId
    ? ledger.where(callerKey, "=", `connection:${input.connectionId}`)
    : ledger.where(
        callerKey,
        "in",
        database
          .selectFrom("runs")
          .select(sql<string>`'run:' || runs.id`.as("key"))
          .where("runs.threadId", "=", input.threadId!),
      );
  let asks = database
    .selectFrom("requests")
    .select(["id", "status", "command", "createdAt"])
    .where("requestedBy", "=", input.userId)
    .where("command", "is not", null);
  asks = input.connectionId
    ? asks.where(sql<string>`command->'proposer'->>'key'`, "=", `connection:${input.connectionId}`)
    : asks.where("originatingThreadId", "=", input.threadId!);
  if (input.before) {
    ledger = ledger.where("commands.createdAt", "<", input.before.createdAt);
    asks = asks.where("createdAt", "<", input.before.createdAt);
  }
  if (input.since) {
    ledger = ledger.where("commands.createdAt", ">=", input.since);
    asks = asks.where("createdAt", ">=", input.since);
  }
  const [done, asked] = await Promise.all([
    ledger.orderBy("commands.createdAt", "desc").limit(pageLimit).execute(),
    asks.orderBy("createdAt", "desc").limit(pageLimit).execute(),
  ]);

  // Who sent what ran at once: the connection by its own name, or the engine of the task's Run.
  const sender = done.length ? await senderOf(database, input) : null;
  const names = new Map<string, Promise<string | null>>();
  const named = (command: Command, type: CommandType) => {
    try {
      const resource = (commandTable[type].governs as (c: Command) => CommandResource)(command);
      const key = `${resource.kind}:${resource.id ?? ""}`;
      if (!names.has(key)) names.set(key, naming.name(resource, input.userId));
      return names.get(key)!;
    } catch {
      return Promise.resolve(null);
    }
  };

  const entries: AgentCommandActivity[] = [];
  for (const row of done) {
    if (!Object.hasOwn(commandTable, row.type)) continue;
    const type = row.type as CommandType;
    // The ledger keeps the command's input as `request` beside its result.
    const payload = (row.payload ?? {}) as { readonly request?: unknown };
    const input =
      payload.request && typeof payload.request === "object" ? payload.request : payload;
    const command = { ...(input as object), type } as Command;
    const what = await named(command, type);
    entries.push({
      id: row.id,
      type,
      sentence: sentence(sender, commandDoneWords(command), what),
      status:
        row.status === "succeeded"
          ? "done"
          : row.status === "failed"
            ? "failed"
            : row.status === "unknown"
              ? "unknown"
              : "running",
      outcome: null,
      requestId: null,
      createdAt: row.createdAt.toISOString(),
    });
  }
  for (const row of asked) {
    const part = CommandRequestPartSchema.safeParse(row.command);
    if (!part.success || !Object.hasOwn(commandTable, part.data.type)) continue;
    const type = part.data.type as CommandType;
    // The Home's own sentence on the card, "<title>: <name>", gives the name it used then.
    const title = commandTitles[type];
    const stored = part.data.sentence ?? "";
    const what = stored.startsWith(`${title}: `) ? stored.slice(title.length + 2) : null;
    const state = commandRequestState(row);
    entries.push({
      id: row.id,
      type,
      sentence: sentence(
        {
          name: part.data.proposer.name,
          // A connected agent is named by its own name: its direct-work task is only where it asks.
          taskTitle: part.data.proposer.kind === "connection" ? null : part.data.proposer.taskTitle,
        },
        commandAskedWords({ ...part.data.command, type } as Command),
        what,
      ),
      status: !state ? "asked" : state.status === "answered" ? "approved" : state.status,
      outcome:
        state?.status === "answered"
          ? (state.outcome.status as NonNullable<AgentCommandActivity["outcome"]>)
          : null,
      requestId: row.id,
      createdAt: row.createdAt.toISOString(),
    });
  }
  return entries
    .sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    )
    .slice(0, pageLimit);
}

interface Sender {
  readonly name: string;
  readonly taskTitle: string | null;
}

/** "Claude Code, from the task “Tidy up”, renamed a task: “Notes”". */
function sentence(sender: Sender | null, words: string, what: string | null): string {
  const who = sender
    ? sender.taskTitle
      ? `${sender.name}, from the task “${sender.taskTitle}”,`
      : sender.name
    : "An agent";
  const said = `${who} ${words}${what ? `: ${what}` : ""}`;
  return said.length > sentenceLimit ? `${said.slice(0, sentenceLimit - 1)}…` : said;
}

async function senderOf(
  database: Kysely<DatabaseSchema>,
  input: CommandActivityOf & { readonly userId: UserId },
): Promise<Sender> {
  if (input.connectionId) {
    const connection = await database
      .selectFrom("agentConnections")
      .select("label")
      .where("id", "=", input.connectionId)
      .where("userId", "=", input.userId)
      .executeTakeFirst();
    return { name: connection?.label ?? "A connected agent", taskTitle: null };
  }
  const task = await database
    .selectFrom("threads")
    .leftJoin("harnessInstances", "harnessInstances.id", "threads.harnessInstanceId")
    .select(["threads.title", "harnessInstances.name"])
    .where("threads.id", "=", input.threadId!)
    .executeTakeFirst();
  return { name: task?.name ?? "An agent", taskTitle: task?.title ?? null };
}
