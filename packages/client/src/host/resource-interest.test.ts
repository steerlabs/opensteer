import { createId } from "@opensteer/core";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { createHostSelection, hostSnapshotStore } from "./host-snapshot-store.js";
import { HttpHostClient, type WebSocketClient } from "./host-session-client.js";
import { ambientLeaseMs, readerGraceMs } from "./personal-resource-reads.js";

/*
 * Resource inventories over the real client: what a screen sees is only ever a complete
 * inventory, and a kind stays watched while something that read it is mounted.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});

async function realClient(options: { pages?: PersonalResourceKind } = {}) {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const interests: PersonalResourceKind[][] = [];
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const response = await host.fetch(input, init);
      if (!url.pathname.endsWith("/resources.detail.get")) return response;
      const asked = JSON.parse(url.searchParams.get("input")!) as {
        kind: PersonalResourceKind;
        cursor?: string;
      };
      if (asked.kind !== options.pages || asked.kind !== "machine") return response;
      // The Host pages the machines: the first one, then the rest under a cursor.
      const body = (await response.json()) as {
        data: { next: string | null; data: { machines: unknown[] } };
      };
      const machines = body.data.data.machines;
      body.data.data.machines = asked.cursor ? machines.slice(1) : machines.slice(0, 1);
      body.data.next = asked.cursor ? null : "the-rest";
      return Response.json(body);
    },
    webSocketFactory: () => {
      const socket = host.connect();
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const frame = JSON.parse(String(data)) as {
          type: string;
          interests?: PersonalResourceKind[];
        };
        if (frame.type === "client.resources.watch" || frame.type === "client.attach")
          interests.push([...(frame.interests ?? [])].sort());
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
  return { client, host, interests, watched: () => interests.at(-1) ?? [] };
}

it("never shows a screen part of an inventory the Host pages", async () => {
  const { client, host } = await realClient({ pages: "machine" });
  const all = host.client.getSnapshot().machines.length;
  expect(all).toBeGreaterThan(1);
  const selection = createHostSelection(hostSnapshotStore(client), (s) => s.machines);
  const seen: number[] = [];
  const unsubscribe = selection.subscribe(() => seen.push(selection.getSnapshot().length));
  disposals.push(unsubscribe);
  await vi.waitFor(() => expect(selection.getSnapshot()).toHaveLength(all));
  expect(seen.every((count) => count === 0 || count === all)).toBe(true);
});

it("watches a kind while a screen that read it is mounted, and lets go after it unmounts", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { client, watched } = await realClient();
  const store = hostSnapshotStore(client);
  const mount = () => {
    const selection = createHostSelection(store, (s) => s.machines);
    return selection.subscribe(() => undefined);
  };
  const unmount = mount();
  await vi.waitFor(() => expect(watched()).toContain("machine"));
  unmount();
  // Navigating away and back within the grace keeps the watch; nothing is read again.
  vi.advanceTimersByTime(readerGraceMs - 1);
  const remount = mount();
  vi.advanceTimersByTime(readerGraceMs * 2);
  expect(watched()).toContain("machine");
  remount();
  vi.advanceTimersByTime(readerGraceMs);
  await vi.waitFor(() => expect(watched()).not.toContain("machine"));
  // A later mount watches it again.
  disposals.push(mount());
  await vi.waitFor(() => expect(watched()).toContain("machine"));
});

it("keeps a read outside any screen for a short lease, renewed by each read", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { client, watched } = await realClient();
  void client.getSnapshot().harnesses;
  await vi.waitFor(() => expect(watched()).toContain("harness"));
  vi.advanceTimersByTime(ambientLeaseMs - 1);
  void client.getSnapshot().harnesses;
  vi.advanceTimersByTime(ambientLeaseMs - 1);
  expect(watched()).toContain("harness");
  vi.advanceTimersByTime(1);
  await vi.waitFor(() => expect(watched()).not.toContain("harness"));
});

it("holds what a subscription's listener reads for as long as it is subscribed", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { client, watched } = await realClient();
  const unsubscribe = client.subscribe(() => void client.getSnapshot().browserProfiles);
  // A repair publishes; the listener reads the field on the subscription's behalf.
  await client.refresh();
  await vi.waitFor(() => expect(watched()).toContain("browser-profile"));
  vi.advanceTimersByTime(ambientLeaseMs * 2);
  expect(watched()).toContain("browser-profile");
  unsubscribe();
  vi.advanceTimersByTime(readerGraceMs);
  await vi.waitFor(() => expect(watched()).not.toContain("browser-profile"));
});

it("keeps a new browser profile's home when the command comes before any read of the homes", async () => {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const sent: { type: string; input?: { homeRunnerId?: unknown } }[] = [];
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch")) sent.push(JSON.parse(String(init?.body)));
      return host.fetch(input, init);
    },
    webSocketFactory: host.connect,
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load();
  const home = createId("runner");
  await client
    .dispatch({
      type: "browser.profile.create",
      idempotencyKey: "profile:create:test",
      input: { name: "Work", homeRunnerId: home },
    })
    .catch(() => undefined);
  expect(sent.find(({ type }) => type === "browser.profile.create")?.input?.homeRunnerId).toBe(
    home,
  );
});
