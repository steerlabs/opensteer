import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { appsList } from "../react/use-tabs.js";
import { HttpHostClient } from "./host-session-client.js";

/*
 * The Host's notices are not replayed. Whatever a notice alone keeps current is read again after
 * the client reattaches, since a change made during the gap was announced to nobody.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

it("reads the apps directory, schedules and connected agents again after a reattach", async () => {
  const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
  let appReads = 0;
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    reconnectBaseDelayMs: 0,
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/apps.list")) appReads++;
      return host.fetch(input, init);
    },
    webSocketFactory: host.connect,
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  await client.load();
  const apps = appsList(client);
  disposals.push(apps.subscribe(() => undefined));
  await vi.waitFor(() => expect(appReads).toBe(1));
  const connections = vi.fn();
  disposals.push(client.subscribeConnectionsChanged(connections));
  const triggers = client.getSnapshot().triggerRevision;
  // The socket drops; an app published meanwhile was announced to nobody.
  for (const socket of host.sockets) socket.close();
  await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"));
  await vi.waitFor(() => expect(appReads).toBe(2));
  expect(client.getSnapshot().triggerRevision).toBeGreaterThan(triggers);
  expect(connections).toHaveBeenCalled();
});
