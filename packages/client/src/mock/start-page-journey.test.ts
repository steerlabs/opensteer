import { withTimeout } from "@opensteer/shared/withTimeout";
import { describe, expect, it, vi } from "vitest";
import { MockHostClient } from "./mock-host-client.js";
import { placeList } from "../host/places.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
describe("start page mock journey", () => {
  it("reuses only your browser; starts exactly one initial page and replays identity opens", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const snapshot = client.getSnapshot();
      expect(snapshot.browserProfiles.map((profile) => profile.name)).toEqual(
        expect.arrayContaining(["Personal", "Work"]),
      );
      const task = snapshot.browserSessions.find(
        (session) => session.profileId && session.opener?.kind === "task",
      )!;
      const yours = snapshot.browserSessions.find(
        (session) => session.profileId === task.profileId && session.opener?.kind === "you",
      )!;
      const opened = await client.openBrowserTab(
        { identity: { kind: "profile", profileId: task.profileId! } },
        { url: "https://example.com/one", idempotencyKey: "reuse" },
      );
      expect(opened.sessionId).toBe(yours.id);
      expect(opened.browserStarted).toBe(false);
      const rpc = {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        url: "https://start.example/path",
        idempotencyKey: "new-browser",
        placement: {
          kind: "runner",
          runnerId: snapshot.machines.find((machine) => machine.name === "Studio Mac")!.id,
        },
      } as const;
      const before = client.getSnapshot().browserSessions.length;
      const [a, b] = await Promise.all([
        client.rpc["commands.dispatch"](rpc),
        client.rpc["commands.dispatch"](rpc),
      ]);
      expect(a).toEqual(b);
      const result = unwrapRpcResult(a);
      expect(result.type).toBe("browser.tab.open");
      if (result.type !== "browser.tab.open") throw Error("Unexpected command");
      expect(result.browserStarted).toBe(true);
      expect(result.catalog.tabs).toHaveLength(1);
      expect(result.catalog.tabs[0]?.site).toBe("https://start.example");
      expect(client.getSnapshot().browserSessions).toHaveLength(before + 1);
      await expect(
        client.openBrowserTab({
          identity: { kind: "profile", profileId: "bpr_99999999-9999-4999-8999-999999999999" },
        }),
      ).rejects.toMatchObject({ reason: "browser-profile-unavailable" });
      await expect(
        client.openBrowserTab({
          identity: { kind: "profile", profileId: task.profileId! },
          placement: rpc.placement,
        }),
      ).rejects.toMatchObject({ reason: "browser-placement-unavailable" });
      await client.closeBrowserTab(result.sessionId, result.tabId, result.catalog);
      await expect(client.openBrowserTab(result.sessionId)).rejects.toMatchObject({
        reason: "browser-session-closed",
      });
    } finally {
      client.dispose();
    }
  });
  it("publishes pending rows before the mock command, keeps refusals and closes a dismissed late tab", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const gate = Promise.withResolvers<void>();
      const dispatch = client.rpc["commands.dispatch"];
      const delayed: typeof dispatch = async (command, options) => {
        if (command.type === "browser.tab.open") {
          expect(client.getSnapshot().pendingBrowserTabs).toMatchObject([
            { idempotencyKey: "mock-pending", state: "opening" },
          ]);
          await withTimeout(gate.promise, 2_000, {
            timeoutError: () => new Error("The delayed browser command was never released."),
          });
        }
        return dispatch(command, options);
      };
      Object.defineProperty(client, "rpc", {
        value: new Proxy(client.rpc, {
          get: (target, name) =>
            name === "commands.dispatch" ? delayed : Reflect.get(target, name),
        }),
      });
      const session = client
        .getSnapshot()
        .browserSessions.find((session) => session.state === "ready")!;
      const close = vi.spyOn(client, "closeBrowserTab");
      const opening = client.beginBrowserTabOpen(session.id, { idempotencyKey: "mock-pending" });
      expect(client.getSnapshot().pendingBrowserTabs).toHaveLength(1);
      client.dismissPendingBrowserTab(opening.idempotencyKey);
      expect(client.getSnapshot().pendingBrowserTabs).toEqual([]);
      gate.resolve();
      const opened = await opening.result;
      expect(close).toHaveBeenCalledWith(opened.sessionId, opened.tabId, expect.anything());
      Object.defineProperty(client, "rpc", {
        value: new Proxy(client.rpc, {
          get: (target, name) =>
            name === "commands.dispatch" ? dispatch : Reflect.get(target, name),
        }),
      });
      await expect(
        client.beginBrowserTabOpen(
          { identity: { kind: "profile", profileId: "bpr_99999999-9999-4999-8999-999999999999" } },
          { idempotencyKey: "refused" },
        ).result,
      ).rejects.toMatchObject({ reason: "browser-profile-unavailable" });
      expect(client.getSnapshot().pendingBrowserTabs).toMatchObject([
        { idempotencyKey: "refused", state: "failed" },
      ]);
    } finally {
      client.dispose();
    }
  });
  it("opens, renews, closes and expires owner views without changing task holdings", async () => {
    let now = new Date("2026-10-19T12:00:00.000Z");
    const client = new MockHostClient({ latencyMs: 0, now: () => now });
    try {
      const approved = await client.listApprovedComputerApps();
      const app = approved.find((item) => item.target.kind === "app")!;
      expect(app.iconPng).toBeNull();
      const before = client
        .getSnapshot()
        .machines.flatMap((machine) => machine.computerUse?.sessions ?? []);
      const view = await client.openComputerView(app.machineId, app.target, {
        idempotencyKey: "open-view",
      });
      expect(
        await client.openComputerView(app.machineId, app.target, { idempotencyKey: "open-view" }),
      ).toEqual(view);
      const logical = placeList(client.getSnapshot()).find(
        (place) => place.ownerView?.viewId === view.viewId,
      )!;
      expect(logical.closable).toBe(true);
      expect(logical.occupants).toEqual([]);
      expect(logical.taskDestination).toBeNull();
      const task = placeList(client.getSnapshot()).find(
        (place) =>
          place.kind === logical.kind &&
          place.device?.machineId === app.machineId &&
          place.taskDestination,
      );
      expect(task?.occupants.length).toBeGreaterThan(0);
      expect(task?.key).not.toBe(logical.key);
      now = new Date(now.getTime() + 1000);
      const renewed = await client.renewComputerView(view.viewId, view.generation, {
        idempotencyKey: "renew-view",
      });
      expect(renewed.expiresAt > view.expiresAt).toBe(true);
      await client.closeComputerView(view.viewId, view.generation, {
        idempotencyKey: "close-view",
      });
      await client.closeComputerView(view.viewId, view.generation, {
        idempotencyKey: "close-view",
      });
      expect(
        client.getSnapshot().machines.flatMap((machine) => machine.computerUse?.sessions ?? []),
      ).toEqual(before);
      await expect(client.renewComputerView(view.viewId, view.generation)).rejects.toMatchObject({
        reason: "computer-view-ended",
      });
      const reopened = await client.openComputerView(app.machineId, app.target);
      expect(reopened.generation).toBeGreaterThan(view.generation);
      await expect(client.renewComputerView(view.viewId, view.generation)).rejects.toMatchObject({
        reason: "computer-view-stale-generation",
      });
      now = new Date(now.getTime() + 10 * 60000);
      await expect(
        client.renewComputerView(reopened.viewId, reopened.generation),
      ).rejects.toMatchObject({ reason: "computer-view-ended" });
      expect(
        placeList(client.getSnapshot()).find((place) => place.ownerView?.viewId === reopened.viewId)
          ?.availability,
      ).toBe("unavailable");
      const phone = approved.find((item) => item.target.kind === "phone")!;
      const phoneView = await client.openComputerView(phone.machineId, phone.target);
      now = new Date(now.getTime() + 3 * 60000);
      await expect(
        client.renewComputerView(phoneView.viewId, phoneView.generation),
      ).rejects.toMatchObject({ reason: "computer-view-ended" });
      const profile = {
        kind: "profile",
        profileId: client.getSnapshot().browserProfiles[0]!.id,
      } as const;
      await client.openBrowserTab({ identity: profile }, { url: "https://recent.example/private" });
      await client.browserHistory.load(profile.profileId);
      expect(client.browserHistory.entries(profile.profileId)).toHaveLength(1);
      await client.rpc["auth.signOut"]({});
      expect(client.browserHistory.entries(profile.profileId)).toEqual([]);
      await expect(client.openComputerView(app.machineId, app.target)).rejects.toMatchObject({
        code: "unauthorized",
      });
    } finally {
      client.dispose();
    }
  });
});

it("renews owner authority only while a visible retain handle exists", async () => {
  vi.useFakeTimers();
  const client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
  try {
    const app = (await client.listApprovedComputerApps()).find((app) => app.target.kind === "app")!;
    const view = await client.openComputerView(app.machineId, app.target);
    const handle = client.retainComputerView(view.viewId, view.generation, { visible: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      client
        .getSnapshot()
        .machines.flatMap((machine) => machine.computerUse?.ownerViews ?? [])
        .find((held) => held.viewId === view.viewId)?.expiresAt,
    ).toBe(view.expiresAt);
    handle.setVisible(true);
    await vi.advanceTimersByTimeAsync(30_000);
    const renewed = client
      .getSnapshot()
      .machines.flatMap((machine) => machine.computerUse?.ownerViews ?? [])
      .find((held) => held.viewId === view.viewId)!;
    expect(renewed.expiresAt > view.expiresAt).toBe(true);
    handle.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      client
        .getSnapshot()
        .machines.flatMap((machine) => machine.computerUse?.ownerViews ?? [])
        .find((held) => held.viewId === view.viewId)?.expiresAt,
    ).toBe(renewed.expiresAt);
  } finally {
    client.dispose();
    vi.useRealTimers();
  }
});
