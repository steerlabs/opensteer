// @vitest-environment happy-dom

import { HttpHostClient } from "@opensteer/client/host";
import { MockHostClient, MockPersonalHost } from "@opensteer/client/mock";
import { useRequestAsker } from "@opensteer/client/react";
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
