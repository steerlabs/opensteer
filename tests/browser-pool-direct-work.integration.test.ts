import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { standardCdpEndpoint } from "../apps/host/src/browser/standard-cdp-endpoint.test-support.js";
import { AgentSessionService } from "../apps/host/src/agent-sessions/agent-session-service.js";
import { BrowserScriptService } from "../apps/host/src/browser-use/browser-script-service.js";
import {
  BrowserScriptConfinement,
  BrowserToolHandlers,
} from "../apps/host/src/mcp/handlers/browser.js";
import {
  commands,
  connection,
  serveMcp,
} from "../apps/host/src/mcp/connection-caller.test-support.js";
import type { RequestId, ThreadId } from "../packages/core/src/index.js";
import { listBrowserPoolDocumentLosses, type TabRecord } from "../packages/database/src/index.js";
import { TabSleeper } from "../packages/browser-runtime-core/src/browser/tab-sleeper.js";
import { before, holdResume, journey } from "./browser-pool-journey.test-support.js";

type Journey = Awaited<ReturnType<typeof journey>>;
type Home = Awaited<ReturnType<Journey["startHome"]>>;

/**
 * A connected agent's direct browser work on the pooled browser, through the one door and the
 * real script service. The tab list is the Home's own rows; authority stays in the database.
 */
async function directWork(j: Journey, home: () => Home) {
  let tabChange: ((tab: TabRecord) => TabRecord | Promise<TabRecord>) | undefined;
  const refuse = async (): Promise<never> => {
    throw new Error("Unexpected tab operation in this fixture.");
  };
  const ownerId = j.task.userId;
  const row = async (tabId: string) => {
    const tab = await j.tabs.get(ownerId, tabId as TabRecord["id"]);
    if (!tab) throw new Error("No such tab.");
    return tab;
  };
  const scriptTabs = {
    browserScriptPages: async function* () {
      const { rows } = await j.tabs.snapshot(ownerId);
      for (const tab of rows) if (tab.kind === "page") yield tab;
    },
    bindBrowserScript: async (actor: never, tabId: string) =>
      home().service.pageTabs.bindBrowserScript!(actor, await row(tabId)),
    open: refuse,
    get: async (_owner: unknown, tabId: string) => {
      const tab = await row(tabId);
      return { kind: tab.kind, profile: tab.profileId ? { profileId: tab.profileId } : null };
    },
  };
  const sessions = new AgentSessionService({ store: j.store, holdMs: 0 });
  const confinement = new BrowserScriptConfinement();
  const scripts = new BrowserScriptService({
    browser: home().service,
    store: j.store,
    tabs: confinement.tabs(scriptTabs as never),
  } as never);
  // The agent's own page: the Home's page service opens it and its tab row is written, as the
  // tab service does (whose authorization this fixture does not repeat).
  const open = async (actor: never, target: never, key: string) => {
    const write = await home().service.pageTabs.open(actor, target, `fixture:${key}`);
    await j.tabs.open(write, `fixture:${key}`);
    await home().service.pageTabs.admitted?.(write);
    return { tab: { tabId: write.id } };
  };
  /** The tab row a connection reads; a test can make the next reads see a changed tab. */
  const tabRow = async (tabId: string) => {
    const tab = await row(tabId);
    return tabChange ? await tabChange(tab) : tab;
  };
  const handlers = new BrowserToolHandlers({
    sessions,
    tabs: {
      // The owner's own page tabs, as a connection with this grant lists them.
      list: async () => ({
        tabs: (await j.tabs.snapshot(ownerId)).rows
          .filter((tab) => tab.kind === "page")
          .map((tab) => ({ tabId: tab.id })),
      }),
      open,
      connectionTab: async (_actor: never, tabId: string) => tabRow(tabId),
      bindBrowserScript: async (actor: never, tabId: string) =>
        home().service.pageTabs.bindBrowserScript!(actor, await row(tabId)),
    } as never,
    scripts,
    confinement,
    profiles: (owner) => home().service.listProfiles(owner),
    requireDevice: (runnerId) => j.store.requireSelfDeviceId(runnerId),
    issueTicket: (input) => home().service.issueStandardCdpTicket(input),
    pooledBrowser: (runnerId) => home().service.pooledDirectBrowser(runnerId),
    // As the Home wires it: the connection's own read of the tab row.
    pooledTab: async (_actor: never, tabId: string) => tabRow(tabId),
    origin: new URL("https://home.example.test"),
  });
  const url = await serveMcp(j.fixture, { browser: handlers });
  const agent = await connection(j.store, url, {
    userId: ownerId,
    accessMode: "full-access",
    grant: {
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: j.profile!.id }],
    },
  });
  const use = (code: string) =>
    agent.client.callTool({
      name: "browser_use",
      arguments: { profileId: j.profile!.id, code, reason: "Read the draft" },
    });
  const resume = (code: string, operationId: string) =>
    agent.client.callTool({
      name: "browser_use",
      arguments: { profileId: j.profile!.id, code, reason: "Read the draft", operationId },
    });
  const connect = () =>
    agent.client.callTool({
      name: "browser_connect",
      arguments: { profileId: j.profile!.id, reason: "Drive the page" },
    });
  const useTab = (code: string, tabId: string, operationId?: string) =>
    agent.client.callTool({
      name: "browser_use",
      arguments: { tabId, code, reason: "Read the draft", ...(operationId ? { operationId } : {}) },
    });
  const connectTab = (tabId: string) =>
    agent.client.callTool({
      name: "browser_connect",
      arguments: { tabId, reason: "Drive the page" },
    });
  /** From now on, reads of a tab see it changed by `change`; undefined restores them. */
  const changeTabs = (change: ((tab: TabRecord) => TabRecord | Promise<TabRecord>) | undefined) => {
    tabChange = change;
  };
  return { sessions, scripts, agent, use, resume, connect, useTab, connectTab, changeTabs };
}

