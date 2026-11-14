import { afterEach, expect, it, vi } from "vitest";
import { AgentEventViewSchema, createId } from "@opensteer/core";
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
    refreshIntervalMs: 0,
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
        client.getSnapshot().inputQueues[threadId]?.items,
        "the ask's task never read its queue",
      ).toHaveLength(1),
    { timeout: 1000 },
  );
  const waiting = () =>
    waitingInputs(client.getSnapshot().inputQueues[threadId]!, {
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

  const edit = await editor.save([{ text: "Can you check Saturday's ferry times?", type: "text" }]);
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
  expect(mock.getSnapshot().inputQueues[threadId]?.items[0]?.lease).toBeNull();

  const editor = await client.editWaitingMessage(threadId, messageId);
  const words = [{ text: "Check the 9am ferry", type: "text" as const }];
  lost.add("thread.input.edit");
  await expect(editor.save(words)).rejects.toThrow("could not be reached");
  await expect(editor.save(words)).resolves.toMatchObject({ revision: 1 });
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
  await expect(editor.save([{ text: "Mine", type: "text" }])).rejects.toMatchObject({
    code: "conflict",
  });
  await client.releaseWaitingMessage(threadId, messageId);
  expect(waiting()!.lease).toEqual({ kind: "none" });
  await editor.cancel();
  expect(client.ownsEditLease(editor.leaseId)).toBe(false);
});

it("patches a lease change and an edit from another device in place, and drops a removed task", async () => {
  const { client, host, messageId, sent, threadId, waiting } = await setup();
  const thread = client.getSnapshot().threads.find(({ id }) => id === threadId)!;
  let sequence = 100_000;
  const publish = (type: string, data: object) => {
    sequence += 1;
    host.publish(
      [
        AgentEventViewSchema.parse({
          createdAt: "2026-11-14T12:05:00.000Z",
          data,
          environmentId: thread.environmentId,
          eventId: createId("event"),
          runId: null,
          sequence: String(sequence),
          threadId,
          type,
        }),
      ],
      String(sequence),
    );
  };
  const reads = () => sent.filter((type) => type.endsWith("/thread.inputQueue.get")).length;
  const before = reads();

  publish("thread-input.lease-changed", {
    lease: {
      deviceLabel: "Alex's iPhone",
      expiresAt: "2026-11-14T12:07:00.000Z",
      leaseId: "phone-lease-0000001",
    },
    messageId,
  });
  await vi.waitFor(() => expect(waiting()!.lease).toMatchObject({ kind: "other" }), {
    timeout: 1000,
  });

  const item = client.getSnapshot().inputQueues[threadId]!.items[0]!;
  const edit = { editedAt: "2026-11-14T12:06:00.000Z", ownerEdited: true, revision: 1 };
  publish("thread-input.lease-changed", { lease: null, messageId });
  publish("message.updated", {
    edit,
    input: item.input,
    message: { ...item.message, content: [{ text: "Edited on the phone", type: "text" }], edit },
  });
  await vi.waitFor(
    () =>
      expect(waiting()).toMatchObject({
        lease: { kind: "none" },
        revision: 1,
        text: "Edited on the phone",
      }),
    { timeout: 1000 },
  );
  expect(reads(), "a lease or edit event reread the queue").toBe(before);

  publish("task.removed", {});
  await vi.waitFor(
    () =>
      expect(client.getSnapshot().threadLookups[threadId], "the task was never removed").toBe(
        "missing",
      ),
    { timeout: 1000 },
  );
  const snapshot = client.getSnapshot();
  expect(snapshot.threads.some(({ id }) => id === threadId)).toBe(false);
  expect(snapshot.inputQueues[threadId]).toBeUndefined();
  expect(
    snapshot.needsYou?.entries.some(
      (row) => row.kind === "team-ask" && row.task?.threadId === threadId,
    ),
  ).toBe(false);
  client.activateThread(threadId);
  expect(client.getSnapshot().threadLookups[threadId]).toBe("missing");
});
