import type { KnowledgeSqlOutput, sql } from "@opensteer/agent-tools/tools";
import { OpensteerError, type UserId } from "@opensteer/core";
import {
  createKnowledgeExecutorPool,
  ensureKnowledgeGeneralTopic,
  listKnowledgeTopics,
  personalDeploymentOwner,
  prepareKnowledgeExecutor,
  runKnowledgeStatement,
  type DatabaseSchema,
  type KnowledgeJson,
  type KnowledgeRows,
} from "@opensteer/database";
import type { Kysely } from "kysely";
import type { z } from "zod";
import type { AgentCaller } from "../mcp/agent-caller.js";
import { operationId } from "../mcp/operations.js";
import { admitKnowledgeSql } from "./sql-gate.js";

export type KnowledgeSqlInput = z.output<(typeof sql)["input"]>;

export interface KnowledgeSqlCall {
  readonly caller: AgentCaller;
  readonly input: KnowledgeSqlInput;
  readonly operationKey: string;
  /** Re-authenticates the caller; a throw means it may no longer act or see. */
  readonly checkLive?: () => Promise<void>;
}

/** The tool's output, with rows as PostgreSQL returned them; the tool schema checks the rest. */
export type KnowledgeAnswer = Omit<KnowledgeSqlOutput, "rows"> & {
  readonly rows?: readonly (readonly KnowledgeJson[])[];
};

export interface KnowledgeManager {
  sql(call: KnowledgeSqlCall): Promise<KnowledgeAnswer>;
  close(): Promise<void>;
}

export const knowledgeResultBytes = 524_288;
const topicPage = 50;
const relationNames = ["facts", "fact_history"] as const;
const insertable = ["topic", "thing", "property", "value", "seen_fact_id"];
const source = { kind: "knowledge", trust: "data" } as const;

/**
 * Opens the restricted login's pool and serves the `sql` tool on a Personal
 * Deployment. The owner reads and writes every topic; who wrote comes from the
 * authenticated Run, never from the call.
 */
export async function startKnowledgeManager(options: {
  readonly database: Kysely<DatabaseSchema>;
  readonly databaseUrl: string;
  readonly statementTimeoutMs?: number;
}): Promise<KnowledgeManager> {
  const { database } = options;
  // Loads the parser now, so a Host that cannot is refused at start rather than at an agent's first call.
  await admitKnowledgeSql({ text: "SELECT 1", parameters: [] });
  const pool = createKnowledgeExecutorPool(
    options.databaseUrl,
    await prepareKnowledgeExecutor(database),
  );
  let owner: UserId | null = null;
  let seeded = false;
  const ownerOf = async () => (owner ??= await personalDeploymentOwner(database));
  const seed = async (user: UserId) => {
    if (seeded) return;
    await ensureKnowledgeGeneralTopic(database, user);
    seeded = true;
  };
  let relations: Promise<NonNullable<KnowledgeSqlOutput["relations"]>> | undefined;
  const describe = () =>
    (relations ??= Promise.all(
      relationNames.map(async (name) => {
        const result = await runKnowledgeStatement(pool, {
          statement: {
            kind: "select",
            text: `select * from knowledge.${name} where false`,
            parameters: [],
          },
          readTopicIds: [],
          writeTopicIds: [],
          writer: {
            kind: "person",
            id: "discovery",
            initiatorId: null,
            agentId: "discovery",
            taskId: null,
            runId: null,
          },
        });
        if (result.kind !== "select") throw new Error("Discovery returned a write");
        return {
          name,
          columns: [...result.columns],
          insertable: name === "facts" ? insertable : [],
        };
      }),
    ).catch((error: unknown) => {
      relations = undefined;
      throw error;
    }));

  try {
    const established = await ownerOf();
    if (established) await seed(established);
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    async sql(call) {
      try {
        return await answer(call);
      } catch (error) {
        throw failure(error);
      }
    },
    async close() {
      await pool.end();
    },
  };

  async function answer(call: KnowledgeSqlCall): Promise<KnowledgeAnswer> {
    const { caller, input } = call;
    if (
      caller.kind !== "run" ||
      caller.reach.kind !== "user" ||
      caller.userId !== (await ownerOf())
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "This tool is unavailable to this caller",
      });
    await seed(caller.userId);
    const topics = await listKnowledgeTopics(database, { includeArchived: true });
    const readTopicIds = topics.map((topic) => topic.id);
    const writeTopicIds = topics
      .filter((topic) => topic.archivedAt === null)
      .map((topic) => topic.id);

    if (input.query === undefined) {
      if (
        input.mode === "write" ||
        input.parameters !== undefined ||
        input.onlyIfUnchanged !== undefined
      )
        throw refusal(
          "Send query with mode, parameters or onlyIfUnchanged.",
          "sql without query only describes facts and topics.",
        );
      const open = topics.filter((topic) => topic.archivedAt === null);
      const start =
        input.cursor === undefined ? 0 : open.findIndex((topic) => topic.id === input.cursor) + 1;
      if (start === 0 && input.cursor !== undefined)
        throw refusal("That cursor is no longer valid.", "Call sql without query or cursor.");
      const page = open.slice(start, start + topicPage);
      const last = page.at(-1);
      return bounded({
        source,
        relations: await describe(),
        topics: page.map(({ id, name }) => ({ id, name })),
        ...(last && start + topicPage < open.length ? { nextCursor: last.id } : {}),
      });
    }
    if (input.cursor !== undefined) throw refusal("cursor pages topics; send it without query.");
    const parameters = input.parameters ?? [];
    const admitted = await admitKnowledgeSql({ text: input.query, parameters });
    if (admitted.kind === "select" && input.onlyIfUnchanged !== undefined)
      throw refusal("onlyIfUnchanged applies only to an INSERT.");
    if (admitted.kind === "insert" && input.mode !== "write")
      throw refusal('INSERT needs mode "write". Nothing was saved.');
    const thread = caller.thread;
    const result = await runKnowledgeStatement(pool, {
      statement:
        admitted.kind === "select"
          ? { kind: "select", text: admitted.text, parameters }
          : {
              kind: "insert",
              text: admitted.text,
              parameters,
              operationKey: operationId(caller, call.operationKey, "sql"),
              onlyIfUnchanged: input.onlyIfUnchanged === true,
              keys: admitted.keys,
            },
      readTopicIds,
      writeTopicIds,
      writer: {
        kind: "person",
        id: caller.userId,
        initiatorId: caller.userId,
        agentId: thread.harnessInstanceId,
        taskId: thread.id,
        runId: caller.claims.runId,
      },
      ...(options.statementTimeoutMs === undefined
        ? {}
        : { statementTimeoutMs: options.statementTimeoutMs }),
      ...(call.checkLive ? { beforeCommit: call.checkLive } : {}),
    });
    if (result.kind === "select") {
      await call.checkLive?.();
      return bounded({ source, ...rows(result) });
    }
    if (result.replayed) await call.checkLive?.();
    return bounded({
      source,
      receipt: { committed: true, replayed: result.replayed, facts: result.receipt.facts },
      ...(result.returning ? rows(result.returning) : {}),
    });
  }
}

