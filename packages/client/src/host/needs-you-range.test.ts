import { createId } from "@opensteer/core";
import { NeedsYouEntrySchema, type NeedsYouEntry } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";

const at = "2026-11-13T12:00:00.000Z";

/** Another pending Request like `template`, asked `offsetMs` after `at`. */
function requestLike(template: NeedsYouEntry, offsetMs: number): NeedsYouEntry {
  return NeedsYouEntrySchema.parse({
    ...template,
    request: {
      ...template.request,
      id: createId("request"),
      createdAt: new Date(Date.parse(at) + offsetMs).toISOString(),
    },
  });
}

it("refreshes the loaded Needs you range without losing an older review or retaining settled cards", async () => {
  const mock = new MockHostClient({ latencyMs: 0, subagents: "needs" });
  await mock.load();
  const template = mock.getSnapshot().needsYou?.entries[0];
  expect(template, "the mock Home has no pending Request to copy").toBeDefined();
  const requests = Array.from({ length: 105 }, (_, i) => requestLike(template!, -i * 1000));
  let rows = [...requests];
  const transport = new MockPersonalHost(mock);
  const client = new HttpHostClient({
    baseUrl: "http://mock-host",
    webSocketFactory: transport.connect,

    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v1/rpc/needsYou.get") return transport.fetch(input, init);
      const query = JSON.parse(url.searchParams.get("input") ?? String(init?.body));
      const offset = query.before ? Number(query.before) : 0;
      const entries = rows.slice(offset, offset + 50);
      const end = offset + entries.length;
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            count: rows.length,
            entries,
            window: {
              byteCount: 100,
              itemCount: entries.length,
              totalItems: rows.length,
              hasMore: end < rows.length,
              nextBefore: end < rows.length ? String(end) : null,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    await client.load();
    await vi.waitFor(
      () =>
        expect([...transport.sockets][0]?.sent.length, "client never subscribed").toBeGreaterThan(
          0,
        ),
      { timeout: 1000 },
    );
    await client.loadEarlierNeedsYou();
    await vi.waitFor(
      () =>
        expect(
          client.getSnapshot().needsYou?.entries,
          "first Needs you page never arrived",
        ).toHaveLength(50),
      { timeout: 1000 },
    );
    await client.loadEarlierNeedsYou();
    const older = requests[99]!;
    expect(client.getSnapshot().needsYou?.entries).toContainEqual(older);
    rows = [
      requestLike(template!, 1000),
      ...requests.filter((entry) => entry !== requests[50] && entry !== requests[51]),
    ];
    transport.repairShell();
    await vi.waitFor(
      () =>
        expect(client.getSnapshot().needsYou?.count, "Needs you refresh never arrived").toBe(
          rows.length,
        ),
      { timeout: 1000 },
    );
    const refreshed = client.getSnapshot().needsYou!;
    expect(refreshed.entries).toContainEqual(older);
    expect(refreshed.entries).not.toContainEqual(requests[50]);
    expect(refreshed.entries).not.toContainEqual(requests[51]);
    expect(new Set(refreshed.entries.map((entry) => entry.request.id)).size).toBe(
      refreshed.entries.length,
    );
    await client.loadEarlierNeedsYou();
    expect(client.getSnapshot().needsYou?.entries).toEqual(rows);
  } finally {
    client.dispose();
    transport.dispose();
    mock.dispose();
  }
});
