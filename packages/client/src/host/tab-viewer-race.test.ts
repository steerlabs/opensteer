import { TabSchema, createId } from "@opensteer/core";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient, type WebSocketClient } from "./host-session-client.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

const listed = TabSchema.parse({
  tabId: "listed-tab",
  kind: "page",
  title: "Ada Lovelace",
  computer: { computerId: createId("runner"), name: "Studio Mac" },
  groupId: null,
  state: "open",
  openedBy: "person",
  usedBy: [],
  createdAt: "2026-11-15T12:00:00.000Z",
  updatedAt: "2026-11-15T12:00:00.000Z",
  url: "https://ada.example/",
  profile: null,
});

it("keeps a tab inventory read that lands before the viewer is known", async () => {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const tabRead = Promise.withResolvers<void>();
  const held: (() => void)[] = [];
  let attachReleased = false;
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const response = await host.fetch(input, init);
      if (
        !url.pathname.endsWith("/resources.detail.get") ||
        JSON.parse(url.searchParams.get("input")!).kind !== "tab"
      )
        return response;
      const body = (await response.json()) as {
        ok: true;
        data: { data: { tabs: { tabs: unknown[] } } };
      };
      body.data.data.tabs.tabs = [listed];
      queueMicrotask(tabRead.resolve);
      return Response.json(body);
    },
    // The shell cut that names the viewer arrives only after the tab inventory read landed.
    webSocketFactory: () => {
      const socket = host.connect() as unknown as WebSocketClient;
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (attachReleased) return send(data);
        held.push(() => send(data));
      };
      return socket;
    },
    capabilities: [],
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  disposals.push(client.watchPersonalResource("tab", () => {}));
  const loading = client.load();
  await tabRead.promise;
  await vi.waitFor(() => expect(client.getSnapshot().tabs.get(listed.tabId)).toBeDefined());
  attachReleased = true;
  for (const send of held.splice(0)) send();
  await loading;
  await vi.waitFor(() =>
    expect(client.getSnapshot().tabs.get(listed.tabId)?.title).toBe("Ada Lovelace"),
  );
});
