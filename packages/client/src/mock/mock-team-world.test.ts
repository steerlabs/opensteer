import { expect, it } from "vitest";
import { MockTeamHost } from "../team/mock-team-host.js";
import { busyTeamIds, seedBusyTeam } from "./mock-team-world.js";

it("shares a reproducible busy world with scoped asks in pages and live cuts", async () => {
  const host = new MockTeamHost({ teamId: busyTeamIds[0] });
  const duplicate = new MockTeamHost({ teamId: busyTeamIds[0] });
  seedBusyTeam(host, { name: "Acme", index: 1 });
  seedBusyTeam(duplicate, { name: "Acme", index: 1 });
  expect([...host.messages.values()]).toEqual([...duplicate.messages.values()]);
  expect(host.members).toHaveLength(7);
  expect(new Set(host.requests.map((request) => request.state))).toEqual(
    new Set(["working", "queued", "needs_you", "done", "failed", "stopped"]),
  );
  const request = host.requests[0]!;
  const scope = {
    kind: "thread",
    channelId: request.channelId,
    rootId: request.threadRootId,
  } as const;
  const cut = host.cut(scope, "thread", 1, null);
  expect(cut.requests).toHaveLength(6);
  expect(cut.linkPresence.map((entry) => entry.ownerUserId).sort()).toEqual(
    cut.requests.map((row) => row.ownerUserId).sort(),
  );
  expect(cut.linkPresence).toEqual(expect.arrayContaining(host.linkPresence));
  const asks = await host.rpc["team.agent.requests.get"]({
    channelId: scope.channelId,
    rootId: scope.rootId,
  });
  expect(asks.ok && asks.data.requests).toHaveLength(cut.requests.length);
  expect(asks.ok && asks.data.requests).toEqual(expect.arrayContaining(cut.requests));
  const page = await host.rpc["team.thread.page"]({
    channelId: scope.channelId,
    rootId: scope.rootId,
    page: { direction: "newest" },
  });
  expect(
    page.ok && page.data.messages.find((message) => message.id === scope.rootId)?.requests,
  ).toEqual(expect.arrayContaining(cut.requests));
  const other = host.members[1]!;
  const reply = host.post({
    channelId: scope.channelId,
    threadRootId: scope.rootId,
    authorUserId: other.userId,
    bodyMarkdown: "Checking now.",
  });
  expect(reply.authorUserId).toBe(other.userId);
  expect(host.messages.get(scope.rootId)?.replySummary.repliers).toContain(other.userId);
  const update = host.cut(scope, "thread", 1, cut.throughSeq);
  expect(update.type).toBe("resumed");
  expect(update.requests).toEqual([]);
  const completed = host.setRequest({
    ...request,
    state: "done",
    finishedAt: "2026-11-11T16:00:00.000Z",
  });
  const statusUpdate = host.cut(scope, "thread", 1, update.throughSeq);
  expect(statusUpdate.type).toBe("resumed");
  expect(statusUpdate.requests.find((row) => row.id === request.id)).toEqual(completed);
  expect(
    statusUpdate.type === "resumed" &&
      statusUpdate.changedRows.find((row) => row.id === scope.rootId)?.requests,
  ).toContainEqual(completed);
  const family = new MockTeamHost({ teamId: busyTeamIds[1] });
  seedBusyTeam(family, { name: "Family", index: 2 });
  expect(family.bootstrap.teamName).toBe("Family");
  expect([...family.channels.values()].map((channel) => channel.name)).toEqual([
    "family",
    "trip-planning",
  ]);
});
