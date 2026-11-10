import type { KnowledgeTopicId } from "@opensteer/core";
import {
  createDatabase,
  createKnowledgeExecutorPool,
  prepareKnowledgeExecutor,
  runKnowledgeStatement,
  type KnowledgeJson,
} from "@opensteer/database";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admitKnowledgeSql } from "./sql-gate.js";
import {
  castPositions,
  grammarDecisions,
  insertShapes,
  otherDecisions,
  prototypeCorpus,
  reviewMatrix,
  wrongAcceptVariants,
} from "./sql-gate-corpus.test-support.js";

const open = "open" as KnowledgeTopicId;
const hidden = "hidden" as KnowledgeTopicId;
const writer = {
  kind: "person",
  id: "usr_corpus",
  initiatorId: null,
  agentId: "agent-corpus",
  taskId: null,
  runId: null,
} as const;

async function knowledgeBase(legacyStrings: boolean) {
  const clone = await cloneTestDatabase("host");
  return ownTestDatabaseProducer(clone.url, async () => {
    const database = createDatabase({ connectionString: clone.url, maxConnections: 2 });
    const credentials = await prepareKnowledgeExecutor(database);
    await sql`
      insert into knowledge.topics (id, name, created_by_kind, created_by_id) values
        (${open}, 'Open', 'person', 'usr_corpus'), (${hidden}, 'Hidden', 'person', 'usr_corpus')
    `.execute(database);
    await sql`
      insert into knowledge.operations (id, writer_kind, writer_id, input_hash, row_count, receipt)
        values ('seed', 'person', 'usr_corpus', repeat('0', 64), 4, '{}')
    `.execute(database);
    await sql`
      insert into knowledge.fact_log
        (topic, thing, property, value, writer_kind, writer_id, agent_id, operation_id, operation_row)
      values
        (${open}, 'trip/kyoto', 'hotel', '"Hotel A"', 'person', 'usr_corpus', 'seed', 'seed', 1),
        (${open}, 'n', 'count', '5', 'person', 'usr_corpus', 'seed', 'seed', 2),
        (${hidden}, 'trip/kyoto', 'hotel', '"HIDDEN_HOTEL_ZQX"', 'person', 'usr_corpus', 'seed', 'seed', 3),
        (${hidden}, 'n', 'count', '"HIDDEN_NOT_INT_ZQX"', 'person', 'usr_corpus', 'seed', 'seed', 4)
    `.execute(database);
    if (legacyStrings)
      await sql`alter database ${sql.id(new URL(clone.url).pathname.slice(1))}
        set standard_conforming_strings = off`.execute(database);
    const pool = createKnowledgeExecutorPool(clone.url, credentials);
    return {
      pool,
      async close() {
        await pool.end();
        const role = sql.id(credentials.role);
        await sql`drop owned by ${role}; drop role ${role}`.execute(database);
        await database.destroy();
      },
    };
  });
}

const admitted = [
  ...reviewMatrix,
  ...prototypeCorpus,
  ...wrongAcceptVariants,
  ...castPositions,
  ...grammarDecisions,
  ...otherDecisions,
  ...insertShapes,
].filter(([, expected]) => expected === "admit");

// Failures an admitted statement may meet on this data: its own values, types and conditions.
const dataFailures = new Set([
  "knowledge-invalid-value",
  "knowledge-invalid-statement",
  "knowledge-seen-fact-mismatch",
  "knowledge-fact-changed",
]);

// Skip outside the integration launcher, which supplies an isolated PostgreSQL clone.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("the admitted corpus against the real knowledge schema", () => {
  it.for([false, true])(
    "runs every admitted statement without reaching a hidden topic or the scope (legacy strings: %s)",
    async (legacyStrings) => {
      const { pool } = await knowledgeBase(legacyStrings);
      expect(admitted.length).toBeGreaterThan(140);
      const outcomes: string[] = [];
      for (const [text, , why, parameters = []] of admitted) {
        const admission = await admitKnowledgeSql({ text, parameters });
        const outcome = await runKnowledgeStatement(pool, {
          statement:
            admission.kind === "select"
              ? { kind: "select", text: admission.text, parameters: parameters as KnowledgeJson[] }
              : {
                  kind: "insert",
                  text: admission.text,
                  parameters: parameters as KnowledgeJson[],
                  operationKey: randomUUID(),
                  onlyIfUnchanged: false,
                  keys: admission.keys,
                },
          readTopicIds: [open],
          writeTopicIds: [open],
          writer,
        }).then(
          (result) => JSON.stringify(result),
          (error: unknown) => (error as { reason?: string }).reason ?? "unknown",
        );
        expect(outcome, `${why}: ${text}`).not.toMatch(/ZQX|"hidden"|read_topics|write_topics/u);
        if (!outcome.startsWith("{"))
          expect(dataFailures.has(outcome), `${why}: ${text} failed with ${outcome}`).toBe(true);
        outcomes.push(outcome);
      }
      expect(outcomes.filter((outcome) => outcome.startsWith("{")).length).toBeGreaterThan(
        admitted.length - 20,
      );
      const list = await admitKnowledgeSql({
        text: "SELECT thing FROM facts WHERE thing IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY thing",
        parameters: [["trip/kyoto", "n", "missing"]],
      });
      expect(
        await runKnowledgeStatement(pool, {
          statement: {
            kind: "select",
            text: list.text,
            parameters: [["trip/kyoto", "n", "missing"]],
          },
          readTopicIds: [open, hidden],
          writeTopicIds: [],
          writer,
        }),
      ).toMatchObject({ rows: [["n"], ["n"], ["trip/kyoto"], ["trip/kyoto"]] });
    },
  );
});
