import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { resourceBackedFields, type HostSnapshot } from "./client.js";
import { HttpHostClient } from "./host-session-client.js";

/*
 * Reading a resource-backed HostSnapshot field is what asks the Host for it; the repository guard
 * `tests/resource-backed-fields.test.ts` keeps that the only way.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

it("reads each field's kinds the first time anything reads the field, with no watch", async () => {
  for (const [field, kinds] of Object.entries(resourceBackedFields)) {
    const host = new MockPersonalHost(new MockHostClient({ latencyMs: 0 }));
    const reads = new Set<string>();
    const client = new HttpHostClient({
      baseUrl: "http://scoped-host",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/resources.detail.get"))
          reads.add(JSON.parse(url.searchParams.get("input")!).kind);
        return host.fetch(input, init);
      },
      webSocketFactory: host.connect,
      capabilities: [],
    });
    disposals.push(() => {
      client.dispose();
      host.dispose();
    });
    await client.load();
    expect([...reads], `${field} was read before anything asked`).toEqual([]);
    void client.getSnapshot()[field as keyof HostSnapshot];
    await vi.waitFor(() =>
      expect([...reads].sort(), `reading ${field}`).toEqual(
        [...(kinds as readonly PersonalResourceKind[])].sort(),
      ),
    );
  }
});
