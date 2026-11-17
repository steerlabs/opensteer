import { describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { unwrapRpcResult } from "../host/index.js";
import {
  pluginGroups,
  pluginPath,
  pluginTargetFromPath,
  pluginState,
  redirectSettingsPath,
  settingsRedirects,
} from "./index.js";

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
      expect(pluginGroups(rows, "GMAIL").On).toContainEqual(gmail);
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
  it.each(settingsRedirects)("redirects %s with raw callback selectors", (from, to) => {
    const tail = "?integrationAttempt=a%2Bb&provider=google&workspace=w#computer-app-mail";
    expect(redirectSettingsPath(`${from}${tail}`)).toBe(`${to}${tail}`);
    expect(redirectSettingsPath(`${from}/child${tail}`)).toBe(
      `${to}${to === "/settings/plugins" || to === "/settings/account" ? "" : "/child"}${tail}`,
    );
    expect(redirectSettingsPath(`${from}-other`)).toBe(
      from.startsWith("/settings/apps/") ? "/settings/plugins" : null,
    );
  });
});
