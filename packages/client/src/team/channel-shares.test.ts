import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterEach, expect, it, vi } from "vitest";
import { teamMessage } from "@opensteer/shared/teamMentions";
import { teamPeopleDirectory } from "./shared-channels.js";
import { createId, OpensteerError } from "@opensteer/core";
import { seedBusyTeam } from "../mock/mock-team-world.js";
import { teamChannelShares } from "./channel-shares.js";
import { MockTeamHost } from "./mock-team-host.js";
import { createMemoryTeamPersistence } from "./persistence.js";
import { TeamSessionClient } from "./team-session-client.js";

const clients: TeamSessionClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});
function fixture() {
  const host = new MockTeamHost();
  seedBusyTeam(host, { name: "Acme", index: 1 });
  const client = new TeamSessionClient({
    scope: { teamDeploymentId: host.teamId, userId: host.userId },
    rpc: host.rpc,
    connect: host.connect,
    persistence: createMemoryTeamPersistence(),
  });
  clients.push(client);
  const channel = [...host.channels.values()].find((row) => row.share)!;
  return { host, client, channel };
}

it("receives remote cards in the content cut, pages and search without another channel-open read", async () => {
  const { host, client, channel } = fixture();
  host.shareParticipants
    .get(channel.id)!
    .push({ userId: host.userId, handle: "viewer-2", level: "post", state: "active" });
  await client.load();
  client.selectChannel(channel.id);
  await vi.waitFor(
    () =>
      expect(client.getSnapshot().channel?.channel?.id, "Shared channel never opened").toBe(
        channel.id,
      ),
    { timeout: 1000 },
  );
  const snapshot = client.getSnapshot();
  const directory = teamPeopleDirectory(
    [snapshot.bootstrap!.member],
    snapshot.peopleByChannel?.[channel.id],
    snapshot.handlesByChannel?.[channel.id],
  );
  expect(
    teamMessage({ body: "Help", toMyAgent: true }, directory.get(host.userId)!, directory)
      .bodyMarkdown,
  ).toBe("@viewer-2-agent Help");
  const remoteId = Object.keys(host.remotePeople)[0]!;
  expect(client.getSnapshot().people?.[remoteId]).toMatchObject({
    name: "Alex Kim",
    external: true,
    homeTeamName: "Northstar",
  });
  expect(
    host.calls.some((name) =>
      ["team.share.participants.get", "team.shares.list", "team.partners.list"].includes(name),
    ),
  ).toBe(false);
  expect(host.members.some((member) => member.userId === remoteId)).toBe(false);
  const cached = client.getSnapshot().people;
  await client.loadPage("channel", "newest");
  expect(client.getSnapshot().people).toBe(cached);
  await client.search({ query: "project history" });
  expect(
    client.getSnapshot().search?.people?.[remoteId as keyof typeof host.remotePeople],
  ).toMatchObject({ name: "Alex Kim" });
  const secondId = createId("teamChannel");
  host.channels.set(secondId, { ...channel, id: secondId, name: "another-project" });
  host.shareParticipants.set(secondId, [
    {
      userId: host.shareParticipants.get(channel.id)![0]!.userId,
      handle: "alex-project-two",
      state: "active",
      level: "post",
    },
  ]);
  host.post({
    channelId: secondId,
    authorUserId: host.shareParticipants.get(channel.id)![0]!.userId,
    bodyMarkdown: "A second shared project",
  });
  client.selectChannel(secondId);
  await vi.waitFor(
    () =>
      expect(client.getSnapshot().channel?.channel?.id, "Second shared channel never opened").toBe(
        secondId,
      ),
    { timeout: 1000 },
  );
  expect(client.getSnapshot().peopleByChannel?.[channel.id]?.[remoteId]?.handle).toBe(
    "alex-northstar",
  );
  expect(client.getSnapshot().peopleByChannel?.[secondId]?.[remoteId]?.handle).toBe(
    "alex-project-two",
  );
  client.dispose();
  expect(client.getSnapshot().people).toEqual({});
});