const text = (result: Awaited<ReturnType<Awaited<ReturnType<typeof directWork>>["use"]>>) =>
  JSON.stringify(result.content);

it("makes a tab a pooled browser_use script binds the agent's at the bind, before any input (V5)", async () => {
  // The runtime's sleeper hears every session state the Home sends (TS12's agentTabs).
  const states: { sessionId: string; agentTabs: readonly string[] }[] = [];
  const setSessionState = TabSleeper.prototype.setSessionState;
  const spy = vi.spyOn(TabSleeper.prototype, "setSessionState").mockImplementation(function (
    this: TabSleeper,
    id,
    state,
  ) {
    states.push({ sessionId: id, agentTabs: state.agentTabs ?? [] });
    return setSessionState.call(this, id, state);
  });
  const j = await journey("direct-script-bound", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    await j.draft();
    const work = await directWork(j, () => home);
    // A read only: no input, no action; the bind alone makes the tab the agent's.
    const read = await work.use(
      `const page = await openPage(${JSON.stringify(tab.id)}); return await page.js("document.title")`,
    );
    expect(read.isError, text(read)).not.toBe(true);
    await vi.waitFor(() =>
      expect(
        states.some((state) => state.sessionId === session.id && state.agentTabs.includes(tab.id)),
      ).toBe(true),
    );
  } finally {
    spy.mockRestore();
    await j.close();
  }
});

it("runs a connected agent's script on a parked browser after one wake, and rebinds its cached page only with its witnesses", async () => {
  const j = await journey("direct-script", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    const page = await j.draft();
    const work = await directWork(j, () => home);
    const read = `return await page.js("document.querySelector('input').value")`;
    const first = await work.use(
      `globalThis.page = await openPage(${JSON.stringify(tab.id)}); ${read}`,
    );
    expect(first.isError, text(first)).not.toBe(true);
    expect(text(first)).toContain("unsent draft");
    // The script's state update is a protection fact: it is delivered before a park.
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    // The call arrives while parked: it waits for one wake before anything is handed off.
    const resume = holdResume(j.controller);
    const parkedCall = work.use(read);
    await before(resume.seen, parkedCall, "The parked script");
    const waiting = await j.database
      .selectFrom("agentOperations")
      .select(["state", "handedOffAt"])
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
    expect(waiting).toMatchObject({ handedOffAt: null });
    resume.allow();
    const second = await parkedCall;
    expect(second.isError, text(second)).not.toBe(true);
    expect(text(second)).toContain("unsent draft");
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    expect(await j.slot()).toMatchObject({ phase: "running", epoch: 2 });
    expect(await page.value()).toBe('["unsent draft",99]');
    // The page moves to another document while awake; the cached handle's witness no longer
    // matches after the next park, so it is not rebound.
    await page.cdp.send("Runtime.evaluate", { expression: "location.hash = '#moved'" });
    const previous = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
    await page.cdp.send("Page.navigate", { url: "about:blank" });
    // A navigation in progress vetoes a park: wait until the new document is committed.
    await vi.waitFor(() =>
      expect(home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId).not.toBe(
        previous,
      ),
    );
    await vi.waitFor(async () => {
      const state = await page.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      expect(state.result.value).toBe("complete");
      expect(home.coordinator.gate.held).toBe(0);
    });
    expect(await home.coordinator.tryPark()).toBe("parked");
    const third = await work.use(read);
    // Its witness names the old document: it is not rebound, and nothing reaches the page.
    expect(third.structuredContent).toMatchObject({
      error: { message: "The browser page attachment has ended.", performed: [] },
    });
    // Handed off, then the Home's own witness refused the script's page before any command left:
    // the script's failure, with nothing performed, and never unknown, since nothing left.
    expect(
      await j.database
        .selectFrom("agentOperations")
        .select(["state", "outcome", "handedOffAt"])
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "failed", outcome: "failed", handedOffAt: expect.any(Date) });
    expect(j.controller.effects).toEqual(["start", "pause", "resume", "pause", "resume"]);
  } finally {
    await j.close();
  }
});

/** A connected agent's unanswered command on a saved profile's page, then the Runner's channel drops. */
async function unansweredAtChannelLoss(key: string, channelDeadlineMs: number) {
  const j = await journey(key, { profile: true, channelDeadlineMs });
  const home = await j.startHome();
  const { session } = await home.service.start({
    ownerId: j.task.userId,
    profileId: j.profile!.id,
  });
  const [tab] = await home.service.savedPages(j.task.userId, session.id);
  if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
  const page = await j.draft();
  const work = await directWork(j, () => home);
  const read = `return await page.js("document.querySelector('input').value")`;
  const bound = await work.use(`globalThis.page = await openPage(${JSON.stringify(tab.id)});`);
  expect(bound.isError, text(bound)).not.toBe(true);
  const sent = async () =>
    (
      await page.cdp.send<{ result: { value?: number } }>("Runtime.evaluate", {
        expression: "window.__sent ?? 0",
        returnByValue: true,
      })
    ).result.value;
  const document = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
  // The page receives the command and never answers it.
  const hanging = work.use(
    `return await page.js("(window.__sent = (window.__sent ?? 0) + 1, new Promise(() => {}))")`,
  );
  await vi.waitFor(async () => expect(await sent()).toBe(1));
  j.runnerDown();
  // The agent hears that the Home lost track of it, never that it failed.
  const result = await hanging;
  expect(result.structuredContent, text(result)).toMatchObject({ status: "unknown" });
  const operations = () =>
    j.database
      .selectFrom("agentOperations")
      .select(["state", "outcome"])
      .orderBy("createdAt", "asc")
      .execute();
  const settled = [
    { state: "completed", outcome: "completed" },
    { state: "unknown", outcome: "unknown" },
  ];
  expect(await operations()).toEqual(settled);
  return { j, home, session, tab, page, work, read, sent, document, operations, settled };
}

