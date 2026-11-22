import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_THREAD_ACCESS_MODE } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";
import { defaultThreadPlacement } from "./thread-placement.js";
import { waitingInputs } from "./waiting-inputs.js";

const opened: { dispose(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const held of opened.splice(0)) held.dispose();
});

/** Sends one message to a task on the mock Host. */
function send(mock: MockHostClient, threadId: string, text: string) {
  return mock.dispatch({
    content: [{ text, type: "text" }],
    idempotencyKey: `mock-message:${crypto.randomUUID()}`,
    threadId,
    type: "thread.sendMessage",
  });
}

/**
 * The production client against the mock Host, with one of the person's
 * messages waiting in a task whose queue Stop paused. `lose` drops the answer
 * to the next command of that type after the Host has carried it out.
 */
async function setup(holdBody?: (response: Response) => Promise<Response>) {
  const mock = new MockHostClient({ latencyMs: 0 });
  const { environments, harnesses } = mock.getSnapshot();
  const placement = defaultThreadPlacement(environments, harnesses);
  if (!placement) throw new Error("The mock offers no placement.");
  const thread = await mock.createThread({
    accessMode: DEFAULT_THREAD_ACCESS_MODE,
    environmentId: placement.environmentId,
    harnessInstanceId: placement.harnessInstanceId,
    modelSelection: placement.modelSelection,
  });
  const first = send(mock, thread.id, "Plan the trip");
  const queued = await send(mock, thread.id, "Can you check the ferry times?");
  if (queued.type !== "thread.sendMessage" || queued.run !== null)
    throw new Error("The message did not wait in the queue.");
  await mock.stopRun(thread.id);
  await first;
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
      if (holdBody && type === "/v1/rpc/thread.message.revisions.list") return holdBody(response);
      return response;
    },
  });
  opened.push(client, host);
  await client.load();
  const threadId = thread.id;
  const messageId = queued.message.id;
  client.activateThread(threadId);
  await vi.waitFor(
    () =>
      expect(
        client.getThreadTranscript(threadId)?.getSnapshot().inputQueue?.items,
        "the task never read its queue",
      ).toHaveLength(1),
    { timeout: 1000 },
  );
  const waiting = () =>
    waitingInputs(client.getThreadTranscript(threadId)?.getSnapshot().inputQueue!)[0];
  return { client, host, lost, messageId, mock, sent, threadId, waiting };
}

it("edits a waiting message in place under this device's lease, renewing it only while the person types", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T12:01:00.000Z"));
  const { client, messageId, sent, threadId, waiting } = await setup();

  const editor = await client.editWaitingMessage(threadId, messageId);
  expect(editor.revision).toBe(0);
  expect(waiting()!.lease).toEqual({ kind: "mine" });

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
  expect(edit).toMatchObject({ revision: 1 });
  expect(waiting()).toMatchObject({
    edit: { revision: 1 },
    lease: { kind: "none" },
    revision: 1,
    text: "Can you check Saturday's ferry times?",
  });
  expect(client.ownsEditLease(editor.leaseId)).toBe(false);

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
  expect(waiting()!.lease).toEqual({ kind: "mine" });

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

it("refuses to open an editor when another device takes the lease during the body read", async () => {
  const body = Promise.withResolvers<Response>();
  const returnBody = Promise.withResolvers<void>();
  const { client, messageId, mock, threadId, waiting } = await setup(async (response) => {
    body.resolve(response);
    await returnBody.promise;
    return response;
  });
  const editing = client.editWaitingMessage(threadId, messageId);
  void editing.catch(() => undefined);
  try {
    let bodyReady = false;
    void body.promise.then(() => {
      bodyReady = true;
    });
    await vi.waitFor(() => expect(bodyReady, "the edit body was never read").toBe(true), {
      timeout: 1000,
    });
    expect((await body.promise).ok).toBe(true);
    mock.mockOtherDeviceEdit(threadId, messageId, "Alex's iPad");
    await vi.waitFor(
      () =>
        expect(waiting()?.lease).toMatchObject({
          kind: "other",
          deviceLabel: "Alex's iPad",
        }),
      { timeout: 1000 },
    );
  } finally {
    returnBody.resolve();
  }
  await expect(editing).rejects.toMatchObject({ code: "conflict" });
  expect(waiting()?.lease).toMatchObject({ kind: "other", deviceLabel: "Alex's iPad" });
});
