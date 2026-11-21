import {
  AgentConnectionStore,
  admitAgentOperation,
  beginAgentSession,
  beginBrowserPoolPark,
  decideAgentOperation,
  handOffAgentOperation,
  installBrowserPoolSlot,
  listBrowserPoolDocumentLosses,
  readBrowserPoolSlot,
  settleBrowserPoolRelay,
  browserPoolRelayDeadlineMs,
  pruneBrowserPoolBookkeeping,
  type BrowserPoolTargetIdentity,
} from "../packages/database/src/index.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  decodeBrowserFrameEnvelope,
} from "../packages/protocol/src/browser.js";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { createId } from "../packages/core/src/index.js";
import { PooledBrowserRelay } from "../apps/host/src/browser/browser-pool-relay.js";
import { removeDevice } from "../apps/host/src/administration/device-removal.js";
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";
import {
  before,
  dyingAfter,
  editVisibly,
  holdResume,
  journey,
  TestRuntimeConnection,
} from "./browser-pool-journey.test-support.js";

it("vetoes D on an ended session with confined CDP contact loss", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("park-cdp-loss");
    const { database } = fixture;
    const target: BrowserPoolTargetIdentity = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "pool-slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    await personalBrowserRepository(fixture.store).createBrowserSession({
      ownerId: task.userId,
      id: sessionId,
      origin: "agent",
      placementKey: "pool-test",
      profileId: null,
      runnerId: target.runnerId,
      runtimeId: target.runtimeId,
    });
    const attachmentId = randomUUID();
    const lost = { runtimeBootId: target.instanceId, contactLostAt: new Date().toISOString() };
    await database
      .updateTable("browserSessions")
      .set({
        state: "closed",
        closedAt: new Date(),
        standardCdpAttempts: { [attachmentId]: lost },
      })
      .where("id", "=", sessionId)
      .execute();
    await installBrowserPoolSlot(database, target);
    const begin = () => beginBrowserPoolPark(database, target, randomUUID(), () => false);
    expect(await begin()).toBeUndefined();
    expect(await readBrowserPoolSlot(database, target.runnerId)).toMatchObject({
      phase: "running",
      intentId: null,
    });
    await database
      .updateTable("browserSessions")
      .set({
        standardCdpAttempts: {
          [attachmentId]: { ...lost, terminalEvidenceAt: new Date().toISOString() },
        },
      })
      .where("id", "=", sessionId)
      .execute();
    expect(await begin()).toMatchObject({ phase: "preparing" });
  } finally {
    await fixture.close();
  }
});

it("keeps outstanding Shared Chrome and plugin handoffs outside D", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("park-foreign-effects");
    const { database } = fixture;
    const connections = new AgentConnectionStore(database);
    const connection = await connections.create({
      userId: task.userId,
      label: "Fixture connection",
      clientName: "Fixture agent",
      accessMode: "full-access",
      grant: { scope: "everything" },
      resource: "https://fixture.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await connections.activate(connection.id, randomUUID())).toBe(true);
    const { grantRevision } = await database
      .selectFrom("agentConnections")
      .select("grantRevision")
      .where("id", "=", connection.id)
      .executeTakeFirstOrThrow();
    const lineage = { userId: task.userId, agentConnectionId: connection.id };
    const { session } = await beginAgentSession(database, lineage);
    for (const grant of [
      { kind: "chrome-tabs", sourceId: createId("browserSource") },
      { kind: "plugin", target: { kind: "installed", pluginId: "fixture-plugin" } },
    ] as const) {
      const { operation } = await admitAgentOperation(database, {
        ...lineage,
        sessionId: session.id,
        operationKey: grant.kind,
        tool: grant.kind,
        argumentDigest: randomUUID(),
        target: { grant, name: grant.kind, device: null },
        targetGeneration: null,
        grantRevision,
        mode: "full-access",
        effect: "write",
        calls: grant.kind,
        agentReason: null,
      });
      const reviewed = await decideAgentOperation(database, operation, { by: "full-access" });
      await expect(
        handOffAgentOperation(database, { ...lineage, reviewed }),
      ).resolves.toMatchObject({ state: "handed-off", terminalEvidenceAt: null });
    }
    const target = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "test-slot",
      instanceId: randomUUID(),
      term: 1,
      epoch: 1,
    };
    await installBrowserPoolSlot(database, target);
    const intent = await beginBrowserPoolPark(database, target, randomUUID(), () => false);
    expect(intent?.phase).toBe("preparing");
    expect(
      await database
        .selectFrom("agentOperations")
        .select("state")
        .where("sessionId", "=", session.id)
        .execute(),
    ).toEqual([{ state: "handed-off" }, { state: "handed-off" }]);
  } finally {
    await fixture.close();
  }
});

it("lets a lost relay reply veto only until the relay deadline, and prunes it then", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("relay-deadline");
    const target = {
      runnerId: task.runnerId,
      runtimeId: "runtime",
      slotId: "slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    const slot = await installBrowserPoolSlot(fixture.database, target);
    const relay = await PooledBrowserRelay.open(fixture.database, target, { release: () => {} });
    relay.submitted();
    await relay.close();
    expect(
      await beginBrowserPoolPark(fixture.database, target, randomUUID(), () => false),
    ).toBeUndefined();
    // Past the deadline the runtime's own drain decides; the row no longer vetoes.
    await fixture.database
      .updateTable("browserPoolRelays")
      .set({
        createdAt: sql`now() - make_interval(secs => ${browserPoolRelayDeadlineMs / 1000 + 1})`,
      })
      .execute();
    await pruneBrowserPoolBookkeeping(fixture.database, slot);
    expect(await fixture.database.selectFrom("browserPoolRelays").selectAll().execute()).toEqual(
      [],
    );
    expect(
      await beginBrowserPoolPark(fixture.database, target, randomUUID(), () => false),
    ).toMatchObject({ phase: "preparing" });
  } finally {
    await fixture.close();
  }
});