it("keeps a session whose unanswered command was settled unknown when the Runner's channel dropped, and the Runner came back in time", async () => {
  const w = await unansweredAtChannelLoss("direct-unknown", 20_000);
  try {
    // The Runner comes back inside the window: the same page is reattached and usable, and the
    // command is never sent again.
    w.j.runnerUp();
    await vi.waitFor(() => expect(w.home.coordinator.gate.phase).toBe("open"), {
      timeout: 10_000,
    });
    expect((await w.j.row(w.session.id))?.state).toBe("ready");
    expect(w.home.service.pageInventory(w.session.id)?.records.get(w.tab.id)?.documentId).toBe(
      w.document,
    );
    const again = await w.work.use(w.read);
    expect(again.isError, text(again)).not.toBe(true);
    expect(text(again)).toContain("unsent draft");
    expect(await w.sent()).toBe(1);
    expect((await w.operations()).slice(0, 2)).toEqual(w.settled);
  } finally {
    await w.j.close();
  }
});

it("lets a tab-targeted call made while the Runner's channel reconnects wait for it, never refuse it as not found", async () => {
  const w = await unansweredAtChannelLoss("direct-tab-reconnecting", 20_000);
  try {
    await vi.waitFor(() => expect(w.home.coordinator.gate.phase).toBe("reconnecting"));
    // The broker is gone with its channel: the page's document stands from when it was lost.
    expect(w.home.service.pageInventory(w.session.id)).toBeUndefined();
    let settled = false;
    const call = w.work.useTab(w.read, w.tab.id).finally(() => {
      settled = true;
    });
    // The call passed its witness and waits on admission for the browser to come back.
    await vi.waitFor(() => expect(w.home.coordinator.gate.demand).toBe(true));
    expect(settled).toBe(false);
    expect(w.home.coordinator.gate.phase).toBe("reconnecting");
    w.j.runnerUp();
    const result = await call;
    expect(result.isError, text(result)).not.toBe(true);
    expect(text(result)).toContain("unsent draft");
    expect(w.home.service.pageInventory(w.session.id)?.records.get(w.tab.id)?.documentId).toBe(
      w.document,
    );
    // The unanswered command is never sent again.
    expect(await w.sent()).toBe(1);
  } finally {
    w.j.runnerUp();
    await w.j.close();
  }
});

it("lets a tab-targeted call made while a crashed Home reattaches its sessions wait for them, never refuse it as not found", async () => {
  const j = await journey("direct-tab-crash", { profile: true, channelDeadlineMs: 20_000 });
  try {
    let home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    await j.draft();
    const document = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
    // The Home dies while its Runner is away: the new Home has its tab rows, a session with no
    // channel, and no document it knows for the page.
    j.runnerDown();
    home = await j.crashHome(home);
    await vi.waitFor(() => expect(home.coordinator.gate.phase).toBe("reconnecting"), {
      timeout: 10_000,
    });
    expect(home.service.pageInventory(session.id)).toBeUndefined();
    const work = await directWork(j, () => home);
    let settled = false;
    const call = work
      .useTab(
        `const page = await openPage(${JSON.stringify(tab.id)});
         return await page.js("document.querySelector('input').value")`,
        tab.id,
      )
      .finally(() => {
        settled = true;
      });
    // The call passed the checks it can make now and waits on admission for the reattach.
    await vi.waitFor(() => expect(home.coordinator.gate.demand).toBe(true));
    expect(settled).toBe(false);
    j.runnerUp();
    const result = await call;
    expect(result.isError, text(result)).not.toBe(true);
    expect(text(result)).toContain("unsent draft");
    expect(home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId).toBe(document);
    expect((await j.row(session.id))?.state).toBe("ready");
  } finally {
    j.runnerUp();
    await j.close();
  }
});

it("ends a session whose unanswered command was settled unknown with its note when the Runner does not come back", async () => {
  const w = await unansweredAtChannelLoss("direct-unknown-gone", 1_500);
  try {
    await vi.waitFor(() => expect(w.home.coordinator.gate.phase).toBe("open"), {
      timeout: 10_000,
    });
    expect((await w.j.row(w.session.id))?.state).toBe("failed");
    expect(
      await listBrowserPoolDocumentLosses(w.j.database, w.j.task.userId, w.tab.id),
    ).toMatchObject([{ sessionId: w.session.id, surfaceId: w.tab.id, reason: "not-adopted" }]);
    await vi.waitFor(() => expect(w.page.page.isClosed()).toBe(true), { timeout: 10_000 });
    expect(await w.operations()).toEqual(w.settled);
  } finally {
    w.j.runnerUp();
    await w.j.close();
  }
});

