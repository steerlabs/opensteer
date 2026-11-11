import { describe, expect, it, vi } from "vitest";
import { hostApi } from "@opensteer/protocol";
import { MockHostClient } from "./mock-host-client.js";

function value<T>(result: { ok: true; data: T } | { ok: false }): T {
  if (!result.ok) throw new Error("RPC refused");
  return result.data;
}

describe("Settings mock RPC", () => {
  it("retains accounts and placement across Off, emits hints, and deduplicates retries", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const changed = vi.fn();
      const unsubscribe = client.subscribePluginsChanged(changed);
      const overview = value(await client.rpc["plugins.overview.get"]({}));
      expect(hostApi["plugins.overview.get"].success.safeParse(overview).success).toBe(true);
      const row = overview.rows.find((row) => row.title === "Gmail")!;
      const before = value(await client.rpc["plugins.detail.get"]({ target: row.target }));
      expect(before.accounts).toHaveLength(2);
      const command = {
        type: "settings.plugin.enabled.set" as const,
        idempotencyKey: "settings-off",
        target: row.target,
        expectedRevision: row.placement.revision,
        enabled: false,
      };
      const result = await client.rpc["commands.dispatch"](command);
      expect(result.ok).toBe(true);
      expect(await client.rpc["commands.dispatch"](command)).toEqual(result);
      expect(changed).toHaveBeenCalledExactlyOnceWith({ type: "host.plugins-changed" });
      const after = value(await client.rpc["plugins.detail.get"]({ target: row.target }));
      expect(after.accounts).toEqual(before.accounts);
      expect(after.row.placement.enabled).toBe(false);
      const stale = await client.rpc["commands.dispatch"]({ ...command, idempotencyKey: "stale" });
      expect(stale.ok).toBe(false);
      const on = await client.rpc["commands.dispatch"]({
        ...command,
        idempotencyKey: "on",
        expectedRevision: after.row.placement.revision,
        enabled: true,
      });
      expect(on.ok).toBe(true);
      unsubscribe();
    } finally {
      client.dispose();
    }
  });

  it("updates only person-installed plugins from their folder", async () => {
    const client = new MockHostClient({
      latencyMs: 0,
      agentPlugins: [{ id: "tapo-camera", name: "tapo-camera" }],
    });
    try {
      await client.dispatch({
        type: "plugin.install",
        input: { directory: "/plugins/review" },
        idempotencyKey: "person-install",
      });
      const rows = value(await client.rpc["plugin.list"]({})).plugins;
      const person = String(rows.find((row) => row.name === "review")!.id);
      const details = await Promise.all(
        ["tapo-camera", person].map(async (pluginId) =>
          value(await client.rpc["plugins.detail.get"]({ target: { kind: "plugin", pluginId } })),
        ),
      );
      expect(
        details.map((d) => [d.row.source.kind, d.row.permissions.canUpdate, d.sourceFolder]),
      ).toEqual([
        ["folder", false, null],
        ["plugin", true, "/plugins/review"],
      ]);
      expect(details[0]!.row.issues).toEqual([]);
      await expect(
        client.dispatch({
          type: "plugin.update",
          pluginId: "tapo-camera",
          input: { directory: "/plugins/tapo-camera" },
          idempotencyKey: "agent-update",
        }),
      ).rejects.toThrow("Agent-made plugins update when an agent installs their folder again.");
      await client.dispatch({
        type: "plugin.update",
        pluginId: person,
        input: { directory: "/plugins/review" },
        idempotencyKey: "person-update",
      });
    } finally {
      client.dispose();
    }
  });
});
