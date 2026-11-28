import { afterEach, expect, it, vi } from "vitest";
import { DeviceIdSchema, type AgentWorkingIn } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { readTaskActivity } from "./agent-work.js";
import { HttpHostClient } from "./host-session-client.js";

/*
 * Where a connected agent works now reaches the client by one notice only, on the socket it
 * arrives on: a reattach drops what the client held, and no read can bring an older value back.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

const threadId = "thr_00000000-0000-4000-8000-000000000001";
const sessionId = "ags_00000000-0000-4000-8000-000000000001";

async function harness() {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    reconnectBaseDelayMs: 0,
    fetch: (input, init) => host.fetch(input, init),
    webSocketFactory: host.connect,
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load();
  const tell = (tabId: string | null, device?: Pick<AgentWorkingIn, "computerId" | "target">) => {
    for (const socket of host.sockets)
      socket.deliver({
        type: "host.agent-working-in",
        threadId,
        sessionId,
        tabId,
        ...device,
      } as never);
  };
  const held = () => client.getSnapshot().agentWorkingIn?.[threadId]?.tabId;
  const reattach = async () => {
    const before = [...host.sockets];
    for (const socket of host.sockets) socket.close();
    await vi.waitFor(() => {
      expect([...host.sockets].some((socket) => !before.includes(socket))).toBe(true);
      expect(client.getSnapshot().connection).toBe("connected");
    });
  };
  return { client, tell, held, reattach };
}

it("drops where an agent worked as the client attaches again, before anything is said on the new socket", async () => {
  const { tell, held, reattach } = await harness();
  tell("tab_a");
  await vi.waitFor(() => expect(held()).toBe("tab_a"));
  await reattach();
  expect(held()).toBeUndefined();
  // The Home says it again on the new socket, as it attaches.
  tell("tab_b");
  await vi.waitFor(() => expect(held()).toBe("tab_b"));
});

it("keeps a null notice: no activity read, however late, names the tab again", async () => {
  const { client, tell, held } = await harness();
  tell("tab_a");
  await vi.waitFor(() => expect(held()).toBe("tab_a"));
  const late = readTaskActivity(client, threadId);
  tell(null);
  await vi.waitFor(() => expect(held()).toBeUndefined());
  const operations = await late.catch(() => []);
  expect(JSON.stringify(operations)).not.toContain("tab_a");
  expect(held()).toBeUndefined();
});

it("keeps the current record when the socket repeats the same device place", async () => {
  const { client, tell, reattach } = await harness();
  const computerId = DeviceIdSchema.parse("rnr_00000000-0000-4000-8000-000000000001");
  const target = { grant: { kind: "device" as const }, name: "Studio Mac", device: null };
  const place = () => client.getSnapshot().agentWorkingIn?.[threadId];
  await reattach();
  tell(null, { computerId, target });
  await vi.waitFor(() => expect(place()?.target).toEqual(target));
  const first = place();
  tell(null, { computerId, target: structuredClone(target) });
  expect(place()).toBe(first);
  tell(null, { computerId, target: { ...target, name: "Notes" } });
  expect(place()?.target?.name).toBe("Notes");
});