it("restarts only once a command in flight has its recorded outcome, and once per idempotency key", async () => {
  const j = await journey("direct-restart", { profile: true });
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    const page = await j.draft();
    const work = await directWork(j, () => home);
    const bound = await work.use(`globalThis.page = await openPage(${JSON.stringify(tab.id)});`);
    expect(bound.isError, text(bound)).not.toBe(true);
    const hanging = work.use(`return await page.js("(window.__sent = 1, new Promise(() => {}))")`);
    await vi.waitFor(async () => {
      const sent = await page.cdp.send<{ result: { value?: number } }>("Runtime.evaluate", {
        expression: "window.__sent ?? 0",
        returnByValue: true,
      });
      expect(sent.result.value).toBe(1);
    });
    const latest = () =>
      j.database
        .selectFrom("agentOperations")
        .select(["state", "outcome"])
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow();
    expect(await latest()).toMatchObject({ state: "handed-off" });
    // When the controller is asked to stop the guest, the command already has its outcome.
    let atStop: unknown;
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    j.controller.hold("stop", async () => {
      atStop = await latest();
      reached.resolve();
      await release.promise;
    });
    const asked = vi.spyOn(home.coordinator, "restart");
    const restarting = home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "key-1");
    await reached.promise;
    // A second restart asked while one runs joins it.
    const joined = home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "key-2");
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2));
    release.resolve();
    await Promise.all([restarting, joined]);
    expect(atStop).toEqual({ state: "unknown", outcome: "unknown" });
    expect((await hanging).structuredContent).toMatchObject({ status: "unknown" });
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
    expect((await j.row(session.id))?.state).toBe("failed");
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tab.id)).toMatchObject([
      { sessionId: session.id, reason: "person" },
    ]);
    // A retry after a lost response, with the same key: the first outcome, nothing discarded.
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "key-1");
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
    expect(home.coordinator.gate.phase).toBe("open");
    // The joined restart's own retry: its key was recorded with the same start.
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "key-2");
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
    // A later cold start that was not a restart (the saved state expired while parked) keeps
    // both keys handled.
    expect(await home.coordinator.tryPark()).toBe("parked");
    j.controller.observe({ phase: "stopped", savedState: null, epoch: null });
    (await home.coordinator.gate.reserve(AbortSignal.timeout(10_000))).release();
    expect(j.controller.effects).toEqual(["start", "stop", "start", "pause", "start"]);
    expect(await j.slot()).toMatchObject({
      lastStart: { reason: expect.not.stringMatching(/^person$/) },
    });
    for (const key of ["key-1", "key-2"])
      await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, key);
    expect(j.controller.effects).toEqual(["start", "stop", "start", "pause", "start"]);
    expect(home.coordinator.gate.phase).toBe("open");
  } finally {
    await j.close();
  }
});

/** A connected agent that already used the profile, with the browser parked afterwards. */
async function parkedAfterWork(key: string) {
  const j = await journey(key, { profile: true });
  const home = await j.startHome();
  const { session } = await home.service.start({
    ownerId: j.task.userId,
    profileId: j.profile!.id,
  });
  const [tab] = await home.service.savedPages(j.task.userId, session.id);
  if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
  const page = await j.draft();
  const work = await directWork(j, () => home);
  const read = `return await page.js("document.querySelector('input').value")`;
  const first = await work.use(
    `globalThis.page = await openPage(${JSON.stringify(tab.id)}); ${read}`,
  );
  expect(first.isError, text(first)).not.toBe(true);
  const taskId = (first.structuredContent as { taskId: ThreadId }).taskId;
  await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
  expect(await home.coordinator.tryPark()).toBe("parked");
  const connection = commands(j.fixture, j.task.userId, {
    afterStop: (id, reason) => work.sessions.closeConnection(id, reason === "disconnect"),
  });
  return { j, home, session, tab, page, work, read, taskId, connection };
}

const parkedEffects = ["start", "pause"];

it("honours a Disconnect that arrives while the browser is parked, with its end shown and no wake", async () => {
  const p = await parkedAfterWork("parked-disconnect");
  try {
    await p.connection.revoke(p.work.agent.id);
    await p.j.store.driveConnectionCleanups();
    // A validly parked browser has no outstanding attempt: Disconnect shows its end at once.
    const [row] = (await p.connection.list()).filter(({ id }) => id === p.work.agent.id);
    expect(row).toMatchObject({ state: "stopped" });
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
    const after = await p.work.use(p.read).catch((error: unknown) => error);
    expect(after).toBeInstanceOf(Error);
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.page.value()).toBe('["unsent draft",99]');
  } finally {
    await p.j.close();
  }
});

it("honours a grant cut that arrives while the browser is parked, refusing before any wake", async () => {
  const p = await parkedAfterWork("parked-grant");
  try {
    await p.connection.update(p.work.agent.id, {
      grant: { scope: "selected", tasks: false, resources: [] },
    });
    // A connection names only what it holds: with no browser profile left, the tool is gone.
    await expect(p.work.use(p.read)).rejects.toThrow("Method not found");
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
  } finally {
    await p.j.close();
  }
});

it("honours a mode cut that arrives while the browser is parked: the call waits for the person, not for a wake", async () => {
  const p = await parkedAfterWork("parked-mode");
  try {
    await p.j.store.updateThreadAccessMode({
      threadId: p.taskId,
      requestedBy: p.j.task.userId,
      accessMode: "approval-required",
    });
    await p.work.sessions.lowerTaskMode(p.taskId, "approval-required");
    const after = await p.work.use(p.read);
    expect(after.structuredContent).toMatchObject({ status: "pending" });
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
  } finally {
    await p.j.close();
  }
});

