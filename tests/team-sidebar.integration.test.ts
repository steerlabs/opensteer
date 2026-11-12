import { expect, it } from "vitest";
import { TeamAccessStore } from "../packages/database/src/team-access-store.js";
import { TeamChatStore } from "../packages/database/src/team-chat-store.js";
import { teamChannelTopics } from "../packages/database/src/team-topics-store.js";
import { startTeamSystem } from "./team-system.test-support.js";
import { perfChannels } from "./team-performance.test-support.js";
import { teamApiVersion } from "../packages/deployment-authority/src/authority.js";

it("loads 50 sidebar channels with a bounded number of database round trips", async () => {
  const team = await startTeamSystem();
  try {
    const owner = await team.setup();
    await perfChannels(team, owner, 50);
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
    const sidebar = await chat.directory({ kind: "human", userId: owner }, undefined, true);
    expect(sidebar.channels).toHaveLength(50);
    expect(sidebar.channels.every((row) => row.channel.can.read && row.channel.can.post)).toBe(
      true,
    );
    expect(
      queries,
      "Sidebar must batch authority, read markers, mentions and link state",
    ).toBeLessThanOrEqual(10);
  } finally {
    await team.close();
  }
});

it("coalesces overlapping device snapshots while retaining each subscription identity", async () => {
  const team = await startTeamSystem();
  let hub: import("../apps/host/src/team/realtime.js").TeamRealtimeHub | undefined;
  try {
    const owner = await team.setup(),
      [channelId] = await perfChannels(team, owner, 1);
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
    const { TeamRealtimeHub } = await import("../apps/host/src/team/realtime.js");
    hub = new TeamRealtimeHub(access, chat);
    const cuts: import("../packages/protocol/src/index.js").TeamConsistentCut[] = [];
    const peers = Array.from({ length: 16 }, () =>
      hub!.connect(
        { kind: "human", userId: owner },
        {
          send(frame) {
            if (frame.type === "team.cut") cuts.push(frame.cut);
            return true;
          },
          close() {},
        },
      ),
    );
    queries = 0;
    await Promise.all(
      peers.map((peer, index) =>
        peer.receive({
          type: "team.subscribe",
          teamApiVersion,
          sidebar: false,
          subscriptionId: `device-${index}`,
          generation: index + 1,
          scope: { kind: "channel", channelId },
          sinceSeq: null,
        }),
      ),
    );
    expect(cuts).toHaveLength(16);
    expect(new Set(cuts.map((cut) => cut.subscriptionId)).size).toBe(16);
    expect(queries, "Overlapping snapshots must share database work").toBeLessThanOrEqual(25);
  } finally {
    hub?.close();
    await team.close();
  }
});
