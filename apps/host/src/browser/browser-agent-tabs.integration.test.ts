import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import {
  BrowserSurfaceIdSchema,
  browserHostMethods,
  type BrowserSessionId,
} from "@opensteer/protocol";
import {
  BrowserAgentTabListResultSchema,
  BrowserAgentTabOpenResultSchema,
  BrowserAgentTabUseResultSchema,
} from "@opensteer/protocol/browser-agent";
import { BrowserTabGroupStore, PersonalTabStore } from "@opensteer/database";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  startPrivateMachineHost,
  stopRun,
} from "../integrations/personal-machine.test-support.js";
import { BrowserTabGroupService } from "./browser-tab-group-service.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";

const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
  cleanups.push(() => database.drop());
  const host = await startPrivateMachineHost(database.url, { remoteAccess: true });
  cleanups.push(() => host.close());
  const caller = await connectCallerMachine(host, {
    name: "Tabs caller",
    token: await host.hostingRunnerEnrollmentToken,
  });
  cleanups.push(() => caller.close());
  const run = await dispatchCallerRun(host, caller, { key: "tabs", title: "Tabs" });
  const runtime = await startBrowserRuntime(
    host.hostPort,
    await enrollmentToken(host, {
      allowedModules: ["browser"],
      idempotencyKey: "browser",
      name: "Tabs computer",
    }),
    {
      agentReady: true,
      personalTabs: true,
      targetedStreaming: true,
      surfaceState: true,
      uniqueTabs: true,
      tabCommands: true,
    },
  );
  cleanups.push(() => runtime.close());
  await vi.waitFor(() => expect(host.runtime.browser.available).toBe(true), { timeout: 2000 });
  const browser = host.runtime.browser;
  const actor = {
    ownerId: host.ownerId,
    agentBindingId: `run:${run.runId}`,
    threadId: run.threadId,
    environmentId: host.ownerEnvironmentId,
  };
  const request = async (path: string, body?: unknown, token = run.toolsToken) =>
    fetch(new URL(`/internal/v1/browser-agent/${path}`, host.origin), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const guest = (operationKey = randomUUID()) =>
    browser.openAgentTab(actor, { identity: { kind: "guest" }, operationKey });
  return { host, caller, run, runtime, browser, actor, request, guest };
}

