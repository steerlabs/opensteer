import { expect, it } from "vitest";
import { CompiledQuery, sql, type CompiledQuery as Query } from "kysely";
import { teamMessageViews } from "../packages/database/src/team-chat-store.js";
import { createId } from "../packages/core/src/index.js";
import { createTeamFixture } from "../packages/database/src/team-fixture.test-support.js";

it("hydrates a page of reply summaries without scanning unrelated history", async () => {
  const team = await createTeamFixture();
  try {
    const owner = team.userId,
      channel = createId("teamChannel");
    await team.database
      .insertInto("teamChannels")
      .values({
        id: channel,
        kind: "public",
        name: "history",
        normalizedName: "history",
        createdBy: owner,
        peopleOnly: false,
        instructionsMarkdown: "",
      })
      .execute();
    await sql`insert into team_messages(channel_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq)
      select ${channel},${owner},'human',gen_random_uuid(),'root','root',n from generate_series(1,100000) n`.execute(
      team.database,
    );
    const root = await team.database
      .selectFrom("teamMessages")
      .select("id")
      .orderBy("id")
      .executeTakeFirstOrThrow();
    await sql`insert into team_messages(channel_id,thread_root_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq) select ${channel},${root.id},${owner},'human',gen_random_uuid(),'reply','reply',100000+n from generate_series(1,20000) n`.execute(
      team.database,
    );
    expect(
      (
        await sql<{ count: number }>`select count(*)::int as count from team_messages`.execute(
          team.database,
        )
      ).rows[0]!.count,
    ).toBe(120000);
    await sql`analyze team_messages`.execute(team.database);
    const rows = await team.database
      .selectFrom("teamMessages")
      .selectAll()
      .where("threadRootId", "is", null)
      .orderBy("id", "desc")
      .limit(50)
      .execute();
    let summary: Query | undefined;
    const database = team.database.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          node.kind === "RawNode" &&
          node.sqlFragments.some((text) => text.includes("as root_id"))
        )
          summary = team.database.getExecutor().compileQuery(node, queryId);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const views = await teamMessageViews(database, rows);
    expect(views).toHaveLength(50);
    expect(views.every((row) => row.replySummary.count === 0)).toBe(true);
    if (!summary) throw new Error("Reply summary query was not observed");
    const result = await team.database.executeQuery(
      CompiledQuery.raw(`explain(analyze,buffers,format json) ${summary.sql}`, [
        ...summary.parameters,
      ]),
    );
    let unrelated = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
        return;
      }
      if (value && typeof value === "object") {
        const node = value as Record<string, unknown>;
        if (String(node["Node Type"]).includes("Scan") && node["Relation Name"] === "team_messages")
          unrelated +=
            Number(node["Actual Rows"] ?? 0) + Number(node["Rows Removed by Filter"] ?? 0);
        for (const child of Object.values(node)) visit(child);
      }
    };
    visit(result.rows);
    expect(unrelated, JSON.stringify(result.rows)).toBeLessThan(1000);
  } finally {
    await team.close();
  }
}, 30000);
