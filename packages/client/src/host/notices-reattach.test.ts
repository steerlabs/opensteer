import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { appsList } from "../react/use-tabs.js";
import { connectedAgentsClient } from "./connected-agents.js";
import { HttpHostClient } from "./host-session-client.js";
import { schedulesClient } from "./schedules.js";

/*
 * The Host's notices are not replayed. A list a notice keeps current is read again after the
 * client reattaches, once per mounted reader, and not at all when nothing shows it.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

const lists = ["apps.list", "triggers.list", "connections.list"] as const;

async function harness() {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  const reads = new Map<string, number>(lists.map((name) => [name, 0]));
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    reconnectBaseDelayMs: 0,
    fetch: (input, init) => {
      const name = new URL(input instanceof Request ? input.url : String(input)).pathname
        .split("/")
        .at(-1)!;
      if (reads.has(name)) reads.set(name, reads.get(name)! + 1);
      return host.fetch(input, init);
    },
    webSocketFactory: host.connect,
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load();
  const counts = () => Object.fromEntries(reads);
  /** The socket drops and the client attaches again; a change meanwhile was announced to nobody. */
  const reattach = async () => {
    const before = [...host.sockets];
    for (const socket of host.sockets) socket.close();
    await vi.waitFor(() => {
      expect([...host.sockets].some((socket) => !before.includes(socket))).toBe(true);
      expect(client.getSnapshot().connection).toBe("connected");
    });
  };
  // Anything the reattach started is asked before these round trips answer.
  const settle = async () => {
    for (let index = 0; index < 5; index++) await client.rpc["auth.config"]({});
  };
  return { client, counts, reattach, settle };
}

it("reads nothing again on a reattach when no list is shown", async () => {
  const { counts, reattach, settle } = await harness();
  await reattach();
  await settle();
  expect(counts()).toEqual({ "apps.list": 0, "triggers.list": 0, "connections.list": 0 });
});

it("reads each shown list once per reattach: the apps directory, schedules and connected agents", async () => {
  const { client, counts, reattach, settle } = await harness();
  disposals.push(appsList(client).subscribe(() => undefined));
  disposals.push(schedulesClient(client).list.subscribe(() => undefined));
  disposals.push(connectedAgentsClient(client).read.subscribe(() => undefined));
  await vi.waitFor(() =>
    expect(counts()).toEqual({ "apps.list": 1, "triggers.list": 1, "connections.list": 1 }),
  );
  await reattach();
  await vi.waitFor(() =>
    expect(counts()).toEqual({ "apps.list": 2, "triggers.list": 2, "connections.list": 2 }),
  );
  await settle();
  expect(counts()).toEqual({ "apps.list": 2, "triggers.list": 2, "connections.list": 2 });
});
