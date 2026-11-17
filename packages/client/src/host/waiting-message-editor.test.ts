import { afterEach, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { NeedsYouTeamAskEntrySchema } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import { waitingInputs } from "./waiting-inputs.js";

const teamId = createId("deployment");
const ask = NeedsYouTeamAskEntrySchema.parse({
  kind: "team-ask",
  teamId,
  requestId: createId("teamAgentRequest"),
  createdAt: "2026-11-14T12:00:00.000Z",
  consentExpiresAt: "2026-11-21T12:00:00.000Z",
  presentation: {
    asker: { teamUserId: createId("user"), displayName: "Maya", actor: "human" },
    bodyMarkdown: "Can you check the ferry times?",
    attachments: [],
    destination: { teamId, channelId: createId("teamChannel"), threadRootId: "1" },
    audience: {
      teamName: "Acme",
      channelName: "family",
      channelKind: "public",
      memberCount: 4,
      peopleOnly: false,
    },
  },
});

const opened: { dispose(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const held of opened.splice(0)) held.dispose();
});

/**
 * The production client against the mock Host, with one teammate's ask
 * waiting in its own task. `lose` drops the answer to the next command of
 * that type after the Host has carried it out.
 */
async function setup() {
  const mock = new MockHostClient({ latencyMs: 0, teamAsks: [ask] });
  const host = new MockPersonalHost(mock);
  const sent: string[] = [];
  const lost = new Set<string>();
  const client = new HttpHostClient({
    baseUrl: "http://mock-host",
    webSocketFactory: host.connect,

    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      const type =
        body && typeof body === "object" && "type" in body && typeof body.type === "string"
          ? body.type
          : url.pathname;
      sent.push(type);
      const response = await host.fetch(input, init);
      if (lost.delete(type)) throw new TypeError("The connection was lost.");
      return response;
    },
  });
  opened.push(client, host);
  await client.load();
  const entry = mock.getSnapshot().needsYou!.entries.find((row) => row.kind === "team-ask");
  if (entry?.kind !== "team-ask" || !entry.task) throw new Error("The ask has no task.");
  const { threadId, messageId } = entry.task;
  client.activateThread(threadId);
  await vi.waitFor(
    () =>
      expect(
        client.getThreadTranscript(threadId)?.getSnapshot().inputQueue?.items,
        "the ask's task never read its queue",
      ).toHaveLength(1),
    { timeout: 1000 },
  );
  const waiting = () =>
    waitingInputs(client.getThreadTranscript(threadId)?.getSnapshot().inputQueue!, {
      ownsLease: (leaseId) => client.ownsEditLease(leaseId),
    })[0];
  return { client, host, lost, messageId, mock, sent, threadId, waiting };
}

it("edits a waiting message in place under this device's lease, renewing it only while the person types", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T12:01:00.000Z"));
  const { client, messageId, sent, threadId, waiting } = await setup();

  const editor = await client.editWaitingMessage(threadId, messageId);
  expect(editor.revision).toBe(0);
  expect(waiting()!.lease).toEqual({ kind: "mine", leaseId: editor.leaseId });

  const renewals = () => sent.filter((type) => type === "thread.input.lease.renew").length;
  editor.touch();
  vi.setSystemTime(new Date("2026-11-14T12:01:31.000Z"));
  editor.touch();
  editor.touch();
  await vi.waitFor(() => expect(renewals(), "typing never renewed the lease").toBe(1), {
    timeout: 1000,
  });

  const edit = await editor.save(
    [{ text: "Can you check Saturday's ferry times?", type: "text" }],
    editor.revision,
  );
  expect(edit).toMatchObject({ ownerEdited: true, revision: 1 });
  expect(waiting()).toMatchObject({
    edit: { revision: 1 },
    lease: { kind: "none" },
    revision: 1,
    text: "Can you check Saturday's ferry times?",
  });
  expect(client.ownsEditLease(editor.leaseId)).toBe(false);
  // Needs you approves the version the task now holds.
  expect(
    client
      .getSnapshot()
      .needsYou?.entries.find(
        (row) => row.kind === "team-ask" && row.task?.messageId === messageId,
      ),
  ).toMatchObject({ task: { revision: 1 } });

  editor.touch();
  expect(renewals()).toBe(1);
  const history = await client.listMessageRevisions(threadId, messageId);
  expect(history.revisions.map(({ revision, deviceLabel }) => [revision, deviceLabel])).toEqual([
    [1, "Chrome on Mac"],
    [0, null],
  ]);
});

