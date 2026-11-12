import {
  createMemoryTeamPersistence,
  MockTeamHost,
  mockTeamChannelId,
  TeamSessionClient,
  teamScopeKey,
} from "@opensteer/client/team";
import { afterEach, expect, it, vi } from "vitest";
import { sendFromComposer } from "./composer-send.js";

const scope = { kind: "channel", channelId: mockTeamChannelId } as const;
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function session(): Promise<TeamSessionClient> {
  const host = new MockTeamHost();
  const client = new TeamSessionClient({
    scope: { teamDeploymentId: host.teamId, userId: host.userId },
    rpc: host.rpc,
    connect: host.connect,
    persistence: createMemoryTeamPersistence(),
  });
  stops.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load(false);
  return client;
}

const input = (bodyMarkdown: string) => ({
  channelId: mockTeamChannelId,
  threadRootId: null,
  bodyMarkdown,
  mentions: [],
  attachmentIds: [],
});

it("keeps the words and draft when the message is refused before it is admitted", async () => {
  const team = await session();
  const words = "x".repeat(17 * 1024);
  await team.setDraft(scope, words);
  const clear = vi.fn();
  await expect(sendFromComposer(team, scope, input(words), clear)).rejects.toThrow();
  expect(clear).not.toHaveBeenCalled();
  expect(team.getSnapshot().pending).toEqual([]);
  expect(team.getSnapshot().drafts[teamScopeKey(scope)]).toBe(words);
});

it("clears the composer only once the send is held as pending, then drops the draft", async () => {
  const team = await session();
  await team.setDraft(scope, "Ship it");
  const pendingAtClear: number[] = [];
  await sendFromComposer(team, scope, input("Ship it"), () =>
    pendingAtClear.push(team.getSnapshot().pending.length),
  );
  expect(pendingAtClear).toEqual([1]);
  expect(team.getSnapshot().drafts).toEqual({});
});
