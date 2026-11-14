import { expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";

it.each([
  { capabilities: ["devices-v1" as const], renders: false },
  { capabilities: undefined, renders: true },
  { capabilities: [], renders: true },
  { capabilities: ["devices-v1" as const], renders: true },
])(
  "negotiates device Request reads only with advertised support (%j)",
  async ({ capabilities, renders }) => {
    const mock = new MockHostClient({ latencyMs: 0, devices: "seeded" });
    const transport = new MockPersonalHost(mock);
    const inputs: { name: string; input: unknown }[] = [];
    const client = new HttpHostClient({
      baseUrl: "http://mock-host",
      ...(renders ? { deviceAccessRequests: "include" as const } : {}),
      ...(capabilities ? { capabilities } : {}),
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (
          [
            "needsYou.get",
            "requests.list",
            "tasks.list",
            "thread.events.list",
            "thread.assignments.list",
          ].some((name) => url.pathname === `/v1/rpc/${name}`)
        )
          inputs.push({
            name: url.pathname.slice("/v1/rpc/".length),
            input: JSON.parse(url.searchParams.get("input") ?? String(init?.body)),
          });
        return transport.fetch(input, init);
      },
      webSocketFactory: transport.connect,
      refreshIntervalMs: 0,
    });
    try {
      await client.load();
      await vi.waitFor(
        () =>
          expect(
            [...transport.sockets].some((socket) => socket.sent.length),
            "the client never subscribed",
          ).toBe(true),
        { timeout: 1_000 },
      );
      [...transport.sockets][0]!.deliver({ type: "host.requests-changed" });
      [...transport.sockets][0]!.deliver({ type: "host.tasks-changed" });
      await vi.waitFor(() => expect(inputs.length, "Needs you was never read").toBeGreaterThan(0), {
        timeout: 1_000,
      });
      const request = Object.values(mock.getSnapshot().requests)
        .flat()
        .find(({ kind }) => kind === "device.access")!;
      const release = client.observeThread(request.originatingThreadId);
      try {
        await client.loadLatestTranscript(request.originatingThreadId);
        await vi.waitFor(
          () => {
            for (const name of [
              "needsYou.get",
              "requests.list",
              "tasks.list",
              "thread.events.list",
            ])
              expect(
                inputs.some((entry) => entry.name === name),
                `${name} was never read`,
              ).toBe(true);
          },
          { timeout: 1_000 },
        );
      } finally {
        release();
      }
      const supported = renders && (capabilities?.includes("devices-v1") ?? false);
      for (const { input } of inputs) {
        if (supported) expect(input).toHaveProperty("deviceAccessRequests", "include");
        else expect(input).not.toHaveProperty("deviceAccessRequests");
      }
      const subscription = JSON.parse([...transport.sockets][0]!.sent[0]!);
      if (supported) expect(subscription).toHaveProperty("deviceAccessRequests", "include");
      else expect(subscription).not.toHaveProperty("deviceAccessRequests");
      await vi.waitFor(
        () =>
          expect(client.getSnapshot().needsYou, "the Needs you page never arrived").not.toBeNull(),
        { timeout: 1_000 },
      );
      expect(
        client
          .getSnapshot()
          .needsYou!.entries.some(
            (entry) => entry.kind === "request" && entry.request.kind === "device.access",
          ),
      ).toBe(supported);
    } finally {
      client.dispose();
      transport.dispose();
    }
  },
);
