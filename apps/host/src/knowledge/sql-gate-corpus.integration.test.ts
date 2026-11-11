import type { KnowledgeTopicId } from "@opensteer/core";
import {
  createKnowledgeExecutorPool,
  runKnowledgeStatement,
  type KnowledgeJson,
  type KnowledgeWriter,
} from "@opensteer/database";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
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
  teamScopeForgeries,
  wrongAcceptVariants,
} from "./sql-gate-corpus.test-support.js";

// The corpus names these topics literally.
const open = "open" as KnowledgeTopicId;
const hidden = "hidden" as KnowledgeTopicId;

async function knowledgeBase(legacyStrings: boolean) {
  const f = await createTeamKnowledgeFixture();
  const writer: KnowledgeWriter = { kind: "human", id: f.owner, requestId: null };
  await sql`
    insert into knowledge.topics (id, name, created_by) values
      (${open}, 'Open', ${f.owner}), (${hidden}, 'Hidden', ${f.owner})
  `.execute(f.database);
  await sql`
    insert into knowledge.operations (id, writer_kind, writer_id, input_hash, row_count, receipt)
      values ('seed', 'human', ${f.owner}, repeat('0', 64), 4, '{}')
  `.execute(f.database);
  await sql`
    insert into knowledge.fact_log
      (topic, thing, property, value, writer_kind, writer_id, operation_id, operation_row)
    values
      (${open}, 'trip/kyoto', 'hotel', '"Hotel A"', 'human', ${f.owner}, 'seed', 1),
      (${open}, 'n', 'count', '5', 'human', ${f.owner}, 'seed', 2),
      (${hidden}, 'trip/kyoto', 'hotel', '"HIDDEN_HOTEL_ZQX"', 'human', ${f.owner}, 'seed', 3),
      (${hidden}, 'n', 'count', '"HIDDEN_NOT_INT_ZQX"', 'human', ${f.owner}, 'seed', 4)
  `.execute(f.database);
  if (legacyStrings)
    await sql`alter database ${sql.id(new URL(f.databaseUrl).pathname.slice(1))}
      set standard_conforming_strings = off`.execute(f.database);
  // A pool opened after the database default changed, so its sessions start with it.
  const { pool } = await ownTestDatabaseProducer(f.databaseUrl, async () => {
    const pool = createKnowledgeExecutorPool(f.databaseUrl, f.credentials);
    return { pool, close: () => pool.end() };
  });
  return { pool, writer };
}

const admitted = [
  ...reviewMatrix,
  ...prototypeCorpus,
  ...wrongAcceptVariants,
  ...castPositions,
  ...grammarDecisions,
  ...otherDecisions,
  ...insertShapes,
  ...teamScopeForgeries,
].filter(([, expected]) => expected === "admit");

// Failures an admitted statement may meet on this data: its own values, types and conditions, or
// the store's resource bounds, which a statement built to grow may reach first on a loaded machine.
const dataFailures = new Set([
  "knowledge-invalid-value",
  "knowledge-invalid-statement",
  "knowledge-seen-fact-mismatch",
  "knowledge-fact-changed",
  "knowledge-statement-timeout",
  "knowledge-resource-limit",
  "knowledge-row-too-large",
  "knowledge-result-too-large",
  "knowledge-message-too-large",
]);

// Skip outside the integration launcher, which supplies an isolated PostgreSQL clone.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("the admitted corpus against the real knowledge schema", () => {
  it.for([false, true])(
    "runs every admitted statement without reaching a hidden topic or the scope (legacy strings: %s)",
    async (legacyStrings) => {
      const { pool, writer } = await knowledgeBase(legacyStrings);
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
                  suppliesBaseline: admission.suppliesBaseline,
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