it("lets go of a take whose answer was lost, and retries a lost save as the same edit", async () => {
  const { client, lost, messageId, mock, threadId } = await setup();
  lost.add("thread.input.lease.take");
  await expect(client.editWaitingMessage(threadId, messageId)).rejects.toThrow(
    "could not be reached",
  );
  // The Host took that lease; nothing may wait two minutes on an editor that never opened.
  expect(mock.getThreadTranscript(threadId)?.getSnapshot().inputQueue?.items[0]?.lease).toBeNull();

  const editor = await client.editWaitingMessage(threadId, messageId);
  const words = [{ text: "Check the 9am ferry", type: "text" as const }];
  lost.add("thread.input.edit");
  await expect(editor.save(words, 0)).rejects.toThrow("could not be reached");
  await expect(editor.save(words, 0)).resolves.toMatchObject({ revision: 1 });
  const history = await client.listMessageRevisions(threadId, messageId);
  expect(history.revisions.map(({ revision }) => revision)).toEqual([1, 0]);
});

it("holds a message another device is editing until this one takes it over, and keeps the words when it loses it", async () => {
  const { client, messageId, mock, threadId, waiting } = await setup();
  mock.mockOtherDeviceEdit(threadId, messageId, "Alex's iPad");
  await vi.waitFor(
    () =>
      expect(waiting()!.lease, "the other device's edit never showed").toMatchObject({
        deviceLabel: "Alex's iPad",
        kind: "other",
      }),
    { timeout: 1000 },
  );
  await expect(client.editWaitingMessage(threadId, messageId)).rejects.toMatchObject({
    code: "conflict",
  });
  const editor = await client.editWaitingMessage(threadId, messageId, { takeOver: true });
  expect(waiting()!.lease).toEqual({ kind: "mine", leaseId: editor.leaseId });

  mock.mockOtherDeviceEdit(threadId, messageId, "Alex's iPad");
  await expect(
    editor.save([{ text: "Mine", type: "text" }], editor.revision),
  ).rejects.toMatchObject({
    code: "conflict",
  });
  await client.releaseWaitingMessage(threadId, messageId);
  expect(waiting()!.lease).toEqual({ kind: "none" });
  await editor.cancel();
  expect(client.ownsEditLease(editor.leaseId)).toBe(false);
});

it("reloads a revised lease only for the observed queue and purges the removed scope", async () => {
  const { client, mock, messageId, threadId, waiting } = await setup();
  mock.mockOtherDeviceEdit(threadId, messageId, "Alex's iPhone");
  await vi.waitFor(
    () => expect(waiting()?.lease).toMatchObject({ kind: "other", deviceLabel: "Alex's iPhone" }),
    { timeout: 1000 },
  );
  const review = client
    .getSnapshot()
    .needsYou?.entries.find((row) => row.kind === "team-ask" && row.task?.threadId === threadId);
  if (!review || review.kind !== "team-ask") throw new Error("The task has no waiting ask.");
  await client.decideTeamAsk({
    decision: "decline",
    requestId: review.requestId,
    teamId: review.teamId,
  });
  await vi.waitFor(
    () =>
      expect(client.getSnapshot().threadLookups[threadId], "the task was never removed").toBe(
        "missing",
      ),
    { timeout: 1000 },
  );
  const snapshot = client.getSnapshot();
  expect(snapshot.threads.some(({ id }) => id === threadId)).toBe(false);
  expect(client.getThreadTranscript(threadId)?.getSnapshot().inputQueue).toBeNull();
  expect(
    snapshot.needsYou?.entries.some(
      (row) => row.kind === "team-ask" && row.task?.threadId === threadId,
    ),
  ).toBe(false);
});