function rows(result: KnowledgeRows) {
  return {
    columns: [...result.columns],
    rows: result.rows,
    truncated: result.truncated,
  };
}

function bounded(output: KnowledgeAnswer): KnowledgeAnswer {
  if (Buffer.byteLength(JSON.stringify(output), "utf8") <= knowledgeResultBytes) return output;
  throw new OpensteerError({
    code: "resource_exhausted",
    reason: "knowledge-result-too-large",
    message: `The result is over 512 KB${output.receipt ? ", though the write was saved" : ""}.`,
    next: output.receipt
      ? "Read facts to see what was saved; don't repeat the INSERT."
      : "Select fewer columns or rows, or aggregate, and call sql again.",
  });
}

function refusal(message: string, next?: string): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    reason: "knowledge-bad-call",
    message,
    ...(next ? { next } : {}),
  });
}

const gateReasons = new Set([
  "too-large",
  "syntax",
  "statement",
  "relation",
  "function",
  "operator",
  "type",
  "form",
  "insert",
  "parameter",
]);

/** Every failure leaves here as a sentence written for the agent; nothing from PostgreSQL or the statement. */
function failure(error: unknown): OpensteerError {
  if (!(error instanceof OpensteerError))
    return new OpensteerError({
      code: "internal",
      reason: "knowledge-failed",
      message: "The knowledge statement failed.",
    });
  if (error.next !== undefined) return error;
  const again = (
    next: string,
    overrides: { code?: OpensteerError["code"]; message?: string } = {},
  ) =>
    new OpensteerError({
      code: overrides.code ?? error.code,
      message: overrides.message ?? error.message,
      next,
      retryable: error.retryable,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    });
  if (error.reason !== undefined && gateReasons.has(error.reason))
    return again(
      "Rewrite the statement and call sql again; call sql without query for the columns.",
    );
  switch (error.reason) {
    case "knowledge-fact-changed": {
      const current = error.details?.currentFactId;
      return again(
        "Read facts again, then decide whether to write with the new id as seen_fact_id.",
        {
          message: `A fact changed since it was read${typeof current === "string" ? `; its current id is ${current}` : current === null ? "; it no longer has a value" : ""}. No facts were saved.`,
        },
      );
    }
    case "knowledge-commit-uncertain":
      return again(
        "Read facts to check whether it was saved before writing again; never repeat the INSERT blindly.",
        {
          code: "conflict",
        },
      );
    case "knowledge-statement-timeout":
    case "knowledge-resource-limit":
    case "knowledge-row-too-large":
      return again(
        "Filter by topic and key, select fewer or smaller columns, or aggregate, and call sql again.",
      );
    case "knowledge-topic-not-writable":
      return again("Call sql without query for the topics you can use.");
    default:
      return error;
  }
}
