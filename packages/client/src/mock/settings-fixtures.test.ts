import { describe, expect, it, vi } from "vitest";
import { hostApi } from "@opensteer/protocol";
import { agentHomeSkills } from "../plugins/index.js";
import { MockHostClient } from "./mock-host-client.js";

function value<T>(result: { ok: true; data: T } | { ok: false }): T {
  if (!result.ok) throw new Error("RPC refused");
  return result.data;
}

describe("Settings mock RPC", () => {
  it("turns an Agent home skill off and on, emits hints, and deduplicates retries", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const changed = vi.fn();
      const unsubscribe = client.subscribePluginsChanged(changed);
      const overview = value(await client.rpc["plugins.overview.get"]({}));
      expect(hostApi["plugins.overview.get"].success.safeParse(overview).success).toBe(true);
      const row = agentHomeSkills(overview.rows)[0]!;
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
      const after = agentHomeSkills(value(await client.rpc["plugins.overview.get"]({})).rows).find(
        (skill) => skill.target.fullName === row.target.fullName,
      )!;
      expect(after.placement.enabled).toBe(false);
      const stale = await client.rpc["commands.dispatch"]({ ...command, idempotencyKey: "stale" });
      expect(stale.ok).toBe(false);
      const on = await client.rpc["commands.dispatch"]({
        ...command,
        idempotencyKey: "on",
        expectedRevision: after.placement.revision,
        enabled: true,
      });
      expect(on.ok).toBe(true);
      unsubscribe();
    } finally {
      client.dispose();
    }
  });
});
