import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient, type WebSocketClient } from "./host-session-client.js";

/*
 * A tab the person just opened, confirmed by its command's answer, is never taken away by a tab
 * inventory read before it opened.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

it("keeps a just-opened tab when an older tab inventory lands after the command", async () => {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const control = { holdTabs: false, holdPushes: false };
  const heldTabs: (() => void)[] = [];
  const heldPushes: (() => void)[] = [];
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const kind = url.pathname.endsWith("/resources.detail.get")
        ? (JSON.parse(url.searchParams.get("input")!).kind as PersonalResourceKind)
        : undefined;
      // The answer is what the Host held when the read reached it.
      const response = await host.fetch(input, init);
      if (kind !== "tab" || !control.holdTabs) return response;
      const body = await response.text();
      await new Promise<void>((resolve) => heldTabs.push(resolve));
      return new Response(body, { status: response.status });
    },
    webSocketFactory: () => {
      const socket = host.connect();
      const deliver = socket.deliver.bind(socket);
      // The Host's revision push for the open is still on its way.
      socket.deliver = (frame) => {
        if (control.holdPushes && frame.type === "host.resource")
          heldPushes.push(() => deliver(frame));
        else deliver(frame);
      };
      return socket as unknown as WebSocketClient;
    },
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load();
  const app = (await client.listApps()).find(
    (candidate) =>
      ![...host.client.getSnapshot().tabs.rows.values()].some(
        (tab) => tab.appId === candidate.appId,
      ),
  )!;
  // A screen shows the tabs; their first rows read is out when the person opens one.
  control.holdTabs = true;
  const tabs = client.getSnapshot().tabs;
  await vi.waitFor(() => expect(heldTabs).toHaveLength(1));
  await vi.waitFor(() => expect(client.getSnapshot().loadedResources).toContain("tab-layout"));
  control.holdPushes = true;
  const opened = await client.openTab({ kind: "app", appId: app.appId });
  expect(tabs.get(opened.tabId)).toBeDefined();
  // The rows read before the open land, at the revision the client last heard of.
  control.holdTabs = false;
  for (const release of heldTabs.splice(0)) release();
  await vi.waitFor(() => expect(client.getSnapshot().loadedResources).toContain("tab"));
  expect(client.getSnapshot().tabs.get(opened.tabId)).toBeDefined();
  // The push lands; the inventory read after it holds the tab too.
  control.holdPushes = false;
  for (const release of heldPushes.splice(0)) release();
  await vi.waitFor(() => expect(client.getSnapshot().tabs.complete).toBe(true));
  expect(client.getSnapshot().tabs.get(opened.tabId)).toBeDefined();
});