it("keeps lost pooled relay replies in D after the transport ends", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("relay-lost-reply");
    const target = {
      runnerId: task.runnerId,
      runtimeId: "runtime",
      slotId: "slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    await installBrowserPoolSlot(fixture.database, target);
    const release = vi.fn();
    const relay = await PooledBrowserRelay.open(fixture.database, target, { release });
    relay.submitted();
    relay.track("Runtime.evaluate", undefined, Promise.reject(new Error("Reply lost")));
    await relay.close();
    expect(release).toHaveBeenCalledOnce();
    // The reply that never came keeps the relay's row: D vetoes on it.
    expect(
      await beginBrowserPoolPark(fixture.database, target, randomUUID(), () => false),
    ).toBeUndefined();
    const [row] = await fixture.database.selectFrom("browserPoolRelays").select("id").execute();
    await settleBrowserPoolRelay(fixture.database, row!.id);
    expect(
      await beginBrowserPoolPark(fixture.database, target, randomUUID(), () => false),
    ).toMatchObject({ phase: "preparing" });
  } finally {
    await fixture.close();
  }
});
it("opens a person tab through the Home after the pooled runtime wakes, with a lost pause request and a lost resume reply", async () => {
  const j = await journey("empty", { chromium: false });
  try {
    const home = await j.startHome();
    expect(j.controller.effects).toEqual(["start"]);
    j.controller.inject("pause", "request");
    expect(await home.coordinator.tryPark()).toBe("parked");
    expect(j.controller.effects).toEqual(["start", "pause"]);
    j.controller.inject("resume", "reply");
    await expect(
      home.service.openTab(j.task.userId, j.command("after-wake")),
    ).resolves.toMatchObject({
      tabId: expect.any(String),
    });
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    expect(j.issued).toHaveLength(1);
    expect(await j.slot()).toMatchObject({ phase: "running", epoch: 2 });
    expect(await j.store.getBrowserTabOpen(j.task.userId, "after-wake")).toMatchObject({
      outcome: { kind: "opened" },
    });
  } finally {
    await j.close();
  }
});

it("keeps an unsent draft through a vetoed park, a park and a Home restart, and edits the same document visibly", async () => {
  const j = await journey("first-proof");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("draft"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(original).toEqual(expect.any(String));
    // A send before D vetoes the park.
    const early = await home.coordinator.gate.reserve(AbortSignal.timeout(1_000));
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    early.release();
    j.withholdNextTicket();
    await expect(
      home.service.start({ ownerId: j.task.userId, fresh: true, reuseExisting: false }),
    ).rejects.toThrow();
    const withheld = j.withheld[0]!;
    expect(withheld).toEqual(expect.any(String));
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    const beforePark = j.issued[0]!;
    const issuedBeforeWake = j.issued.length;
    home = await j.restartHome(home);
    expect(home.coordinator.gate.phase).toBe("parked");
    expect((await j.row(sessionId))?.state).toBe("ready");
    expect(j.controller.effects).toEqual(["start", "pause"]);
    const resume = holdResume(j.controller);
    const watching = j.viewer(home, sessionId);
    await before(resume.seen, watching.attaching, "The viewer");
    expect(j.issued).toHaveLength(issuedBeforeWake);
    resume.allow();
    const attached = await watching.attaching;
    try {
      expect(await page.page.targetId()).toBe(page.targetId);
      expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
      await editVisibly(attached, watching.frames, tabId, page.value, page.rendered);
      expect(await home.coordinator.tryPark()).toBe("vetoed");
      expect(await j.slot()).toMatchObject({
        phase: "running",
        epoch: 2,
        outcome: { adopted: [sessionId], lost: [] },
      });
      // A ticket issued before the park is refused after the wake.
      const refusal = async (ticket: string) => {
        const stale = j.connect(ticket);
        const refused = Promise.withResolvers<unknown>();
        stale.once("error", refused.resolve);
        const error = await refused.promise;
        expect(stale.readyState).toBe(3);
        return (error as Error).message;
      };
      expect(await refusal(beforePark)).toBe("The browser attach ticket has already been used.");
      // A ticket the Home really issued before the park, whose delivery was lost, meets the
      // new fence when it finally arrives.
      expect(await refusal(withheld)).toBe("The pooled browser authority has changed.");
      expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

it("carries the tabs the person used to the adopted broker of a restored session, by its lineage", async () => {
  const j = await journey("person-use");
  try {
    const home = await j.startHome();
    const { sessionId: first, tabId } = await home.service.openTab(
      j.task.userId,
      j.command("person-use"),
    );
    // The session ends and the tab is restored: a new session under the first one's lineage.
    await home.service.stop(j.task.userId, first);
    const restoredRow = await j.tabs.get(j.task.userId, tabId);
    const restored = await home.service.pageTabs.activate(
      j.task.userId,
      restoredRow!,
      "person-use-restore",
    );
    const sessionId = restored.kind === "page" ? restored.sessionId : undefined;
    expect(sessionId).toBeDefined();
    expect(sessionId).not.toBe(first);
    const lineage = await j.database
      .selectFrom("browserSessions")
      .select("tabGroupId")
      .where("id", "=", sessionId!)
      .executeTakeFirstOrThrow();
    expect(lineage.tabGroupId).toBe(first);
    // What the Home tells the runtime about the person's use.
    const send = vi.spyOn(TestRuntimeConnection.prototype, "send");
    const marked = (from: number) =>
      send.mock.calls.slice(from).flatMap(([data]) => {
        const message = JSON.parse(data) as { type: string; personUsed?: string[] };
        return message.type === "session.state" ? (message.personUsed ?? []) : [];
      });
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    const parked = send.mock.calls.length;
    // A watch viewer wakes it: watching is not use, so only the carried use can name the tab.
    const watching = j.viewer(home, sessionId!, "watch");
    const attached = await watching.attaching;
    attached.close();
    expect(await j.slot()).toMatchObject({ outcome: { adopted: [sessionId], lost: [] } });
    await vi.waitFor(() => expect(marked(parked)).toContain(tabId));
  } finally {
    vi.restoreAllMocks();
    await j.close();
  }
});

it("lets a Stop asked as the reattach ticket leaves wait for the broker, and close it the way Stop does", async () => {
  const j = await journey("stop-at-ticket");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("stop-at"));
    const page = await j.draft();
    expect(await home.coordinator.tryPark()).toBe("parked");
    let stopping: Promise<void> | undefined;
    // Any read of the session's lineage made after the ticket left waits until Stop committed:
    // the widest a Stop between the ticket and the broker's registration can be.
    const prototype: { query(...args: unknown[]): unknown } = pg.Client.prototype;
    const query = prototype.query;
    let afterTicket = false;
    const held = vi.spyOn(prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text;
      if (afterTicket && stopping && text?.includes('select "tab_group_id"')) {
        afterTicket = false;
        const waiting = stopping;
        return waiting.then(() => Reflect.apply(query, this, args));
      }
      return Reflect.apply(query, this, args);
    });
    j.onNextTicket(() => {
      afterTicket = true;
      stopping = home.service.stop(j.task.userId, sessionId);
    });
    try {
      const woken = await home.coordinator.gate.reserve(AbortSignal.timeout(15_000));
      woken.release();
    } finally {
      held.mockRestore();
    }
    expect(stopping).toBeDefined();
    await stopping;
    expect((await j.row(sessionId))?.state).toBe("closed");
    // Stop found the registered broker and closed it: the page ends now, not at a deadline.
    await vi.waitFor(() => expect(page.page.isClosed()).toBe(true), { timeout: 5_000 });
    expect(home.service.pageInventory(sessionId)?.records.has(tabId) ?? false).toBe(false);
  } finally {
    await j.close();
  }
});

it("stops a parked session while its viewer waits and never reattaches it", async () => {
  const j = await journey("stop-waiting");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("stop"));
    const page = await j.draft();
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const resume = holdResume(j.controller);
    const watching = j.viewer(home, sessionId);
    await before(resume.seen, watching.attaching, "The viewer");
    const attachesBefore = j.issued.length;
    await home.service.stop(j.task.userId, sessionId);
    await expect(watching.attaching).rejects.toThrow("stopped this browser");
    resume.allow();
    await vi.waitFor(async () =>
      expect(await j.slot()).toMatchObject({
        phase: "running",
        outcome: { adopted: [], lost: [{ sessionId }] },
      }),
    );
    expect(j.issued.length).toBe(attachesBefore);
    expect(page.page.isClosed()).toBe(true);
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject([
      { sessionId },
    ]);
  } finally {
    await j.close();
  }
});