it("keeps a partner outage retryable and reconciles the same message id exactly once", async () => {
  const { host, client, channel } = fixture();
  channel.share!.role = "follower";
  const partner = [...host.partners.values()][0]!;
  partner.connected = false;
  await client.load();
  await vi.waitFor(
    () => expect(client.getSnapshot().connection, "Team socket never connected").toBe("connected"),
    { timeout: 1000 },
  );
  const id = await client.send({
    channelId: channel.id,
    threadRootId: null,
    bodyMarkdown: "A message for Northstar",
    mentions: [],
    attachmentIds: [],
  });
  await vi.waitFor(
    () =>
      expect(
        client.getSnapshot().sendErrors?.[id],
        "Partner failure never reached pending send",
      ).toBeInstanceOf(OpensteerError),
    { timeout: 1000 },
  );
  expect(
    client.getSnapshot().pending.find((row) => row.command.clientMessageId === id)?.failure,
  ).toBeNull();
  partner.connected = true;
  await client.reconcilePending();
  expect(client.getSnapshot().pending).toEqual([]);
  expect([...host.messages.values()].filter((row) => row.clientMessageId === id)).toHaveLength(1);
});

it("reuses the follower channel id after a failed acceptance and preserves the local name and privacy", async () => {
  const { host, client } = fixture();
  const model = teamChannelShares(client);
  await model.refresh();
  const share = model.getSnapshot().shares.find((row) => row.canAccept)!;
  const read = host.read.bind(host);
  const channelIds: string[] = [];
  vi.spyOn(host, "read").mockImplementation(async (name, input) => {
    if (
      name === "commands.dispatch" &&
      typeof input === "object" &&
      input &&
      "type" in input &&
      input.type === "team.share.accept" &&
      "id" in input
    ) {
      channelIds.push(String(input.id));
      if (channelIds.length === 1) throw new Error("Partner offline");
    }
    return read(name, input);
  });
  expect(await model.accept(share, " #our-project ", "private")).toBeNull();
  const id = await model.accept(share, " #our-project ", "private");
  expect(channelIds).toEqual([id, id]);
  expect(host.channels.get(id!)).toMatchObject({
    name: "our-project",
    kind: "private",
    share: { role: "follower", state: "shared", teamName: "Northstar" },
  });
  expect(model.getSnapshot().shares.find((row) => row.id === share.id)).toMatchObject({
    state: "active",
    canAccept: false,
    canEnd: true,
  });
  await model.command(share.id, { type: "team.share.end", shareId: share.id });
  expect(host.channels.get(id!)?.can.post).toBe(false);
  expect(host.channels.get(id!)?.share?.state).toBe("disconnected");
});

it("pages through all share offers and ignores a page superseded by refresh", async () => {
  const { host, client } = fixture();
  const offer = [...host.shares.values()][0]!;
  host.shares.clear();
  for (let i = 0; i < 102; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    host.shares.set(id, { ...offer, id, name: `Offer ${i}` });
  }
  const model = teamChannelShares(client);
  await model.refresh();
  expect(model.getSnapshot().shares).toHaveLength(50);
  await model.more();
  expect(model.getSnapshot().shares).toHaveLength(100);
  await model.more();
  expect(model.getSnapshot().shares).toHaveLength(102);
  expect(model.getSnapshot().nextCursor).toBeNull();
  await model.refresh();
  const release = Promise.withResolvers<void>();
  const read = host.read.bind(host);
  vi.spyOn(host, "read").mockImplementation(async (name, input) => {
    const page = await read(name, input);
    if (name === "team.shares.list" && typeof input === "object" && input && "after" in input) {
      await withTimeout(release.promise, 1000, {
        timeoutError: () => new Error("Held share page was not released"),
      });
    }
    return page;
  });
  const more = model.more();
  await vi.waitFor(
    () => expect(model.getSnapshot().loadingMore, "Next page never started").toBe(true),
    { timeout: 1000 },
  );
  await model.refresh();
  release.resolve();
  await more;
  expect(model.getSnapshot().shares).toHaveLength(50);
});
