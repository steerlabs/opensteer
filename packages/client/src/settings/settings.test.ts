import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { unwrapRpcResult } from "../host/index.js";
import {
  createSettingsRead,
  pluginGroups,
  pluginPath,
  pluginTargetFromPath,
  pluginState,
  redirectSettingsPath,
  settingsRedirects,
} from "./index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("Settings models", () => {
  it("keeps repair ahead of waiting, Off ahead of repair, and exact account identities", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const { rows } = unwrapRpcResult(await client.rpc["plugins.overview.get"]({}));
      const gmail = rows.find((row) => row.title === "Gmail")!;
      expect(pluginState({ ...gmail, issues: ["waiting-device", "needs-sign-in"] })).toEqual({
        group: "Needs you",
        label: "Needs sign-in",
      });
      expect(
        pluginState({
          ...gmail,
          placement: { ...gmail.placement, enabled: false },
          issues: ["needs-sign-in"],
        }),
      ).toEqual({ group: "Turned off", label: "Turned off" });
      expect(pluginState({ ...gmail, issues: ["waiting-device"] })).toEqual({
        group: "On",
        label: "Waiting",
      });
      expect(pluginGroups(rows, "GMAIL", "accounts").On).toContainEqual(gmail);
      const detail = unwrapRpcResult(
        await client.rpc["plugins.detail.get"]({ target: gmail.target }),
      );
      expect(new Set(detail.accounts.map((account) => account.connectionId)).size).toBe(2);
      for (const row of rows) {
        const [, kind, id] = pluginPath(row.target).slice("/settings/plugins".length).split("/");
        expect(pluginTargetFromPath(kind!, decodeURIComponent(id!))).toEqual(row.target);
      }
      expect(pluginTargetFromPath("service", '{"definitionId":"gmail","secret":"no"}')).toBeNull();
    } finally {
      client.dispose();
    }
  });
  it("coalesces bursts and fences reconnect and disposed attachments", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const publish = vi.fn();
    const fail = vi.fn();
    const page = createSettingsRead<number>(read, publish, fail);
    const done = page.refresh();
    for (let i = 0; i < 50; i++) void page.refresh();
    void page.reconnect();
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2), { timeout: 1000 });
    expect(publish).not.toHaveBeenCalled();
    page.dispose();
    second.resolve(2);
    await done;
    expect(publish).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
  it("retains the last readable value after failure and can reread", async () => {
    const publish = vi.fn();
    const fail = vi.fn();
    const page = createSettingsRead(
      vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(2),
      publish,
      fail,
    );
    await page.refresh();
    await page.refresh();
    expect(publish.mock.calls).toEqual([[1]]);
    expect(fail).toHaveBeenCalledOnce();
    await page.reconnect();
    expect(publish.mock.calls).toEqual([[1], [2]]);
  });
  it.each(settingsRedirects)("redirects %s with raw callback selectors", (from, to) => {
    const tail = "?integrationAttempt=a%2Bb&provider=google&workspace=w#computer-app-mail";
    expect(redirectSettingsPath(`${from}${tail}`)).toBe(`${to}${tail}`);
    expect(redirectSettingsPath(`${from}/child${tail}`)).toBe(
      `${to}${to === "/settings/plugins" ? "" : "/child"}${tail}`,
    );
    expect(redirectSettingsPath(`${from}-other`)).toBe(
      from.startsWith("/settings/apps/") ? "/settings/plugins" : null,
    );
  });
});
