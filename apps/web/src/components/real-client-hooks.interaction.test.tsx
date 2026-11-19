// @vitest-environment happy-dom

import { HttpHostClient, type WebSocketClient } from "@opensteer/client/host";
import { MockHostClient, MockPersonalHost } from "@opensteer/client/mock";
import { useHostSelector, useRequestAsker } from "@opensteer/client/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

/*
 * Shared hooks over the real client: values reach them through protocol frames and the
 * thread's detail stores, never through the mock's own snapshot fields.
 */

const roots: Root[] = [];
const disposals: (() => void)[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const dispose of disposals.splice(0)) dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function realClient(seed: MockHostClient) {
  await seed.load();
  const host = new MockPersonalHost(seed);
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: host.fetch,
    webSocketFactory: host.connect,
    capabilities: [],
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load();
  return { client, host };
}

it("names the subagent a nested asker runs inside, as the Host's waiting Request says", async () => {
  const { client, host } = await realClient(
    new MockHostClient({ latencyMs: 0, places: "absent", subagents: "needs" }),
  );
  const nested = host.client
    .getSnapshot()
    .waitingRequests.find(({ subagent }) => subagent?.title === "Check webhook retries")!;
  const seen: (string | null)[] = [];
  function Byline() {
    const asker = useRequestAsker(client, nested.request);
    seen.push(asker?.byline ?? null);
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  act(() => root.render(<Byline />));
  await vi.waitFor(() => expect(seen.at(-1)).toBe(`in ${nested.subagent!.within!.title}`));
  expect(nested.subagent!.within!.title).not.toBe("");
});

it("watches what a mounted screen reads, through re-renders, and lets go after it unmounts", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const interests: string[][] = [];
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: host.fetch,
    webSocketFactory: () => {
      const socket = host.connect();
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const frame = JSON.parse(String(data)) as { type: string; interests?: string[] };
        if (frame.type === "client.resources.watch" || frame.type === "client.attach")
          interests.push([...(frame.interests ?? [])]);
        send(data);
      };
      return socket as unknown as WebSocketClient;
    },
    capabilities: [],
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load();
  const watched = () => interests.at(-1) ?? [];
  function Machines({ label }: { label: string }) {
    // An inline selector: a new selection on every render, one reader for the mounted screen.
    const count = useHostSelector(client, (snapshot) => snapshot.machines.length);
    return <p>{`${label} ${count}`}</p>;
  }
  const mount = () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root.render(<Machines label="a" />));
    return root;
  };
  const root = mount();
  await vi.waitFor(() => expect(watched()).toContain("machine"));
  for (const label of ["b", "c", "d"]) act(() => root.render(<Machines label={label} />));
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(watched()).toContain("machine");
  act(() => root.unmount());
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  await vi.waitFor(() => expect(watched()).not.toContain("machine"));
  roots.push(mount());
  await vi.waitFor(() => expect(watched()).toContain("machine"));
});
