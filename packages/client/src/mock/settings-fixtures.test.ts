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
      expect(after.places).toEqual(before.places);
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
  it("refuses unsupported loose-skill placement without a success or invalidation", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const changed = vi.fn();
      client.subscribePluginsChanged(changed);
      const row = value(await client.rpc["plugins.overview.get"]({})).rows.find(
        ({ target }) => target.kind === "skill",
      )!;
      const result = await client.rpc["commands.dispatch"]({
        type: "settings.plugin.placement.set",
        idempotencyKey: "move-skill",
        target: row.target,
        expectedRevision: 0,
        mainIncluded: false,
        projects: [],
        personalEverywhere: null,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(changed).not.toHaveBeenCalled();
    } finally {
      client.dispose();
    }
  });
  it("supports Main exclusion and Personal Everywhere; directory suggestions are real Requests", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const overview = value(await client.rpc["plugins.overview.get"]({}));
      const row = overview.rows.find((row) => row.title === "Gmail")!;
      const result = value(
        await client.rpc["commands.dispatch"]({
          type: "settings.plugin.placement.set",
          idempotencyKey: "main-exclusion",
          target: row.target,
          expectedRevision: 0,
          mainIncluded: false,
          projects: [],
          personalEverywhere: null,
        }),
      );
      expect(result.type).toBe("settings.plugin.placement.set");
      const detail = value(await client.rpc["plugins.detail.get"]({ target: row.target }));
      expect(detail.row.placement.mainIncluded).toBe(false);
      expect(
        await client.rpc["commands.dispatch"]({
          type: "settings.plugin.placement.set",
          idempotencyKey: "everywhere",
          target: row.target,
          expectedRevision: 1,
          mainIncluded: true,
          projects: [],
          personalEverywhere: {
            accounts: detail.accounts.map(({ connectionId }) => ({ connectionId, access: "read" })),
          },
        }),
      ).toMatchObject({ ok: true });
      const directory = value(await client.rpc["plugins.directory.get"]({}));
      const requests = value(await client.rpc["requests.list"]({}));
      expect(directory.requests.length).toBeGreaterThan(0);
      expect(
        directory.requests.every(({ requestId }) =>
          requests.requests.some(({ request }) => request.id === requestId),
        ),
      ).toBe(true);
      const devices = value(await client.rpc["devices.overview.get"]({}));
      expect(devices.devices.some(({ device }) => device?.platform === "android")).toBe(true);
      expect(
        devices.devices.every((device) =>
          client.getSnapshot().machines.some((machine) => machine.id === device.id),
        ),
      ).toBe(true);
      expect(devices.devices.some((device) => device.name === "Slack runtime")).toBe(false);
    } finally {
      client.dispose();
    }
  });
});