it("never wakes a parked browser for an approved call whose grant was cut before its hand-off", async () => {
  const p = await parkedAfterWork("parked-grant-after-approval");
  try {
    const ownerId = p.j.task.userId;
    await p.j.store.updateThreadAccessMode({
      threadId: p.taskId,
      requestedBy: ownerId,
      accessMode: "approval-required",
    });
    await p.work.sessions.lowerTaskMode(p.taskId, "approval-required");
    const pending = (await p.work.use(p.read)).structuredContent as {
      status: string;
      requestId: RequestId;
      operationId: string;
    };
    expect(pending.status).toBe("pending");
    await p.work.sessions.respond({
      requestId: pending.requestId,
      expectedRevision: (await p.j.store.requests.revision(pending.requestId))!,
      resolvedBy: ownerId,
      response: { kind: "form", answers: { decision: ["allow"] } },
    });
    // Between the person's approval and the hand-off, the grant is cut: the profile goes, a
    // second one keeps the tool listed.
    {
      const other = await p.j.store.createBrowserProfile({
        name: "Other",
        ownerId,
        homeRunnerId: p.j.task.runnerId,
        idempotencyKey: "other-profile",
      });
      await p.connection.update(p.work.agent.id, {
        grant: {
          scope: "selected",
          tasks: false,
          resources: [{ kind: "browser-profile", profileId: other.id }],
        },
      });
    }
    const resumed = await p.work.resume(p.read, pending.operationId);
    expect(text(resumed)).not.toContain("unsent draft");
    // Refused before anything could wake the browser.
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
    const operation = await p.j.database
      .selectFrom("agentOperations")
      .select(["state", "handedOffAt"])
      .where("id", "=", pending.operationId as never)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({ state: "refused", handedOffAt: null });
  } finally {
    await p.j.close();
  }
});

it("never wakes a parked browser for a tab-targeted call whose tab changed before its hand-off", async () => {
  const p = await parkedAfterWork("parked-tab-changed");
  try {
    // The call's own target and witness read the tab as it was; from the next read on, the tab
    // has changed (another generation), as if the person rebound it in that interval.
    let reads = 0;
    p.work.changeTabs((tab) => (++reads > 2 ? { ...tab, generation: tab.generation + 1 } : tab));
    const result = await p.work.useTab(p.read, p.tab.id);
    expect(reads).toBe(3);
    expect(text(result)).not.toContain("unsent draft");
    // Refused before anything could wake the browser, and recorded so.
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
    expect(
      await p.j.database
        .selectFrom("agentOperations")
        .select(["state", "handedOffAt"])
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "refused", handedOffAt: null });
  } finally {
    p.work.changeTabs(undefined);
    await p.j.close();
  }
});

it("records refused a tab-targeted call the Home refused after its hand-off, before any command", async () => {
  const p = await parkedAfterWork("handed-off-refused");
  try {
    // Every check up to the hand-off reads the tab as it was; the execute's own check after it
    // sees the tab changed, so nothing is sent.
    p.work.changeTabs(async (tab) => {
      const latest = await p.j.database
        .selectFrom("agentOperations")
        .select("handedOffAt")
        .where("tool", "=", "browser_connect")
        .executeTakeFirst();
      return latest?.handedOffAt ? { ...tab, generation: tab.generation + 1 } : tab;
    });
    const result = await p.work.connectTab(p.tab.id);
    expect(text(result)).toContain("not_found");
    expect(
      await p.j.database
        .selectFrom("agentOperations")
        .select(["state", "outcome", "handedOffAt"])
        .where("tool", "=", "browser_connect")
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "refused", outcome: "refused", handedOffAt: expect.any(Date) });
  } finally {
    p.work.changeTabs(undefined);
    await p.j.close();
  }
});

it("honours a Stop of the agent's task that arrives while the browser is parked, without a wake", async () => {
  const p = await parkedAfterWork("parked-stop");
  try {
    const operation = await p.j.database
      .selectFrom("agentOperations")
      .select("sessionId")
      .orderBy("createdAt", "desc")
      .executeTakeFirstOrThrow();
    await p.work.sessions.stopSession({
      ownerUserId: p.j.task.userId,
      sessionId: operation.sessionId,
      threadId: p.taskId,
    });
    const after = await p.work.use(p.read);
    expect(after.isError).toBe(true);
    expect(text(after)).toContain("stopped");
    expect(p.j.controller.effects).toEqual(parkedEffects);
    expect(await p.j.slot()).toMatchObject({ phase: "parked" });
  } finally {
    await p.j.close();
  }
});

it("restarts at once with an unredeemed connection ticket, which no longer attaches", async () => {
  const j = await journey("restart-ticket", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    await j.draft();
    const work = await directWork(j, () => home);
    endpoint = await standardCdpEndpoint(() => home.service);
    const issued = await work.connect();
    expect(issued.isError, text(issued)).not.toBe(true);
    const { endpoint: url } = issued.structuredContent as { endpoint: string };
    // The ticket holds the gate until it is redeemed or ends: the restart revokes it first.
    expect(home.coordinator.gate.held).toBeGreaterThan(0);
    const asked = Date.now();
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "with-ticket");
    expect(Date.now() - asked).toBeLessThan(15_000);
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
    await expect(endpoint.open(url)).rejects.toThrow();
  } finally {
    await endpoint?.close();
    await j.close();
  }
});

it("redeems no connection ticket and passes no frame while a restart holds admission", async () => {
  const j = await journey("ticket-held", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    await j.draft();
    const work = await directWork(j, () => home);
    endpoint = await standardCdpEndpoint(() => home.service);
    const endpointOf = async () => {
      const issued = await work.connect();
      expect(issued.isError, text(issued)).not.toBe(true);
      return (issued.structuredContent as { endpoint: string }).endpoint;
    };
    // A refusal comes back as the command's CDP error, or as a closed connection.
    const refused = (sent: Promise<unknown>) =>
      sent.then(
        (reply) => (reply as { error?: { message?: string } }).error?.message ?? "answered",
        () => "closed",
      );
    // The restart's hold is set before its turn quiesces anything: the interval the loop has
    // not reached yet. A ticket redeemed then attaches nothing (the handshake may complete).
    const unredeemed = await endpointOf();
    home.coordinator.gate.set({ hold: "restart" });
    const late = await endpoint.open(unredeemed).catch(() => undefined);
    if (late)
      expect(await refused(late.send("Target.getTargets"))).toBe(
        "This browser is restarting. Request a new attachment.",
      );
    home.coordinator.gate.set({ hold: null });
    // A connection already attached passes no frame once the hold is set.
    const attached = await endpoint.open(await endpointOf());
    expect(await refused(attached.send("Target.getTargets"))).toBe("answered");
    home.coordinator.gate.set({ hold: "restart" });
    expect(await refused(attached.send("Target.getTargets"))).not.toBe("answered");
    expect(j.controller.effects).toEqual(["start"]);
  } finally {
    await endpoint?.close();
    await j.close();
  }
});

