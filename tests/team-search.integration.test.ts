import { expect, it } from "vitest";
import { TeamAccessStore } from "../packages/database/src/team-access-store.js";
import { TeamChatStore } from "../packages/database/src/team-chat-store.js";
import { teamChannelTopics } from "../packages/database/src/team-topics-store.js";
import { startTeamSystem } from "./team-system.test-support.js";
import { perfChannels, perfHistory } from "./team-performance.test-support.js";

it("batches source and audience resolution across a search page", async () => {
  const team = await startTeamSystem();
  try {
    const owner = await team.setup(),
      channels = await perfChannels(team, owner, 50);
    await perfHistory(team, owner, channels, 1000);
    let queries = 0;
    const database = team.database.withPlugin({
      transformQuery({ node }) {
        queries++;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const access = new TeamAccessStore(database);
    await access.initialize();
    const chat = new TeamChatStore(access, teamChannelTopics, {
      teamId: team.host.deployment.id,
      teamName: "Acme",
    });
    queries = 0;
    const result = await chat.search({ kind: "human", userId: owner }, { query: "common" });
    expect(result.results).toHaveLength(50);
    expect(new Set(result.results.map((row) => row.message.channelId)).size).toBe(50);
    expect(
      result.results.every(
        (row) =>
          row.source.channelId === row.message.channelId &&
          row.source.messageId === row.message.id &&
          row.source.audience.memberCount === 1,
      ),
    ).toBe(true);
    expect(queries, "Source descriptors must not add queries per search hit").toBeLessThanOrEqual(
      25,
    );
  } finally {
    await team.close();
  }
});