it("stops a validly parked browser session without waking it", async () => {
  const j = await journey("stop-parked");
  try {
    let home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("stop-parked"));
    const page = await j.draft();
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    await home.service.stop(j.task.userId, sessionId);
    expect((await j.row(sessionId))?.state).toBe("closed");
    expect(await j.slot()).toMatchObject({ phase: "parked" });
    expect(j.controller.effects).toEqual(["start", "pause"]);
    expect(page.page.isClosed()).toBe(false);
  } finally {
    await j.close();
  }
});

it("adopts the open tab of a session and closes the one closed while parked", async () => {
  const j = await journey("two-tabs");
  try {
    let home = await j.startHome();
    const first = await home.service.openTab(j.task.userId, j.command("tab-a"));
    const second = await home.service.openTab(j.task.userId, j.command("tab-b"));
    expect(second.sessionId).toBe(first.sessionId);
    const pages = j.guest.health();
    expect(pages.sessionCount).toBe(1);
    const kept = await j.draft(0);
    const keptDocument = home.service
      .pageInventory(first.sessionId)
      ?.records.get(first.tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const closedRow = await j.tabs.get(j.task.userId, second.tabId);
    expect((await j.tabs.close(j.task.userId, [second.tabId], "close-parked")).tabIds).toEqual([
      second.tabId,
    ]);
    await home.service.pageTabs.closeViewers(j.task.userId, closedRow!, true);
    expect(j.controller.effects).toEqual(["start", "pause"]);
    const row = await j.tabs.get(j.task.userId, first.tabId);
    const activating = home.service.pageTabs.activate(j.task.userId, row!, "activate-kept");
    await expect(activating).resolves.toMatchObject({
      kind: "page",
      sessionId: first.sessionId,
      surfaceId: first.tabId,
    });
    expect(home.service.pageInventory(first.sessionId)?.records.get(first.tabId)?.documentId).toBe(
      keptDocument,
    );
    await vi.waitFor(() =>
      expect(home.service.pageInventory(first.sessionId)?.records.has(second.tabId)).toBe(false),
    );
    expect(await kept.value()).toBe('["unsent draft",99]');
    expect((await j.row(first.sessionId))?.state).toBe("ready");
    expect(await j.slot()).toMatchObject({
      phase: "running",
      outcome: { adopted: [first.sessionId], lost: [] },
    });
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, second.tabId)).toEqual(
      [],
    );
  } finally {
    await j.close();
  }
});