integration("agent tabs", () => {
  it("reuses Guest within a task, separates tasks, replays opens, and joins a person's live profile browser", async () => {
    const f = await setup();
    const key = randomUUID();
    const first = await f.guest(key);
    expect(await f.guest(key)).toEqual(first);
    const second = await f.guest();
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.tabId).not.toBe(first.tabId);
    const other = await dispatchCallerRun(f.host, f.caller, { key: "other", title: "Other task" });
    const otherGuest = await f.browser.openAgentTab(
      { ...f.actor, agentBindingId: `run:${other.runId}`, threadId: other.threadId },
      { identity: { kind: "guest" }, operationKey: randomUUID() },
    );
    expect(otherGuest.sessionId).not.toBe(first.sessionId);
    const profile = await f.host.store.createBrowserProfile({
      ownerId: f.host.ownerId,
      name: "Work",
      homeRunnerId: f.runtime.runnerId,
      idempotencyKey: randomUUID(),
    });
    const person = await f.browser.openTab(f.host.ownerId, {
      type: "browser.tab.open",
      identity: { kind: "profile", profileId: profile.id },
      idempotencyKey: randomUUID(),
    });
    const before = f.runtime.connectionCount();
    const joined = await f.browser.openAgentTab(f.actor, {
      identity: { kind: "profile", profile: "wOrK" },
      operationKey: randomUUID(),
    });
    expect(joined.sessionId).toBe(person.sessionId);
    expect(f.runtime.connectionCount()).toBe(before);
    expect(
      (await f.host.store.getBrowserSessionForOwner(otherGuest.sessionId, f.host.ownerId))?.opener,
    ).toMatchObject({ kind: "task", threadId: other.threadId });
    expect(
      (await f.host.store.listActiveBrowserSessionsForAgentBinding(f.actor.agentBindingId)).map(
        (r) => r.id,
      ),
    ).toContain(person.sessionId);
    await expect(
      f.browser.openAgentTab(f.actor, {
        identity: { kind: "profile", profile: "Missing" },
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("browser_profile_list") });
    await f.host.store.createBrowserProfile({
      ownerId: f.host.ownerId,
      name: "WORK",
      homeRunnerId: f.runtime.runnerId,
      idempotencyKey: randomUUID(),
    });
    await expect(
      f.browser.openAgentTab(f.actor, {
        identity: { kind: "profile", profile: "Work" },
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("ambiguous") });
    // Guest's computer is chosen only among this person's browser computers.
    await expect(
      f.browser.openAgentTab(f.actor, {
        identity: { kind: "guest", computer: createId("environment") },
        operationKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("does not run a connected browser"),
    });
  });

  it("serializes concurrent opens of one profile through browser startup", async () => {
    const f = await setup();
    const profile = await f.host.store.createBrowserProfile({
      ownerId: f.host.ownerId,
      name: "Research",
      homeRunnerId: f.runtime.runnerId,
      idempotencyKey: randomUUID(),
    });
    const before = f.runtime.connectionCount();
    const tabs = await Promise.all(
      [1, 2, 3].map(() =>
        f.browser.openAgentTab(f.actor, {
          identity: { kind: "profile", profile: profile.id },
          operationKey: randomUUID(),
        }),
      ),
    );
    expect(new Set(tabs.map((tab) => tab.sessionId)).size).toBe(1);
    expect(new Set(tabs.map((tab) => tab.tabId)).size).toBe(3);
    expect(f.runtime.connectionCount() - before).toBe(1);
  });

  it("rechecks a revoked Run after profile preparation before starting a browser", async () => {
    const f = await setup();
    const profile = await f.host.store.createBrowserProfile({
      ownerId: f.host.ownerId,
      name: "Held",
      homeRunnerId: f.runtime.runnerId,
      idempotencyKey: randomUUID(),
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.host.store.getBrowserProfileStorage.bind(f.host.store);
    const held = vi
      .spyOn(f.host.store, "getBrowserProfileStorage")
      .mockImplementation(async (id) => {
        entered.resolve();
        await withTimeout(release.promise, 3000, {
          timeoutError: () => new Error("profile preparation was not released"),
        });
        return original(id);
      });
    const opening = f.browser.openAgentTab(f.actor, {
      identity: { kind: "profile", profile: profile.id },
      operationKey: randomUUID(),
    });
    const result = opening.catch((error: unknown) => error);
    try {
      await withTimeout(entered.promise, 2000, {
        timeoutError: () => new Error("profile preparation never started"),
      });
      await stopRun(f.host, f.run, "revoke-preparing-open");
    } finally {
      release.resolve();
    }
    expect(await result).toBeInstanceOf(Error);
    expect(f.runtime.connectionCount()).toBe(0);
    held.mockRestore();
  });

  it("uses a usable live tab without restore eligibility, wakes asleep tabs, and restores an ended browser", async () => {
    const f = await setup();
    const opened = await f.guest();
    f.runtime.publishTabs(
      {
        surfaces: [
          {
            id: opened.tabId,
            title: "Live application page",
            url: "file:///unrestorable",
            state: "live",
          },
        ],
      },
      opened.sessionId,
    );
    await f.browser.flushPendingTabDescriptors();
    expect(await f.browser.useAgentTab(f.actor, opened.tabId)).toMatchObject({
      ...opened,
      reloaded: false,
    });
    f.runtime.publishTabs(
      {
        surfaces: [
          {
            id: opened.tabId,
            title: "Saved page",
            url: "https://saved.test/path",
            state: "suspended",
          },
        ],
      },
      opened.sessionId,
    );
    await vi.waitFor(
      () => expect(f.browser.tabStateOf(opened.sessionId, opened.tabId)).toBe("suspended"),
      { timeout: 2000 },
    );
    expect(await f.browser.useAgentTab(f.actor, opened.tabId)).toMatchObject({
      ...opened,
      reloaded: true,
    });
    f.runtime.sendServer({ type: "browser.status", state: "closed" }, opened.sessionId);
    await vi.waitFor(
      async () =>
        expect(
          (await f.host.store.getBrowserSessionForOwner(opened.sessionId, f.host.ownerId))?.state,
        ).toBe("closed"),
      { timeout: 2000 },
    );
    const restored = await f.browser.useAgentTab(f.actor, opened.tabId);
    expect(restored.tabId).toBe(opened.tabId);
    expect(restored.sessionId).not.toBe(opened.sessionId);
    expect(restored.reloaded).toBe(true);
  });

  it("lists the person's arrangement with complete URLs, identity, filters, pagination and totals without waking tabs", async () => {
    const f = await setup();
    const opened = await f.guest();
    const a = BrowserSurfaceIdSchema.parse("a".repeat(512)),
      b = BrowserSurfaceIdSchema.parse("catalog-b"),
      c = BrowserSurfaceIdSchema.parse("catalog-c");
    f.runtime.publishTabs(
      {
        surfaces: [
          { id: a, title: "Alpha", url: "https://search.test/a?needle=one#full", state: "live" },
          { id: b, title: "Beta", url: "https://search.test/b?needle=two", state: "suspended" },
          { id: c, title: "Gamma", url: "https://elsewhere.test/c", state: "live" },
        ],
      },
      opened.sessionId,
    );
    await vi.waitFor(() => expect(f.browser.tabStateOf(opened.sessionId, b)).toBe("suspended"), {
      timeout: 2000,
    });
    await f.browser.flushPendingTabDescriptors();
    const groups = new BrowserTabGroupService({
      groups: new BrowserTabGroupStore(f.host.store.database),
      browser: f.browser,
      publish: () => undefined,
    });
    await groups.move(
      { kind: "person", ownerId: f.host.ownerId },
      {
        item: { tabIds: [c] },
        to: { groupId: null, before: { tabId: a } },
        idempotencyKey: randomUUID(),
      },
    );
    const first = BrowserAgentTabListResultSchema.parse(
      await (await f.request("tabs?limit=1")).json(),
    );
    expect(first).toMatchObject({
      total: 3,
      tabs: [{ tabId: c, profile: null, computer: "Tabs computer" }],
      nextCursor: expect.any(String),
    });
    const second = BrowserAgentTabListResultSchema.parse(
      await (await f.request(`tabs?limit=1&cursor=${first.nextCursor}`)).json(),
    );
    expect(second).toMatchObject({
      total: 3,
      tabs: [{ tabId: a, url: "https://search.test/a?needle=one#full" }],
    });
    const filtered = BrowserAgentTabListResultSchema.parse(
      await (await f.request("tabs?query=needle&state=asleep")).json(),
    );
    expect(filtered).toMatchObject({
      total: 1,
      tabs: [{ tabId: b, state: "asleep" }],
      nextCursor: null,
    });
    expect((await f.request(`tabs?state=asleep&cursor=${first.nextCursor}`)).status).toBe(400);
    const profile = await f.host.store.createBrowserProfile({
      ownerId: f.host.ownerId,
      name: "Catalog identity",
      homeRunnerId: f.runtime.runnerId,
      idempotencyKey: randomUUID(),
    });
    const named = await f.browser.openAgentTab(f.actor, {
      identity: { kind: "profile", profile: profile.id },
      operationKey: randomUUID(),
    });
    const byProfile = BrowserAgentTabListResultSchema.parse(
      await (await f.request("tabs?query=Catalog%20identity")).json(),
    );
    expect(byProfile).toMatchObject({
      total: 1,
      tabs: [
        {
          tabId: named.tabId,
          profile: { id: profile.id, name: profile.name },
          usedByThisTask: true,
        },
      ],
    });
    await groups.group(
      { kind: "person", ownerId: f.host.ownerId },
      { tabIds: [a, b], title: "Needle group", idempotencyKey: randomUUID() },
    );
    const byGroup = BrowserAgentTabListResultSchema.parse(
      await (await f.request("tabs?query=Needle%20group")).json(),
    );
    expect(byGroup.total).toBe(2);
    expect(f.browser.tabStateOf(opened.sessionId, b)).toBe("suspended");
  });

  it("refuses driving and mutations at a read-only ceiling, hides another owner's tab and refuses revoked Runs", async () => {
    const f = await setup();
    const opened = await f.guest();
    await f.host.store.database
      .updateTable("runs")
      .set({ accessMode: "approval-required" })
      .where("id", "=", f.run.runId)
      .execute();
    expect((await f.request("tabs")).status).toBe(200);
    for (const [path, body] of [
      ["tabs/use", { tabId: opened.tabId }],
      ["tabs/open", { identity: { kind: "guest" }, operationKey: randomUUID() }],
      ["tabs/close", { tabIds: [opened.tabId], operationKey: randomUUID() }],
      ["tabs/organize", { action: "group", tabIds: [opened.tabId], operationKey: randomUUID() }],
    ] as const) {
      const response = await f.request(path, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining("read-only") },
      });
    }
    await expect(
      f.browser.agentBackend({ ...f.actor, sessionId: opened.sessionId }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.browser.attachCdpForAgent({ ...f.actor, sessionId: opened.sessionId }, () => undefined),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.browser.attachActionsForAgent({ ...f.actor, sessionId: opened.sessionId }, () => undefined),
    ).rejects.toMatchObject({ code: "forbidden" });
    await f.host.store.database
      .updateTable("runs")
      .set({ accessMode: "full-access" })
      .where("id", "=", f.run.runId)
      .execute();
    await expect(
      f.browser.useAgentTab({ ...f.actor, ownerId: createId("user") }, opened.tabId),
    ).rejects.toMatchObject({ code: "forbidden" });
    await stopRun(f.host, f.run, "revoke-tabs");
    expect((await f.request("tabs")).status).toBe(403);
    await expect(f.browser.useAgentTab(f.actor, opened.tabId)).rejects.toThrow();
  });

  it("pins sign-in to the exact surface and refuses a stale session binding", async () => {
    const f = await setup();
    const opened = await f.guest();
    const sibling = await f.guest();
    const target = await f.browser.signInTarget({ ...f.actor, tabId: opened.tabId });
    expect(target).toMatchObject({ sessionId: opened.sessionId, tabId: opened.tabId });
    f.browser.setRequestPins("exact", [
      { sessionId: opened.sessionId, runId: f.run.runId, surfaceId: opened.tabId },
    ]);
    await vi.waitFor(
      () =>
        expect(f.runtime.receivedCommands()).toContainEqual(
          expect.objectContaining({ type: "session.state", pinned: [opened.tabId] }),
        ),
      { timeout: 2000 },
    );
    expect(sibling.sessionId).toBe(opened.sessionId);
    await expect(
      f.browser.signInTarget({
        ...f.actor,
        tabId: opened.tabId,
        sessionId: "bsn_00000000-0000-4000-8000-000000000000" as BrowserSessionId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    f.browser.setRequestPins("exact", []);
    const tabs = new PersonalTabStore(f.host.store.database);
    await tabs.close(f.host.ownerId, opened.tabId);
    await expect(f.browser.signInTarget({ ...f.actor, tabId: opened.tabId })).rejects.toMatchObject(
      { code: "conflict" },
    );
  });

  it("authenticates the routes and returns tab bindings through the Run token", async () => {
    const f = await setup();
    expect((await f.request("tabs", undefined, "bad-token")).status).toBe(401);
    const response = await f.request("tabs/open", {
      identity: { kind: "guest" },
      operationKey: "route-key",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const opened = BrowserAgentTabOpenResultSchema.parse(await response.json());
    const used = await f.request("tabs/use", { tabId: opened.tabId });
    expect(used.status, await used.clone().text()).toBe(200);
    expect(BrowserAgentTabUseResultSchema.parse(await used.json())).toMatchObject({
      ...opened,
      reloaded: false,
    });
    const closed = await f.request("tabs/close", {
      tabIds: [opened.tabId],
      operationKey: "close-key",
    });
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect(await closed.json()).toEqual({ closed: [opened.tabId], failed: [] });
    expect(f.runtime.receivedCommands()).toContainEqual(
      expect.objectContaining({
        type: "cdp.command",
        command: expect.objectContaining({ method: browserHostMethods.closeTab }),
      }),
    );
  });
  it("keeps Browser-off from landing between an agent's admission and its open", async () => {
    const f = await setup();
    await f.guest();
    const order: string[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = f.browser.withRunnerAdmission.bind(f.browser);
    let holding = true;
    const lane = vi
      .spyOn(f.browser, "withRunnerAdmission")
      .mockImplementation((runnerId, action) => {
        if (!holding) return original(runnerId, action);
        holding = false;
        return original(runnerId, async () => {
          entered.resolve();
          await withTimeout(release.promise, 3000, {
            timeoutError: () => new Error("the held admission was not released"),
          });
          const result = await action();
          order.push("agent-sent");
          return result;
        });
      });
    const opening = f.guest();
    await withTimeout(entered.promise, 2000, {
      timeoutError: () => new Error("the open never entered the computer's admission lane"),
    });
    const off = f.browser.withRunnerAdmission(f.runtime.runnerId, async () => {
      order.push("off");
    });
    release.resolve();
    await opening;
    await off;
    lane.mockRestore();
    expect(order).toEqual(["agent-sent", "off"]);
  });

  it("lists an offline computer's tabs instead of failing the whole list", async () => {
    const f = await setup();
    const opened = await f.guest();
    await f.runtime.close();
    // Using the tab is what needs its computer; that refusal shows it went offline.
    await vi.waitFor(
      async () =>
        expect((await f.request("tabs/use", { tabId: opened.tabId })).status).not.toBe(200),
      { timeout: 3000 },
    );
    const response = await f.request("tabs");
    expect(response.status, await response.clone().text()).toBe(200);
    const listed = BrowserAgentTabListResultSchema.parse(await response.json());
    expect(listed.tabs.map((tab) => tab.tabId)).toContain(opened.tabId);
  });
});