it("issues browser_connect for a parked browser after access checks and one wake, attaches for real, and refuses a frame for another document", async () => {
  const j = await journey("direct-connect", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    await home.service.start({ ownerId: j.task.userId, profileId: j.profile!.id });
    await j.draft();
    const work = await directWork(j, () => home);
    endpoint = await standardCdpEndpoint(() => home.service);
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    // Access is checked from Home data first: a profile outside the grant wakes nothing.
    const outside = await work.agent.client.callTool({
      name: "browser_connect",
      arguments: { profileId: "bpr_00000000-0000-4000-8000-000000000000", reason: "x" },
    });
    expect(outside.isError).toBe(true);
    expect(j.controller.effects).toEqual(["start", "pause"]);
    // One wake, then the ticket.
    const resume = holdResume(j.controller);
    const calling = work.connect();
    await before(resume.seen, calling, "The ticket");
    resume.allow();
    const issued = await calling;
    expect(issued.isError, text(issued)).not.toBe(true);
    const { endpoint: url } = issued.structuredContent as { endpoint: string };
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    // An outstanding ticket holds the gate: no park, so there is no wake after issue.
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    const cdp = await endpoint.open(url);
    const targets = (await cdp.send("Target.getTargets")) as {
      result: { targetInfos: { targetId: string; type: string }[] };
    };
    const page = targets.result.targetInfos.find(({ type }) => type === "page");
    expect(page).toBeDefined();
    const attached = (await cdp.send("Target.attachToTarget", {
      targetId: page!.targetId,
      flatten: true,
    })) as { result: { sessionId: string } };
    const evaluated = (await cdp.send(
      "Runtime.evaluate",
      { expression: "1 + 1", returnByValue: true },
      attached.result.sessionId,
    )) as { result: { result: { value: number } } };
    expect(evaluated.result.result.value).toBe(2);
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    // The agent's page reloads into a new document: the next frame is refused and the socket
    // closes. (The runtime refuses a data: navigation, so a reload makes the new document.)
    for (const target of targets.result.targetInfos.filter(({ type }) => type === "page")) {
      const session = (await cdp.send("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      })) as { result: { sessionId: string } };
      await cdp.send("Page.reload", {}, session.result.sessionId);
    }
    await vi.waitFor(async () => {
      await expect(
        cdp.send("Runtime.evaluate", { expression: "2" }, attached.result.sessionId),
      ).rejects.toThrow("closed");
    });
    // Every exit releases the hold: the browser can park again.
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
  } finally {
    await endpoint?.close();
    await j.close();
  }
});

it("keeps a connected agent's paste, copy and cut off the browser's clipboard in its own page, through browser_use and browser_connect", async () => {
  const sentence =
    "The clipboard is not available to a connected agent. Use Input.insertText to enter text.";
  const permissionSentence = "Browser permissions cannot be changed by a connected agent.";
  const sentinel = `opensteer-clipboard-sentinel-${randomUUID()}`;
  /** What a script returned, encoded so that no transcript escaping can change it. */
  const outcomeOf = (result: Parameters<typeof text>[0]): unknown =>
    JSON.parse(decodeURIComponent(/outcome:([^:"\\]*):end/u.exec(text(result))![1]!));
  // A secure origin, so that the page's own clipboard API exists in the agent's page.
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Form</title><input id=field>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const form = `http://127.0.0.1:${(site.address() as AddressInfo).port}/form`;
  const j = await journey("direct-clipboard", { profile: true });
  let endpoint: Awaited<ReturnType<typeof standardCdpEndpoint>> | undefined;
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    // The agent's own page loads the form before the agent binds it: a pooled script is bound to
    // one document.
    const own = await j.launched()!.context.pages().at(-1)!.cdp();
    const previous = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
    await own.send("Page.navigate", { url: form });
    await vi.waitFor(async () => {
      expect(home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId).not.toBe(
        previous,
      );
      const state = await own.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      expect(state.result.value).toBe("complete");
    });
    // A page in the same browser that the connection does not hold: the sentinel is copied there
    // with the browser's own copy command, outside any agent's CDP.
    const other = await j.launched()!.context.createPage();
    const person = await other.cdp();
    const key = (commands: string[], code: string) =>
      ["rawKeyDown", "keyUp"].map((type) =>
        person.send("Input.dispatchKeyEvent", {
          type,
          modifiers: 4,
          key: code.slice(3).toLowerCase(),
          code,
          ...(type === "keyUp" ? {} : { commands }),
        }),
      );
    const value = async (id: string) =>
      (
        await person.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: `document.getElementById(${JSON.stringify(id)}).value`,
          returnByValue: true,
        })
      ).result.value;
    const focus = (id: string) =>
      person.send("Runtime.evaluate", {
        expression: `(document.getElementById(${JSON.stringify(id)}).focus(), document.getElementById(${JSON.stringify(id)}).select())`,
      });
    await person.send("Runtime.evaluate", {
      expression: `document.body.innerHTML = '<input id="secret" value=${JSON.stringify(sentinel)}><input id="probe"><input id="after">'`,
    });
    await focus("secret");
    await Promise.all(key(["copy"], "KeyC"));
    /** What the browser's clipboard holds, read by pasting into a field of the person's page. */
    const clipboard = async (id: string) => {
      await focus(id);
      await Promise.all(key(["paste"], "KeyV"));
      return value(id);
    };
    expect(await clipboard("probe")).toBe(sentinel);

    const work = await directWork(j, () => home);
    const pasted = await work.use(`
      const page = await openPage(${JSON.stringify(tab.id)});
      await page.js("document.getElementById('field').focus(); location.origin");
      const refused = [];
      const attempt = async (name, run) => {
        try { await run(); refused.push([name, "performed"]); }
        catch (error) { refused.push([name, String(error && error.message)]); }
      };
      await attempt("Meta+V", () => page.keyboard.press("Meta+V"));
      await attempt("Control+V", () => page.keyboard.press("Control+V"));
      await attempt("Shift+Insert", () => page.keyboard.press("Shift+Insert"));
      await attempt("stated", () => page.pressKey("v", { modifiers: 4, commands: ["paste"] }));
      await attempt("pasteAndMatchStyle", () => page.pressKey("v", { modifiers: 12, commands: ["pasteAndMatchStyle"] }));
      for (const permission of ["clipboardReadWrite", "audioCapture", "videoCapture", "geolocation"])
        await attempt(permission, () => page.cdp("Browser.grantPermissions", { permissions: [permission] }));
      await attempt("setPermission", () => page.cdp("Browser.setPermission", { permission: { name: "camera" }, setting: "granted" }));
      await attempt("resetPermissions", () => page.cdp("Browser.resetPermissions", {}));
      const read = await page.cdp("Runtime.evaluate", {
        expression: "navigator.clipboard.readText().then(t => 'read:' + t, e => 'denied:' + e.name)",
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      });
      const execPaste = await page.js("document.execCommand('paste')");
      return "outcome:" + encodeURIComponent(JSON.stringify({
        refused,
        read: read.result.value,
        execPaste,
        value: await page.js("document.getElementById('field').value"),
        html: await page.js("document.documentElement.outerHTML"),
      })) + ":end";
    `);
    expect(pasted.isError, text(pasted)).not.toBe(true);
    const outcome = outcomeOf(pasted) as {
      refused: [string, string][];
      read: string;
      execPaste: boolean;
      value: string;
      html: string;
    };
    const { html: _html, ...seen } = outcome;
    expect(outcome.refused, JSON.stringify(seen)).toEqual([
      ...["Meta+V", "Control+V", "Shift+Insert", "stated", "pasteAndMatchStyle"].map((name) => [
        name,
        expect.stringContaining(sentence),
      ]),
      ...[
        "clipboardReadWrite",
        "audioCapture",
        "videoCapture",
        "geolocation",
        "setPermission",
        "resetPermissions",
      ].map((name) => [name, expect.stringContaining(permissionSentence)]),
    ]);
    expect(outcome.read).toMatch(/^denied:/u);
    expect(outcome.execPaste).toBe(false);
    expect(outcome.value).toBe("");
    expect(text(pasted)).not.toContain(sentinel);

    // The reverse: the agent's copy and cut leave the clipboard holding what it held.
    const copied = await work.use(`
      const page = await openPage(${JSON.stringify(tab.id)});
      await page.js("const field = document.getElementById('field'); field.value = 'agent-text'; field.focus(); field.select(); true");
      const refused = [];
      for (const chord of ["Meta+C", "Meta+X", "Control+C", "Control+X", "Control+Insert", "Shift+Delete"]) {
        try { await page.keyboard.press(chord); refused.push(chord + ": performed"); }
        catch (error) { refused.push(chord + ": " + String(error && error.message)); }
      }
      return "outcome:" + encodeURIComponent(JSON.stringify({
        refused,
        value: await page.js("document.getElementById('field').value"),
      })) + ":end";
    `);
    expect(copied.isError, text(copied)).not.toBe(true);
    const copy = outcomeOf(copied) as { refused: string[]; value: string };
    expect(copy.refused).toEqual(
      ["Meta+C", "Meta+X", "Control+C", "Control+X", "Control+Insert", "Shift+Delete"].map(
        (chord) =>
          expect.stringMatching(new RegExp(`^${chord.replace("+", "\\+")}: .*${sentence}`, "u")),
      ),
    );
    // Cut left the agent's text where it was.
    expect(copy.value).toBe("agent-text");
    expect(await clipboard("after")).toBe(sentinel);

    // The same through a standard CDP connection, before anything reaches the page.
    endpoint = await standardCdpEndpoint(() => home.service);
    const issued = await work.connect();
    expect(issued.isError, text(issued)).not.toBe(true);
    const { endpoint: url } = issued.structuredContent as { endpoint: string };
    const cdp = await endpoint.open(url);
    const targets = (await cdp.send("Target.getTargets")) as {
      result: { targetInfos: { targetId: string; type: string }[] };
    };
    const page = targets.result.targetInfos.find(({ type }) => type === "page")!;
    const attached = (await cdp.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })) as { result: { sessionId: string } };
    const pageSession = attached.result.sessionId;
    await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          "document.body.innerHTML = '<input id=field>'; document.getElementById('field').focus()",
      },
      pageSession,
    );
    const cmdV = {
      type: "rawKeyDown",
      modifiers: 4,
      key: "v",
      code: "KeyV",
      windowsVirtualKeyCode: 86,
    };
    for (const [method, params, scope] of [
      ["Input.dispatchKeyEvent", cmdV, pageSession],
      ["Input.dispatchKeyEvent", { ...cmdV, commands: ["paste"] }, pageSession],
      ["Input.dispatchKeyEvent", { ...cmdV, modifiers: 2 }, pageSession],
      [
        "Input.dispatchKeyEvent",
        { ...cmdV, key: "c", code: "KeyC", windowsVirtualKeyCode: 67 },
        pageSession,
      ],
    ] as const)
      expect(await cdp.send(method, params, scope), method).toMatchObject({
        error: { message: sentence },
      });
    // No permission changes at all, on the root or on its page.
    for (const scope of [undefined, pageSession])
      for (const [method, params] of [
        ["Browser.grantPermissions", { permissions: ["clipboardReadWrite"] }],
        ["Browser.grantPermissions", { permissions: ["audioCapture"] }],
        ["Browser.grantPermissions", { permissions: ["videoCapture"] }],
        ["Browser.grantPermissions", { permissions: ["geolocation"] }],
        ["Browser.setPermission", { permission: { name: "clipboard-read" }, setting: "granted" }],
        ["Browser.resetPermissions", {}],
      ] as const)
        expect(await cdp.send(method, params, scope), `${method} ${String(scope)}`).toMatchObject({
          error: { message: permissionSentence },
        });
    const field = (await cdp.send(
      "Runtime.evaluate",
      {
        expression: "[document.getElementById('field').value, document.documentElement.outerHTML]",
        returnByValue: true,
      },
      pageSession,
    )) as { result: { result: { value: [string, string] } } };
    expect(field.result.result.value[0]).toBe("");
    expect(field.result.result.value[1]).not.toContain(sentinel);
    expect(await clipboard("probe")).toBe(sentinel);
  } finally {
    await endpoint?.close();
    await j.close();
    site.close();
  }
});

