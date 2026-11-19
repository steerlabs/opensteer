// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient, MockPersonalHost } from "@opensteer/client/mock";
import { HttpHostClient } from "@opensteer/client/host";
import { useThreadTranscript } from "@opensteer/client/react";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One mounted reader of a conversation: what it shows of the transcript. */
function Reader({
  client,
  threadId,
}: {
  readonly client: HttpHostClient;
  readonly threadId: string;
}) {
  const view = useThreadTranscript(client, threadId);
  return (
    <p>
      {view.synchronized ? "synchronized" : "loading"}:{view.entries.length}
    </p>
  );
}

function mountReader(client: HttpHostClient, threadId: string) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  act(() => root.render(<Reader client={client} threadId={threadId} />));
  return { node, root };
}

it("two mounted readers of one conversation see one transcript, and one leaving never stops the other", async () => {
  const mock = new MockHostClient({ latencyMs: 0 });
  await mock.load();
  const host = new MockPersonalHost(mock);
  const client = new HttpHostClient({
    baseUrl: "http://127.0.0.1",
    fetch: host.fetch,
    webSocketFactory: host.connect,
  });
  cleanups.push(
    () => client.dispose(),
    () => host.dispose(),
    () => mock.dispose(),
  );
  await client.load();
  const threadId = mock.getSnapshot().threads.find(({ listed }) => listed)!.id;
  client.activateThread(threadId);
  const first = mountReader(client, threadId);
  const second = mountReader(client, threadId);
  await vi.waitFor(() => expect(first.node.textContent).toMatch(/^synchronized/));
  expect(second.node.textContent).toBe(first.node.textContent);
  const before = Number(first.node.textContent!.split(":")[1]);
  // One reader leaves; the other still follows the conversation.
  act(() => first.root.unmount());
  await act(async () => {
    await mock.dispatch({
      type: "thread.sendMessage",
      threadId,
      content: [{ type: "text", text: "After one reader left" }],
      delivery: "queue",
      idempotencyKey: "concurrent-readers",
    });
  });
  await vi.waitFor(() =>
    expect(Number(second.node.textContent!.split(":")[1])).toBeGreaterThan(before),
  );
  expect(second.node.textContent).toMatch(/^synchronized/);
});
