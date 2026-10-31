import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "./mock-host-client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
import { BrowserSurfaceIdSchema } from "@opensteer/core";

let client: MockHostClient | undefined;
afterEach(() => {
  client?.dispose();
  client = undefined;
  vi.useRealTimers();
});
function setup(now?: () => Date) {
  client = new MockHostClient({ latencyMs: 0, ...(now ? { now } : {}) });
  const session = client
    .getSnapshot()
    .browserSessions.find((session) => session.profileId && session.opener?.kind === "you")!;
  return { client, session, profileId: session.profileId! };
}
it("records committed opens once, navigation typed intent, and retained favicons after tabs close", async () => {
  vi.useFakeTimers();
  const { client, session, profileId } = setup();
  const input = {
    url: "https://history.example/first",
    typed: true,
    idempotencyKey: "history-open",
  };
  const opened = await client.openBrowserTab(session.id, input);
  await client.openBrowserTab(session.id, input);
  let history = unwrapRpcResult(await client.rpc["browser.history.get"]({ profileId }));
  expect(history.entries).toMatchObject([{ url: input.url, typedCount: 1, visitCount: 1 }]);
  client.sendBrowserCommand(session.id, {
    type: "navigation.go",
    surfaceId: opened.tabId,
    url: "https://history.example/second",
  });
  await vi.advanceTimersByTimeAsync(900);
  history = unwrapRpcResult(await client.rpc["browser.history.get"]({ profileId }));
  expect(history.entries.map((entry) => [entry.url, entry.typedCount])).toEqual([
    ["https://history.example/second", 0],
    [input.url, 1],
  ]);
  const iconRef = history.icons[0]!.iconRef;
  expect(iconRef).toMatch(/^[a-f\d]{64}$/u);
  const latest = client.getSnapshot().browserSessions.find((value) => value.id === session.id)!;
  await client.closeBrowserTab(session.id, opened.tabId, latest.tabCatalog!);
  const icons = unwrapRpcResult(
    await client.rpc["browser.history.icons.get"]({ profileId, iconRefs: [iconRef] }),
  );
  expect(icons.icons).toMatchObject([
    { iconRef, favicon: expect.stringMatching(/^data:image\/png;base64,/u) },
  ]);
  await client.browserHistory.load(profileId);
  await client.browserHistory.remove(profileId, input.url);
  expect(client.browserHistory.entries(profileId)).toHaveLength(1);
  await client.browserHistory.clear(profileId);
  history = unwrapRpcResult(await client.rpc["browser.history.get"]({ profileId }));
  expect(history).toEqual({ entries: [], icons: [] });
  expect(
    unwrapRpcResult(
      await client.rpc["browser.history.icons.get"]({ profileId, iconRefs: [iconRef] }),
    ),
  ).toEqual({ icons: [] });
});
it("bounds history at 300 entries and 90 days; deleted profiles, signed-out viewers and Guest retain none", async () => {
  let now = new Date("2026-10-30T12:00:00.000Z");
  const { client, session, profileId } = setup(() => now);
  const opened = await client.openBrowserTab(session.id);
  for (let i = 0; i < 310; i++) {
    now = new Date(now.getTime() + 1);
    client.sendBrowserCommand(session.id, {
      type: "navigation.go",
      surfaceId: opened.tabId,
      url: `https://history.example/${i}`,
      typed: i % 2 === 0,
    });
  }
  const read = () => client.rpc["browser.history.get"]({ profileId }).then(unwrapRpcResult);
  const history = await read();
  expect(history.entries).toHaveLength(300);
  expect(history.entries[0]?.url).toBe("https://history.example/309");
  expect(history.entries.at(-1)?.url).toBe("https://history.example/10");
  now = new Date(now.getTime() + 90 * 86_400_000);
  expect(await read()).toEqual({ entries: [], icons: [] });
  const guest = await client.openBrowserTab(
    { identity: { kind: "guest" }, placement: session.placement },
    { url: "https://guest.example/" },
  );
  client.sendBrowserCommand(guest.sessionId, {
    type: "navigation.go",
    surfaceId: BrowserSurfaceIdSchema.parse(guest.tabId),
    url: "https://guest.example/path",
    typed: true,
  });
  expect(await read()).toEqual({ entries: [], icons: [] });
  const missing = await client.rpc["browser.history.get"]({
    profileId: "bpr_99999999-9999-4999-8999-999999999999",
  });
  expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
  await client.openBrowserTab(session.id, { url: "https://delete.example/" });
  await client.browserHistory.load(profileId);
  await client.dispatch({
    type: "browser.profile.delete",
    profileId,
    idempotencyKey: "delete-profile",
  });
  expect(client.browserHistory.entries(profileId)).toEqual([]);
  expect(await client.rpc["browser.history.get"]({ profileId })).toMatchObject({
    ok: false,
    error: { code: "not_found" },
  });
  await client.rpc["auth.signOut"]({});
  expect(await client.rpc["browser.history.get"]({ profileId })).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
});

it("revalidates visible history after mock visits and direct history commands", async () => {
  const { client, session, profileId } = setup();
  const unsubscribe = client.browserHistory.subscribe(vi.fn());
  try {
    await client.browserHistory.load(profileId);
    const url = "https://live-history.example/path";
    await client.openBrowserTab(session.id, { url });
    await vi.waitFor(() =>
      expect(client.browserHistory.entries(profileId)).toMatchObject([{ url }]),
    );
    await client.dispatch({
      type: "browser.history.remove",
      profileId,
      url,
      idempotencyKey: "live-remove",
    });
    await vi.waitFor(() => expect(client.browserHistory.entries(profileId)).toEqual([]));
    await client.openBrowserTab(session.id, { url });
    await vi.waitFor(() =>
      expect(client.browserHistory.entries(profileId)).toMatchObject([{ url }]),
    );
    await client.dispatch({
      type: "browser.history.clear",
      profileId,
      idempotencyKey: "live-clear",
    });
    await vi.waitFor(() => expect(client.browserHistory.entries(profileId)).toEqual([]));
  } finally {
    unsubscribe();
  }
});