it("keeps a person's own Run's paste chord as before, and refuses its clipboard grant, in real Chromium", async () => {
  const clipboardGrantSentence =
    "Clipboard permissions cannot be granted to a page. Paste with a key chord, or use Input.insertText to enter text.";
  const sentinel = `opensteer-clipboard-sentinel-${randomUUID()}`;
  // A secure origin, so that the page's own clipboard API exists.
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Form</title><input id=field>");
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const form = `http://127.0.0.1:${(site.address() as AddressInfo).port}/form`;
  const j = await journey("own-clipboard");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(
      j.task.userId,
      j.command("own-clipboard"),
    );
    const own = await j.launched()!.context.pages().at(-1)!.cdp();
    const previous = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    await own.send("Page.navigate", { url: form });
    await vi.waitFor(async () => {
      expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).not.toBe(
        previous,
      );
      const state = await own.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      expect(state.result.value).toBe("complete");
    });
    // The sentinel is copied in another page of the same browser, outside any agent's CDP.
    const other = await (await j.launched()!.context.createPage()).cdp();
    await other.send("Runtime.evaluate", {
      expression: `document.body.innerHTML = '<input id="secret" value=${JSON.stringify(sentinel)}>'; document.getElementById('secret').focus(); document.getElementById('secret').select()`,
    });
    for (const type of ["rawKeyDown", "keyUp"])
      await other.send("Input.dispatchKeyEvent", {
        type,
        modifiers: 4,
        key: "c",
        code: "KeyC",
        ...(type === "keyUp" ? {} : { commands: ["copy"] }),
      });

    const run = {
      agentBindingId: `run:${j.task.runId}`,
      ownerId: j.task.userId,
      environmentId: j.task.environmentId,
      threadId: j.task.threadId,
    };
    const scope = await j.store.runCapabilityScope(j.task.runId);
    if (!scope) throw new Error("The test Run has no browser authority.");
    const bound = await home.service.bindPage(
      {
        ...scope,
        aud: "opensteer-run-tools",
        iss: "opensteer-host",
        jti: randomUUID(),
        iat: 1,
        exp: 2,
      },
      (await j.tabs.get(j.task.userId, tabId))!,
    );
    const cdp = await home.service.attachCdpForAgent(
      { ...run, sessionId: bound.sessionId },
      () => {},
    );
    try {
      const { targetInfos } = (await cdp.request({ method: "Target.getTargets" })) as {
        targetInfos: { targetId: string; url: string }[];
      };
      const target = targetInfos.find(({ url }) => url === form)!;
      const { sessionId: page } = (await cdp.request({
        method: "Target.attachToTarget",
        parameters: { targetId: target.targetId, flatten: true },
      })) as { sessionId: string };
      const evaluate = async (expression: string, userGesture = false) =>
        (
          (await cdp.request({
            method: "Runtime.evaluate",
            parameters: { expression, awaitPromise: true, returnByValue: true, userGesture },
            sessionId: page,
          })) as { result: { value: unknown } }
        ).result.value;
      await evaluate("document.getElementById('field').focus()");
      // The person's own Run keeps what #638 gave it: paste by chord.
      for (const type of ["rawKeyDown", "keyUp"])
        await cdp.request({
          method: "Input.dispatchKeyEvent",
          parameters: {
            type,
            modifiers: 4,
            key: "v",
            code: "KeyV",
            ...(type === "keyUp" ? {} : { commands: ["paste"] }),
          },
          sessionId: page,
        });
      expect(await evaluate("document.getElementById('field').value")).toBe(sentinel);
      // A clipboard grant would outlast the Run and serve a connected agent's page script.
      for (const scope of [undefined, page])
        for (const parameters of [
          { permissions: ["clipboardReadWrite"] },
          { permissions: ["clipboardSanitizedWrite"] },
        ])
          await expect(
            cdp.request({
              method: "Browser.grantPermissions",
              parameters,
              ...(scope ? { sessionId: scope } : {}),
            }),
          ).rejects.toThrow(clipboardGrantSentence);
      expect(
        await evaluate(
          "navigator.clipboard.readText().then(t => 'read:' + t, e => 'denied:' + e.name)",
          true,
        ),
      ).toMatch(/^denied:/u);
    } finally {
      if (cdp.pooledClose) await cdp.pooledClose();
      else cdp.close();
    }
  } finally {
    await j.close();
    site.close();
  }
});
