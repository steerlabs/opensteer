import { expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";

function personalHome(baseUrl: string) {
  const host = new MockPersonalHost(
    new MockHostClient({
      world: "first-run",
      latencyMs: 0,
      places: "absent",
      automations: "absent",
      subagents: "absent",
    }),
  );
  const client = new HttpHostClient({
    baseUrl,
    fetch: host.fetch,
    webSocketFactory: host.connect,
  });
  return { host, client };
}

it("keeps two personal Homes attached together with independent durable positions", async () => {
  const first = personalHome("http://personal-a");
  const second = personalHome("http://personal-b");
  try {
    const firstCut = String(first.host.client.getSnapshot().revision);
    const secondCut = String(second.host.client.getSnapshot().revision);
    await Promise.all([first.client.load(), second.client.load()]);
    await vi.waitFor(() => {
      expect(first.client.deploymentPosition()).toBe(firstCut);
      expect(second.client.deploymentPosition()).toBe(secondCut);
    });
    expect(BigInt(firstCut)).toBeLessThan(47n);
    first.host.publish("47");
    await vi.waitFor(() => expect(first.client.deploymentPosition()).toBe("47"));
    expect(first.client.getSnapshot().tasks?.entries).toEqual([]);
    expect(second.client.deploymentPosition()).toBe(secondCut);
    expect(first.host.sockets.size).toBe(1);
    expect(second.host.sockets.size).toBe(1);
    second.client.dispose();
    expect(first.host.sockets.size).toBe(1);
  } finally {
    first.client.dispose();
    first.host.dispose();
    second.client.dispose();
    second.host.dispose();
  }
});