it("wakes only for a visible owner context read and keeps a parked sign-in lookup non-waking", async () => {
  const j = await journey("context");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("context"));
    await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    await expect(
      home.service.signInTarget({ ownerId: j.task.userId, sessionId, tabId }),
    ).resolves.toBeNull();
    await expect(
      home.service.readContextCandidate(j.task.userId, {
        sessionId,
        tabId: BrowserSurfaceIdSchema.parse(`bsf_${randomUUID()}`),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(j.controller.effects).toEqual(["start", "pause"]);
    const resume = holdResume(j.controller);
    const reading = home.service.readContextCandidate(j.task.userId, { sessionId, tabId });
    await before(resume.seen, reading, "The context read");
    resume.allow();
    await expect(reading).resolves.toMatchObject({ sessionId, tabId, documentId: original });
  } finally {
    await j.close();
  }
});

it("continues an adoption a Home crash interrupted, inside the original window, with one resume", async () => {
  const j = await journey("recover-adoption");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("crash"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home, dyingAfter(j.guest, "adopt"));
    const dying = j.viewer(home, sessionId);
    await vi.waitFor(() => expect(j.guest.poolState()?.phase).toBe("adopting"));
    const interrupted = j.guest.poolState()!;
    expect(await j.slot()).toMatchObject({ phase: "waking", epoch: 2 });
    home = await j.restartHome(home);
    await expect(dying.attaching).rejects.toThrow();
    expect(home.coordinator.gate.phase).toBe("open");
    expect(j.guest.poolState()?.adoption?.until).toBe(interrupted.adoption?.until);
    expect(j.controller.effects).toEqual(["start", "pause", "resume"]);
    const watching = j.viewer(home, sessionId);
    const attached = await watching.attaching;
    try {
      expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
      await editVisibly(attached, watching.frames, tabId, page.value, page.rendered);
      expect(await j.slot()).toMatchObject({
        phase: "running",
        epoch: 2,
        outcome: { adopted: [sessionId], lost: [] },
      });
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

it("keeps a saved-profile session's draft through a park and adopts it with its profile", async () => {
  const j = await journey("saved-profile", { profile: true });
  try {
    let home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const [tab] = await home.service.savedPages(j.task.userId, session.id);
    if (!tab?.pageBinding) throw new Error("The saved profile has no durable tab.");
    const page = await j.draft();
    const original = home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const row = await j.tabs.get(j.task.userId, tab.id);
    await expect(
      home.service.pageTabs.activate(j.task.userId, row!, "activate-profile"),
    ).resolves.toMatchObject({ kind: "page", sessionId: session.id, surfaceId: tab.id });
    expect(home.service.pageInventory(session.id)?.records.get(tab.id)?.documentId).toBe(original);
    expect(await page.value()).toBe('["unsent draft",99]');
    expect((await j.row(session.id))?.profileId).toBe(j.profile!.id);
    expect(await j.store.getBrowserProfileStorage(j.profile!.id)).toMatchObject({
      kind: "local",
      initialized: true,
    });
  } finally {
    await j.close();
  }
});

it("keeps a page an agent opened through a park and adopts its session", async () => {
  const j = await journey("agent-page");
  try {
    let home = await j.startHome();
    const run = {
      agentBindingId: `run:${j.task.runId}`,
      ownerId: j.task.userId,
      environmentId: j.task.environmentId,
      threadId: j.task.threadId,
    };
    const opened = await home.service.openAgentTab(run, {
      identity: { kind: "guest", computer: j.task.runnerId },
      operationKey: "agent-page",
    });
    const page = await j.draft();
    const original = home.service
      .pageInventory(opened.sessionId)
      ?.records.get(opened.tabId)?.documentId;
    expect((await j.row(opened.sessionId))?.origin).toBe("agent");
    // While the Run holds the page, the park is vetoed; once it let go, the page is kept.
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    // The Run's end goes the ordinary way; its state update is delivered before a park.
    await home.service.detachAgentSessionsForBinding(run.agentBindingId);
    await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    // The person watches the agent's page: that demand wakes the browser.
    const watching = j.viewer(home, opened.sessionId, "watch");
    const attached = await watching.attaching;
    attached.close();
    expect(
      home.service.pageInventory(opened.sessionId)?.records.get(opened.tabId)?.documentId,
    ).toBe(original);
    expect(await page.value()).toBe('["unsent draft",99]');
    expect(await j.slot()).toMatchObject({
      outcome: { adopted: [opened.sessionId], lost: [] },
    });
  } finally {
    await j.close();
  }
});

it("says once that a page could not be kept when the saved state expired, and reopens it", async () => {
  const j = await journey("expired");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("expired"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    j.controller.observe({ phase: "stopped", savedState: null, epoch: null });
    const row = await j.tabs.get(j.task.userId, tabId);
    const restored = await home.service.pageTabs.activate(j.task.userId, row!, "activate-lost");
    expect(restored).toMatchObject({
      kind: "page",
      surfaceId: tabId,
      recoveryNotice: "This page was reloaded because its live state could not be kept.",
    });
    expect(restored.kind === "page" && restored.sessionId).not.toBe(sessionId);
    expect(page.page.isClosed()).toBe(true);
    expect((await j.row(sessionId))?.state).toBe("failed");
    expect(
      restored.kind === "page" &&
        home.service.pageInventory(restored.sessionId)?.records.get(tabId)?.documentId,
    ).not.toBe(original);
    // The reply that carried the notice may not have reached the person: until the client
    // says it showed it, every activation carries it again.
    const activate = (key: string, seen?: string) =>
      j.tabs
        .get(j.task.userId, tabId)
        .then((row) => home.service.pageTabs.activate(j.task.userId, row!, key, seen));
    const retried = await activate("activate-retry");
    expect(retried).toMatchObject({ recoveryNotice: expect.any(String) });
    const noticeId = restored.kind === "page" ? restored.recoveryNoticeId : undefined;
    expect(noticeId).toEqual(expect.any(String));
    expect(retried.kind === "page" && retried.recoveryNoticeId).toBe(noticeId);
    const again = await activate("activate-again", noticeId);
    expect(again).not.toHaveProperty("recoveryNotice");
    expect(await activate("activate-later")).not.toHaveProperty("recoveryNotice");
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject([
      { sessionId, surfaceId: tabId, documentId: original, noticedAt: expect.any(Date) },
    ]);
    expect(j.controller.effects).toEqual(["start", "pause", "start"]);
  } finally {
    await j.close();
  }
});

it("keeps every page usable after a release that followed a retire", async () => {
  let seals = 0;
  const j = await journey("release-after-retire", {
    // Both seal requests are lost: the park is released after its retire.
    runtimeFault: (kind) => (kind === "seal" && seals++ < 2 ? "request" : undefined),
  });
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("release"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    expect(j.guest.poolState()).toMatchObject({
      phase: "running",
      cancelled: true,
      adoption: { cause: "release", outcome: { adopted: [sessionId], lost: [] } },
    });
    expect(j.controller.effects).toEqual(["start"]);
    expect(home.coordinator.gate.phase).toBe("open");
    const watching = j.viewer(home, sessionId);
    const attached = await watching.attaching;
    try {
      expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
      await editVisibly(attached, watching.frames, tabId, page.value, page.rendered);
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

for (const mode of ["run-open", "run-bind"] as const)
  it(
    mode === "run-open"
      ? "waits for pooled admission before a Run opens its own page"
      : "waits for pooled admission before a Run binds and joins a retained page",
    async () => {
      const j = await journey(mode);
      try {
        let home = await j.startHome();
        const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command(mode));
        await j.draft();
        const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
        expect(await home.coordinator.tryPark()).toBe("parked");
        home = await j.restartHome(home);
        const run = {
          agentBindingId: `run:${j.task.runId}`,
          ownerId: j.task.userId,
          environmentId: j.task.environmentId,
          threadId: j.task.threadId,
        };
        const tab = await j.tabs.get(j.task.userId, tabId);
        const resume = holdResume(j.controller);
        const result =
          mode === "run-open"
            ? home.service.openAgentTab(run, {
                identity: { kind: "guest", computer: j.task.runnerId },
                operationKey: "run-open",
              })
            : (async () => {
                const scope = await j.store.runCapabilityScope(j.task.runId);
                if (!scope) throw new Error("The test Run has no browser authority.");
                return home.service.bindPage(
                  {
                    ...scope,
                    aud: "opensteer-run-tools",
                    iss: "opensteer-host",
                    jti: randomUUID(),
                    iat: 1,
                    exp: 2,
                  },
                  tab!,
                );
              })();
        try {
          await before(resume.seen, result, "The Run");
          expect(
            await j.store.listActiveBrowserSessionsForAgentBinding(run.agentBindingId),
          ).toEqual([]);
          resume.allow();
          const bound = await result;
          expect(bound.backend).toBe("cdp");
          if (mode === "run-bind") {
            expect(bound).toMatchObject({ tabId, sessionId, reloaded: false });
            await expect(
              home.service.openAgentSession({ ...run, sessionId }),
            ).resolves.toMatchObject({
              wasExisting: true,
              session: { id: sessionId, attached: true },
            });
            expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(
              original,
            );
          } else expect(bound.sessionId).not.toBe(sessionId);
          expect(await j.store.listBrowserSessionAttachmentBindings(bound.sessionId)).toEqual([
            run.agentBindingId,
          ]);
          expect(await home.coordinator.tryPark()).toBe("vetoed");
          const cdp = await home.service.attachCdpForAgent(
            { ...run, sessionId: bound.sessionId },
            () => {},
          );
          try {
            await j.store.detachBrowserSessionAttachments(run.agentBindingId);
            expect(await home.coordinator.tryPark()).toBe("vetoed");
            expect(await cdp.request({ method: "Target.getTargets" })).toMatchObject({
              targetInfos: expect.any(Array),
            });
            await expect(
              home.service.attachActionsForAgent({ ...run, sessionId: bound.sessionId }, () => {}),
            ).rejects.toThrow("no detach receipt");
          } finally {
            await cdp.pooledClose!();
          }
          expect(await j.database.selectFrom("browserPoolRelays").selectAll().execute()).toEqual(
            [],
          );
        } finally {
          resume.allow();
          await result.catch(() => undefined);
        }
      } finally {
        await j.close();
      }
    },
  );

it("holds the gate until an awake physical close has a matching terminal receipt", async () => {
  const j = await journey("close-awake");
  try {
    const home = await j.startHome();
    const { tabId } = await home.service.openTab(j.task.userId, j.command("close-awake"));
    const page = await j.draft();
    const tab = await j.tabs.get(j.task.userId, tabId);
    const closed = Promise.withResolvers<void>();
    page.page.onClose(() => closed.resolve());
    expect((await j.tabs.close(j.task.userId, [tabId], "close-awake")).tabIds).toEqual([tabId]);
    await home.service.pageTabs.closeViewers(j.task.userId, tab!, true);
    await closed.promise;
    await vi.waitFor(async () =>
      expect(await j.database.selectFrom("browserPoolRelays").selectAll().execute()).toEqual([]),
    );
    expect(j.controller.effects).toEqual(["start"]);
  } finally {
    await j.close();
  }
});

it("holds the gate for a live Watch viewer before its first retained-page frame", async () => {
  const j = await journey("live-watch");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("watch"));
    const page = await j.draft();
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const resume = holdResume(j.controller);
    const watching = j.viewer(home, sessionId, "watch");
    await before(resume.seen, watching.attaching, "The Watch viewer");
    resume.allow();
    const attached = await watching.attaching;
    try {
      await attached.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId })),
        false,
      );
      await vi.waitFor(() => expect(watching.frames.length).toBeGreaterThan(0));
      expect(decodeBrowserFrameEnvelope(watching.frames[0]!).header.surfaceId).toBe(tabId);
      expect(await page.page.targetId()).toBe(page.targetId);
      expect(await home.coordinator.tryPark()).toBe("vetoed");
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

it("lets a Stop that commits while a saved-profile session reattaches win, and does not adopt it", async () => {
  const j = await journey("stop-during-reattach", { profile: true });
  try {
    let home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      profileId: j.profile!.id,
    });
    const page = await j.draft();
    expect(await home.coordinator.tryPark()).toBe("parked");
    home = await j.restartHome(home);
    const current = home;
    // The adoption looks up the profile's storage; the person's Stop commits right then.
    const identity = BrowserLocalProfiles.prototype.identity;
    let stopped = false;
    const spy = vi
      .spyOn(BrowserLocalProfiles.prototype, "identity")
      .mockImplementation(async function (this: BrowserLocalProfiles, ...args) {
        if (!stopped) {
          stopped = true;
          await current.service.stop(j.task.userId, session.id);
        }
        return identity.apply(this, args);
      });
    try {
      const watching = j.viewer(home, session.id, "watch");
      await expect(watching.attaching).rejects.toThrow();
      await vi.waitFor(async () =>
        expect(await j.slot()).toMatchObject({
          phase: "running",
          outcome: { adopted: [], lost: [{ sessionId: session.id }] },
        }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(stopped).toBe(true);
    expect((await j.row(session.id))?.state).toBe("closed");
    // The live browser does not stay behind the closed row.
    await vi.waitFor(() => expect(page.page.isClosed()).toBe(true));
  } finally {
    await j.close();
  }
});

it("parks under a running Trigger and a live Watch with no browser, and is vetoed while each holds one", async () => {
  const j = await journey("program-journey");
  try {
    const home = await j.startHome();
    const owner = { ownerId: j.task.userId, environmentId: j.task.environmentId };
    // A running Trigger occurrence and a live Watch activation, neither with a browser yet.
    const occurrence = await j.fixture.startTriggerOccurrence(j.task, "pool-program");
    const watch = await j.fixture.triggers.create({
      actorThreadId: null,
      anchorThreadId: j.task.threadId,
      createdBy: j.task.userId,
      idempotencyKey: "pool-watch",
      name: "Pool Watch",
      program: {
        toolContractVersion: 5,
        language: "javascript",
        source: "export default async () => new Promise(() => setInterval(() => {}, 1000))",
      },
      source: { kind: "watch" },
    });
    const { activations } = await j.fixture.triggers.reconcileWatchesForRunner({
      environmentId: j.task.environmentId,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
      runnerBootId: j.task.runnerBootId,
      runnerConnectionGeneration: 1,
      runnerId: j.task.runnerId,
    });
    const activation = activations.find(
      (entry) => entry.activation.triggerId === watch.trigger.id,
    )?.activation;
    expect(activation).toBeDefined();
    const trigger = { ...owner, agentBindingId: `trigger:${occurrence.id}` };
    const watcher = { ...owner, agentBindingId: `watch:${activation!.id}` };
    // Programs that have not asked for a browser leave the park alone.
    expect(await home.coordinator.tryPark()).toBe("parked");

    // Each program connects to its browser the way its CDP route does: the demand wakes it,
    // the open connection vetoes the park, and once the route closed it the browser parks.
    const connect = async (authority: typeof trigger) => {
      const opened = await home.service.openAgentSession({ ...authority, fresh: true });
      const cdp = await home.service.attachCdpForAgent(
        { ...authority, sessionId: opened.session.id },
        () => {},
      );
      return {
        session: opened.session.id,
        close: async () => {
          cdp.close();
          await home.service.closeTriggerSessionsForBinding(authority.agentBindingId);
          await vi.waitFor(() => expect(home.coordinator.gate.held).toBe(0));
        },
      };
    };
    const triggerBrowser = await connect(trigger);
    expect((await j.row(triggerBrowser.session))?.origin).toBe("trigger");
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    await triggerBrowser.close();
    expect(await home.coordinator.tryPark()).toBe("parked");
    const watchBrowser = await connect(watcher);
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    await watchBrowser.close();
    expect(await home.coordinator.tryPark()).toBe("parked");
    expect(j.controller.effects).toEqual(["start", "pause", "resume", "pause", "resume", "pause"]);
  } finally {
    await j.close();
  }
});

it("D counts a program's open browser session and nothing else of the program", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("program-demand");
    const target = {
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId: "slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    await installBrowserPoolSlot(fixture.database, target);
    const begin = () => beginBrowserPoolPark(fixture.database, target, randomUUID(), () => false);
    // A program that has not asked for a browser leaves nothing for D to see.
    const intent = await begin();
    expect(intent).toMatchObject({ phase: "preparing" });
    await fixture.database
      .updateTable("browserPoolSlots")
      .set({ phase: "running" })
      .where("runnerId", "=", task.runnerId)
      .execute();
    // A program's browser session vetoes while it is open; adoption does not rebuild it yet.
    const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    await personalBrowserRepository(fixture.store).createBrowserSession({
      ownerId: task.userId,
      id: sessionId,
      origin: "trigger",
      placementKey: "pool-test",
      profileId: null,
      runnerId: task.runnerId,
      runtimeId: target.runtimeId,
    });
    await fixture.store.transitionBrowserSession({ sessionId, state: "ready" });
    expect(await begin()).toBeUndefined();
    await fixture.store.transitionBrowserSession({ sessionId, state: "closed" });
    expect(await begin()).toMatchObject({ phase: "preparing" });
  } finally {
    await fixture.close();
  }
});

it("keeps the person's pages through a Runner restart and reattaches them under a newer attachment", async () => {
  const j = await journey("runner-restart");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("restart"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    const before = (await j.slot())!.attachmentGeneration;
    j.runnerDown();
    // Nothing ends: the row stays ready, the page keeps running, sends wait.
    await vi.waitFor(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    expect((await j.row(sessionId))?.state).toBe("ready");
    expect(page.page.isClosed()).toBe(false);
    const waiting = home.coordinator.gate.reserve(AbortSignal.timeout(15_000));
    j.runnerUp();
    const held = await waiting;
    held.release();
    expect(home.coordinator.gate.phase).toBe("open");
    expect((await j.slot())!.attachmentGeneration).toBeGreaterThan(before);
    expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
    expect(await page.value()).toBe('["unsent draft",99]');
    // No pause happened: the controller saw only the start.
    expect(j.controller.effects).toEqual(["start"]);
    const watching = j.viewer(home, sessionId);
    const attached = await watching.attaching;
    try {
      await editVisibly(attached, watching.frames, tabId, page.value, page.rendered);
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

it("keeps the person's pages when the Runner's channel closes cleanly, code 1000 included", async () => {
  const j = await journey("runner-clean-close");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("restart"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    const before = (await j.slot())!.attachmentGeneration;
    j.runnerDown(1000);
    // Nothing ends: the row stays ready, the page keeps running, sends wait.
    await vi.waitFor(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    expect((await j.row(sessionId))?.state).toBe("ready");
    expect(page.page.isClosed()).toBe(false);
    const waiting = home.coordinator.gate.reserve(AbortSignal.timeout(15_000));
    j.runnerUp();
    const held = await waiting;
    held.release();
    expect(home.coordinator.gate.phase).toBe("open");
    expect((await j.slot())!.attachmentGeneration).toBeGreaterThan(before);
    expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
    expect(await page.value()).toBe('["unsent draft",99]');
    // No pause happened: the controller saw only the start.
    expect(j.controller.effects).toEqual(["start"]);
    const watching = j.viewer(home, sessionId);
    const attached = await watching.attaching;
    try {
      await editVisibly(attached, watching.frames, tabId, page.value, page.rendered);
    } finally {
      attached.close();
    }
  } finally {
    await j.close();
  }
});

it("ends the sessions with their note when the Runner does not come back before the deadline", async () => {
  const j = await journey("runner-gone", { channelDeadlineMs: 1_500 });
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("gone"));
    const page = await j.draft();
    j.runnerDown();
    await vi.waitFor(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    await vi.waitFor(() => expect(home.coordinator.gate.phase).toBe("open"), { timeout: 10_000 });
    expect((await j.row(sessionId))?.state).toBe("failed");
    await vi.waitFor(() => expect(page.page.isClosed()).toBe(true), { timeout: 10_000 });
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject([
      { sessionId, surfaceId: tabId, reason: "not-adopted" },
    ]);
  } finally {
    j.runnerUp();
    await j.close();
  }
});

/** Every removal dependency but the store and the browser does nothing, as nothing else runs. */
function removalDependencies(store: unknown, browser: unknown) {
  const passive: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : passive),
    apply: (_target, _this, args: unknown[]) => {
      const last = args.at(-1);
      return typeof last === "function" ? (last as () => unknown)() : Promise.resolve(undefined);
    },
  });
  const real: Record<string, unknown> = { store, browser };
  return new Proxy(real, {
    get: (target, property: string) => (property in target ? target[property] : passive),
  }) as never;
}

it("ends a removed device's pooled sessions with their notes through the real removal, and never wakes it", async () => {
  const j = await journey("device-removed");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("removed"));
    await j.draft();
    // A Cloud Computer is a managed Runner, never the Home's own: it can be removed.
    await j.database
      .updateTable("runners")
      .set({ kind: "managed" })
      .where("id", "=", j.task.runnerId)
      .execute();
    // The real route: the store's revocation ends the sessions in its own transaction, then the
    // removal's own steps.
    await removeDevice(
      removalDependencies(j.store, home.service),
      await j.store.requireSelfDeviceId(j.task.runnerId),
      j.task.userId,
    );
    const state = await j.database
      .selectFrom("browserSessions")
      .select("state")
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    expect(state.state).toBe("failed");
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject([
      { sessionId, reason: "device-removed" },
    ]);
    await home.coordinator.released();
    expect(await j.slot()).toBeUndefined();
    expect(j.controller.effects).toEqual(["start", "stop"]);
    await expect(home.coordinator.gate.reserve(AbortSignal.timeout(1_000))).rejects.toThrow(
      "device was removed",
    );
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    expect(j.controller.effects).toEqual(["start", "stop"]);
  } finally {
    await j.close();
  }
});

it("gives each loss of a tab its own notice, reports only the newest, and clears it once seen", async () => {
  const j = await journey("notices");
  try {
    const home = await j.startHome();
    const report = async () => (await home.service.resourcePools([j.task.runnerId]))[0];
    const { tabId } = await home.service.openTab(j.task.userId, j.command("notices"));
    // The tab is lost twice: a restart, a reopen, and another restart.
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "restart-1");
    await home.service.pageTabs.activate(
      j.task.userId,
      (await j.tabs.get(j.task.userId, tabId))!,
      "reopen",
    );
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "restart-2");
    const notes = await j.database
      .selectFrom("browserPoolDocumentLosses")
      .select(["intentId", "lostAt"])
      .where("surfaceId", "=", tabId)
      .orderBy("lostAt", "desc")
      .execute();
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map(({ intentId }) => intentId)).size).toBe(2);
    // Only the newest unseen notice of the tab is reported, with its id.
    const shown = (await report())?.pages?.filter(({ surfaceId }) => surfaceId === tabId);
    expect(shown).toEqual([
      expect.objectContaining({ surfaceId: tabId, noticeId: notes[0]!.intentId }),
    ]);
    const revision = async () =>
      (
        (
          await j.database
            .selectFrom("clientSyncState")
            .select("resourceRevisions")
            .executeTakeFirstOrThrow()
        ).resourceRevisions as Record<string, string>
      )["browser-placement"];
    const before = await revision();
    // Seen: it and the older one leave the report, and subscribed readers are told.
    await home.service.poolNoticeSeen(j.task.userId, tabId, notes[0]!.intentId);
    expect(((await report())?.pages ?? []).map(({ surfaceId }) => surfaceId)).not.toContain(tabId);
    expect(await revision()).not.toBe(before);
    expect(
      await j.database
        .selectFrom("browserPoolDocumentLosses")
        .select("noticedAt")
        .where("surfaceId", "=", tabId)
        .where("noticedAt", "is", null)
        .execute(),
    ).toEqual([]);
    // However many tabs wait, the report stays bounded well under the protocol's limit.
    const owner = j.task.userId;
    await j.database
      .insertInto("browserPoolDocumentLosses")
      .values(
        Array.from({ length: 150 }, (_, index) => ({
          intentId: randomUUID(),
          runnerId: j.task.runnerId,
          ownerId: owner,
          sessionId: BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`),
          surfaceId: BrowserSurfaceIdSchema.parse(`srf_backlog_${index}`),
          documentId: null,
          reason: "person",
        })),
      )
      .execute();
    expect((await report())?.pages).toHaveLength(100);
  } finally {
    await j.close();
  }
});

it("counts the failed starts of a restart in the report, and clears the count once one starts", async () => {
  const j = await journey("failed-starts");
  try {
    const home = await j.startHome();
    const report = async () => (await home.service.resourcePools([j.task.runnerId]))[0];
    await home.service.openTab(j.task.userId, j.command("failed-starts"));
    // The first two fresh starts cannot reach the controller; the third is held there.
    const status = j.controller.status.bind(j.controller);
    let unreachable = 2;
    vi.spyOn(j.controller, "status").mockImplementation(async (slotId, term) => {
      if (unreachable > 0) {
        unreachable--;
        throw new Error("The pool controller is unreachable.");
      }
      return status(slotId, term);
    });
    const third = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    j.controller.hold("start", async () => {
      reached.resolve();
      await third.promise;
    });
    const restarting = home.service.restartPooledBrowser(j.task.userId, j.task.runnerId);
    await reached.promise;
    // A third attempt is under way: the person sees the restart, and the two that failed.
    expect(await report()).toMatchObject({ phase: "restarting", failures: 2 });
    expect(await j.slot()).toMatchObject({ failedStarts: 2 });
    third.resolve();
    await restarting;
    const started = await report();
    expect(started).toMatchObject({ phase: "running", start: { reason: "person" } });
    expect(started).not.toHaveProperty("failures");
    expect(await j.slot()).toMatchObject({ failedStarts: 0 });
    expect(j.controller.effects).toEqual(["start", "stop", "start"]);
  } finally {
    await j.close();
  }
});

it("reports the pooled browser's phase, a fresh start's reason and the pages not kept, and restarts for the owner only", async () => {
  const j = await journey("pool-report");
  try {
    let home = await j.startHome();
    const report = async () => (await home.service.resourcePools([j.task.runnerId]))[0];
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("report"));
    await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    expect(await report()).toMatchObject({ runnerId: j.task.runnerId, phase: "running" });
    expect(await home.coordinator.tryPark()).toBe("parked");
    expect(await report()).toMatchObject({ phase: "parked", since: expect.any(String) });
    home = await j.restartHome(home);
    const row = await j.tabs.get(j.task.userId, tabId);
    await home.service.pageTabs.activate(j.task.userId, row!, "report-wake");
    expect(await report()).toMatchObject({ phase: "running" });
    expect(home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
    // Only the owner restarts it; an ordinary computer has no such browser.
    await expect(
      home.service.restartPooledBrowser("usr_someone-else" as never, j.task.runnerId),
    ).rejects.toMatchObject({ code: "forbidden" });
    await home.service.restartPooledBrowser(j.task.userId, j.task.runnerId);
    expect(j.controller.effects).toEqual(["start", "pause", "resume", "stop", "start"]);
    const restarted = await report();
    expect(restarted).toMatchObject({
      phase: "running",
      start: { reason: "person", at: expect.any(String) },
      pages: [{ surfaceId: tabId, outcome: "lost", typed: false }],
    });
    expect(restarted).not.toHaveProperty("failures");
    expect((await j.row(sessionId))?.state).toBe("failed");
    // Reopened, the page came back by reloading; once seen, it is no longer reported.
    const reopened = await home.service.pageTabs.activate(
      j.task.userId,
      (await j.tabs.get(j.task.userId, tabId))!,
      "report-reopen",
    );
    expect((await report())?.pages).toEqual([
      {
        surfaceId: tabId,
        noticeId: reopened.kind === "page" ? reopened.recoveryNoticeId : undefined,
        outcome: "reloaded",
        typed: false,
      },
    ]);
    await home.service.pageTabs.activate(
      j.task.userId,
      (await j.tabs.get(j.task.userId, tabId))!,
      "report-seen",
      reopened.kind === "page" ? reopened.recoveryNoticeId : undefined,
    );
    expect(await report()).not.toHaveProperty("pages");
  } finally {
    await j.close();
  }
});
