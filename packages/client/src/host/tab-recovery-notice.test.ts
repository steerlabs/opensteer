import { BrowserSessionIdSchema, BrowserSurfaceIdSchema, TabIdSchema } from "@opensteer/core";
import type { TabCommand, TabCommandResult, TabViewer } from "@opensteer/protocol";
import { expect, it } from "vitest";
import { TabStore } from "./tab-store.js";
import { createTabsClient } from "./tabs-client.js";

const tabId = TabIdSchema.parse("srf_page");
const page = (recoveryNoticeId?: string): TabViewer => ({
  kind: "page",
  sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001"),
  surfaceId: BrowserSurfaceIdSchema.parse("srf_page"),
  ...(recoveryNoticeId ? { recoveryNotice: "This page reloaded.", recoveryNoticeId } : {}),
});

function home(viewers: TabViewer[]) {
  const sent: TabCommand[] = [];
  const client = createTabsClient({
    store: new TabStore(),
    listApps: async () => [],
    getApp: async () => {
      throw new Error("unused");
    },
    dispatch: async (command) => {
      sent.push(command as TabCommand);
      return {
        type: "tab.activate",
        tab: { tabId },
        viewer: viewers.shift()!,
      } as never as TabCommandResult;
    },
  });
  return { client, sent };
}

it("sends a seen recovery notice only to the Home that gave its id, for that tab", async () => {
  // A Home that never gives a notice id: the field is never sent, whatever the screen asks.
  const old = home([page(), page()]);
  await old.client.activateTab(tabId);
  await old.client.activateTab(tabId, { recoveryNoticeSeen: "note-1" });
  expect(old.sent.map((command) => "recoveryNoticeSeen" in command)).toEqual([false, false]);

  // A Home that gave one: it goes back once, and only the id it gave.
  const pooled = home([page("note-1"), page("note-1"), page("note-1"), page()]);
  await pooled.client.activateTab(tabId);
  await pooled.client.activateTab(tabId, { recoveryNoticeSeen: "note-other" });
  await pooled.client.activateTab(tabId, { recoveryNoticeSeen: "note-1" });
  await pooled.client.activateTab(tabId, { recoveryNoticeSeen: "note-1" });
  expect(
    pooled.sent.map((command) =>
      command.type === "tab.activate" ? (command.recoveryNoticeSeen ?? null) : "other",
    ),
  ).toEqual([null, null, "note-1", "note-1"]);

  // Once the Home stops giving the id, the client stops sending it.
  const later = home([page("note-1"), page(), page()]);
  await later.client.activateTab(tabId);
  await later.client.activateTab(tabId);
  await later.client.activateTab(tabId, { recoveryNoticeSeen: "note-1" });
  expect(later.sent.map((command) => "recoveryNoticeSeen" in command)).toEqual([
    false,
    false,
    false,
  ]);
});
