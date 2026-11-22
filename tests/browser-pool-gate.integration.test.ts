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
import { expect, it, vi } from "vitest";
import { createId } from "../packages/core/src/index.js";
import { PooledBrowserRelay } from "../apps/host/src/browser/browser-pool-relay.js";
import { loopbackPoolChannel } from "../apps/host/src/browser/browser-pool-coordinator.js";
import type {
  BrowserPoolEndAnswer,
  BrowserPoolRuntimeState,
} from "../packages/browser-runtime-core/src/index.js";
import type { BrowserSessionId } from "../packages/core/src/index.js";
import { removeDevice } from "../apps/host/src/administration/device-removal.js";
import {
  registerTriggerCdpBridge,
  registerWatchCdpBridge,
} from "../apps/host/src/browser/trigger-cdp-bridge.js";
import { hostInternalRoutePaths } from "../apps/host/src/server/internal-routes.js";
import { createRequire } from "node:module";

/** Packages the Host depends on, resolved as the Host resolves them. */
const requireFromHost = createRequire(new URL("../apps/host/package.json", import.meta.url));
const { WebSocket } = requireFromHost("ws") as typeof import("ws");
/** The database driver's client, as the Host loads it; only its query method is used here. */
const pg = requireFromHost("pg") as {
  readonly Client: { readonly prototype: { query(...args: unknown[]): unknown } };
};
type FastifyLike = {
  register(plugin: unknown): Promise<unknown>;
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<unknown>;
  readonly server: { address(): unknown };
};
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import {
  before,
  dyingAfter,
  editVisibly,
  holdResume,
  journey,
  TestRuntimeConnection,
  until,
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

it("prunes a pooled browser's notes after seven days, seen or not, and keeps a newer unseen one", async () => {
  const fixture = await createStoreFixture();
  try {
    const task = await fixture.createRunFixture("notes-retention");
    const target = {
      runnerId: task.runnerId,
      runtimeId: "runtime",
      slotId: "slot",
      term: 1,
      instanceId: randomUUID(),
      epoch: 1,
    };
    const slot = await installBrowserPoolSlot(fixture.database, target);
    const note = async (surfaceId: string, days: number, seen: boolean) => {
      await fixture.database
        .insertInto("browserPoolDocumentLosses")
        .values({
          intentId: randomUUID(),
          runnerId: task.runnerId,
          ownerId: task.userId,
          sessionId: BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`),
          surfaceId: BrowserSurfaceIdSchema.parse(surfaceId),
          documentId: null,
          reason: "person",
        })
        .execute();
      // Lost, and seen if it was, this many days ago.
      await sql`
        update browser_pool_document_losses
        set lost_at = now() - make_interval(days => ${days}),
            noticed_at = case when ${seen}::boolean then now() - make_interval(days => ${days}) end
        where surface_id = ${surfaceId}
      `.execute(fixture.database);
    };
    await note("srf_unseen_old", 8, false);
    await note("srf_seen_old", 8, true);
    await note("srf_unseen_new", 1, false);
    await note("srf_seen_new", 1, true);
    await pruneBrowserPoolBookkeeping(fixture.database, slot);
    const kept = await fixture.database
      .selectFrom("browserPoolDocumentLosses")
      .select("surfaceId")
      .orderBy("surfaceId")
      .execute();
    expect(kept.map(({ surfaceId }) => surfaceId)).toEqual(["srf_seen_new", "srf_unseen_new"]);
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
    await until(() => expect(home.coordinator.gate.held).toBe(0));
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
      await editVisibly(attached, watching, tabId, page.value, page.rendered);
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
    await until(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    const parked = send.mock.calls.length;
    // A watch viewer wakes it: watching is not use, so only the carried use can name the tab.
    const watching = j.viewer(home, sessionId!, "watch");
    const attached = await watching.attaching;
    attached.close();
    expect(await j.slot()).toMatchObject({ outcome: { adopted: [sessionId], lost: [] } });
    await until(() => expect(marked(parked)).toContain(tabId));
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
    const prototype = pg.Client.prototype;
    const query = prototype.query;
    let afterTicket = false;
    const held = vi.spyOn(prototype, "query").mockImplementation(function (
      this: unknown,
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
    // Closed once the runtime has said the session ended (P5), not the moment Stop returns.
    await until(async () => expect((await j.row(sessionId))?.state).toBe("closed"));
    // Stop found the registered broker and closed it: the page ends now, not at a deadline.
    await until(() => expect(page.page.isClosed()).toBe(true));
    expect(home.service.pageInventory(sessionId)?.records.has(tabId) ?? false).toBe(false);
  } finally {
    await j.close();
  }
});

it("keeps the person's tab the person's through a Home restart while parked, then a wake", async () => {
  const j = await journey("person-use-restart");
  try {
    let home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("used"));
    await home.service.pageTabs.activate(
      j.task.userId,
      (await j.tabs.get(j.task.userId, tabId))!,
      "person-uses",
    );
    const personUsed = () =>
      [
        ...(
          j.guest as unknown as {
            sessions: Map<
              string,
              { ledger: { policyRecords(): Iterable<{ id: string; personUsed: boolean }> } }
            >;
          }
        ).sessions
          .get(sessionId)!
          .ledger.policyRecords(),
      ].find((record) => record.id === tabId)?.personUsed;
    await until(() => expect(personUsed()).toBe(true));
    await until(() => expect(home.coordinator.gate.held).toBe(0));
    expect(await home.coordinator.tryPark()).toBe("parked");
    // The Home restarts while parked; its own record of who used which tab starts empty.
    home = await j.restartHome(home);
    // A watch viewer wakes it: watching is not use, so nothing new marks the tab.
    const watching = j.viewer(home, sessionId, "watch");
    const attached = await watching.attaching;
    attached.close();
    expect(await j.slot()).toMatchObject({ outcome: { adopted: [sessionId], lost: [] } });
    // The guest kept it: the tab is still the person's.
    expect(personUsed()).toBe(true);
  } finally {
    await j.close();
  }
});

it("holds a viewer's protection, queued after the park intent, in the adopted runtime before its first frame", async () => {
  // The retire waits in its frozen probe: the park intent has committed and the old broker is
  // still there when the viewer arrives.
  const inProbe = Promise.withResolvers<void>();
  const probe = Promise.withResolvers<void>();
  let holding = false;
  const j = await journey("protection-after-intent", {
    probePage: async (_page, phase) => {
      if (holding && phase === "frozen") {
        inProbe.resolve();
        await probe.promise;
      }
      return [];
    },
  });
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("protect"));
    await j.draft();
    await until(() => expect(home.coordinator.gate.held).toBe(0));
    holding = true;
    const parking = home.coordinator.tryPark();
    await inProbe.promise;
    // A control viewer attaches after the intent: its protection (viewed) is queued, not sent.
    const viewed = () =>
      (
        j.guest as unknown as {
          sleeper: { poolState(id: string): { viewed: readonly string[] } | null };
        }
      ).sleeper.poolState(sessionId)?.viewed ?? [];
    let atFirstFrame: readonly string[] | undefined;
    const watching = j.viewer(home, sessionId, "control", () => {
      atFirstFrame = [...viewed()];
    });
    holding = false;
    probe.resolve();
    expect(await parking).toBe("parked");
    // The viewer's demand wakes and adopts the browser; before its first frame passes, the
    // adopted runtime already holds the protection.
    const attached = await watching.attaching;
    try {
      await attached.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId })),
        false,
      );
      await until(() => expect(watching.frames.length).toBeGreaterThan(0));
      expect(atFirstFrame).toContain(tabId);
      expect(await j.slot()).toMatchObject({ outcome: { adopted: [sessionId], lost: [] } });
    } finally {
      attached.close();
    }
  } finally {
    probe.resolve();
    await j.close();
  }
});

it("keeps a running browser's sessions through a Home crash and reattaches them", async () => {
  const j = await journey("home-crash-running");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("crash"));
    const page = await j.draft();
    const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
    // The Home dies while the browser runs, and starts again: the start-up sweep keeps the
    // pooled session, and the loop reattaches it inside its window.
    const next = await j.crashHome(home);
    await until(() => expect(next.coordinator.gate.phase).toBe("open"));
    expect((await j.row(sessionId))?.state).toBe("ready");
    expect(next.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(original);
    expect(page.page.isClosed()).toBe(false);
    expect(await page.value()).toBe('["unsent draft",99]');
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toEqual([]);
  } finally {
    await j.close();
  }
});

for (const away of ["within", "past"] as const)
  it(`${away === "within" ? "brings a Home away longer than 20 seconds back to the same documents, inside the window" : "ends the sessions of a Home away longer than the window with their notes"}`, async () => {
    const j = await journey(`away-${away}`);
    // Time flows, and jumps: the clock (Date.now and new Date alike) is moved, never a timer.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      const home = await j.startHome();
      const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("away"));
      const page = await j.draft();
      const original = home.service.pageInventory(sessionId)?.records.get(tabId)?.documentId;
      // The Home dies for an update while its Runner is away too, and starts again.
      j.runnerDown();
      const next = await j.crashHome(home);
      await until(() => expect(next.coordinator.gate.phase).toBe("reconnecting"));
      vi.setSystemTime(Date.now() + (away === "within" ? 30_000 : 11 * 60_000));
      j.runnerUp();
      await until(() => expect(next.coordinator.gate.phase).toBe("open"));
      if (away === "within") {
        expect((await j.row(sessionId))?.state).toBe("ready");
        expect(next.service.pageInventory(sessionId)?.records.get(tabId)?.documentId).toBe(
          original,
        );
        expect(page.page.isClosed()).toBe(false);
        expect(await page.value()).toBe('["unsent draft",99]');
        expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toEqual([]);
        // The reconnect is over: nothing of it holds the next sleep off.
        expect(await next.coordinator.tryPark()).toBe("parked");
      } else {
        expect((await j.row(sessionId))?.state).toBe("failed");
        expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject(
          [{ sessionId, surfaceId: tabId, reason: "not-adopted" }],
        );
      }
    } finally {
      vi.useRealTimers();
      j.runnerUp();
      await j.close();
    }
  });

for (const change of ["same tab, other picture options", "the viewer leaves the tab"] as const)
  it(`${change === "the viewer leaves the tab" ? "cancels the keys queued for a tab its viewer leaves, as not applied" : "keeps keys queued behind a slow page through a same-tab change of picture options, in order"}`, async () => {
    const j = await journey(`queued-${change === "the viewer leaves the tab" ? "leave" : "same"}`);
    try {
      const home = await j.startHome();
      const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("queued"));
      const page = await j.draft();
      const watching = j.viewer(home, sessionId, "control");
      const attached = await watching.attaching;
      try {
        const send = (message: Record<string, unknown>) =>
          attached.handle(Buffer.from(JSON.stringify(message)), false);
        await send({ type: "stream.subscribe", surfaceId: tabId });
        await watching.next(0);
        // The page is busy: the first key waits on it, the rest queue behind it in the runtime.
        void page.cdp
          .send("Runtime.evaluate", {
            expression: "{ const until = Date.now() + 1500; while (Date.now() < until) {} }",
          })
          .catch(() => undefined);
        for (const text of ["a", "b", "c", "d"])
          for (const action of ["down", "up"])
            await send({
              type: "input.key",
              surfaceId: tabId,
              key: text,
              code: `Key${text.toUpperCase()}`,
              modifiers: [],
              text,
              action,
            });
        if (change === "the viewer leaves the tab")
          await send({ type: "stream.unsubscribe", surfaceId: tabId });
        // Other region and pacing options on the same tab, and back again.
        else {
          // A region change, then a window change, then back.
          await send({ type: "stream.subscribe", surfaceId: tabId, captureRegion: true });
          await send({ type: "stream.subscribe", surfaceId: tabId, frameWindow: 1 });
          await send({ type: "stream.subscribe", surfaceId: tabId });
        }
        if (change === "same tab, other picture options") {
          // Every key reaches the page, in the order it was typed.
          await until(async () => expect(await page.value()).toBe('["unsent draftabcd",99]'));
          expect(
            watching.messages.filter(
              (message) =>
                (message.error as { reason?: string } | undefined)?.reason ===
                "browser-input-canceled",
            ),
          ).toEqual([]);
        } else {
          // What had not started is refused, and said so; it never reaches the page.
          await until(() =>
            expect(
              watching.messages.some(
                (message) =>
                  (message.error as { reason?: string } | undefined)?.reason ===
                  "browser-input-canceled",
              ),
            ).toBe(true),
          );
          await until(async () =>
            expect(await page.value()).toMatch(/^\["unsent draft[a]?",99\]$/u),
          );
        }
      } finally {
        attached.close();
      }
    } finally {
      await j.close();
    }
  });

/** A control viewer of the journey's first page, with a busy page to queue input behind. */
async function queuedInput(key: string) {
  const j = await journey(key);
  const home = await j.startHome();
  const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command(key));
  const page = await j.draft();
  // The page counts the clicks and wheel events it receives.
  await page.cdp.send("Runtime.evaluate", {
    expression: `window.__clicks = 0; window.__wheels = 0;
      addEventListener("click", () => window.__clicks++, true);
      addEventListener("wheel", () => window.__wheels++, true);`,
  });
  const counts = async () =>
    (
      await page.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
        expression: "JSON.stringify([window.__clicks, window.__wheels])",
        returnByValue: true,
      })
    ).result.value;
  const size = async () =>
    JSON.parse(
      (
        await page.cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: "JSON.stringify([innerWidth, innerHeight])",
          returnByValue: true,
        })
      ).result.value,
    ) as [number, number];
  const viewer = async () => {
    const watching = j.viewer(home, sessionId, "control");
    const attached = await watching.attaching;
    const send = (message: Record<string, unknown>) =>
      attached.handle(Buffer.from(JSON.stringify(message)), false);
    await send({ type: "stream.subscribe", surfaceId: tabId });
    await watching.next(0);
    const refused = (reason: string) =>
      watching.messages.some(
        (message) => (message.error as { reason?: string } | undefined)?.reason === reason,
      );
    return { attached, send, watching, refused };
  };
  // The page is busy: the first input waits on it, the rest queue behind it in the runtime.
  const busy = () =>
    void page.cdp
      .send("Runtime.evaluate", {
        expression: "{ const until = Date.now() + 1500; while (Date.now() < until) {} }",
      })
      .catch(() => undefined);
  const keys = async (send: (message: Record<string, unknown>) => Promise<void>, text: string) => {
    for (const key of text)
      for (const action of ["down", "up"])
        await send({
          type: "input.key",
          surfaceId: tabId,
          key,
          code: `Key${key.toUpperCase()}`,
          modifiers: [],
          text: key,
          action,
        });
  };
  return { j, home, tabId, page, counts, size, viewer, busy, keys };
}

it("refuses a pooled broker's send at its write when a restart hold began after it was queued", async () => {
  const q = await queuedInput("write-hold");
  try {
    // Two producers: each viewer sends its own messages in order, so the queued key is the
    // other viewer's, waiting in the broker behind the first.
    const { send } = await q.viewer();
    const { send: other } = await q.viewer();
    // Only this test sets the gate's facts from here on: the loop's own publications are ignored.
    const gate = q.home.coordinator.gate;
    const facts = gate.set.bind(gate);
    q.home.coordinator.close();
    const pinned = vi.spyOn(gate, "set").mockImplementation(() => {});
    const key = (text: string) => ({
      type: "input.key",
      surfaceId: q.tabId,
      key: text,
      code: `Key${text.toUpperCase()}`,
      modifiers: [],
      text,
      action: "down",
    });
    const written: string[] = [];
    const first = Promise.withResolvers<void>();
    let holding = false;
    const relay = LocalBrowserRuntimeBridge.prototype.send;
    const spy = vi
      .spyOn(LocalBrowserRuntimeBridge.prototype, "send")
      .mockImplementation(async function (this: LocalBrowserRuntimeBridge, channel, message) {
        if (message.type === "input.key") {
          written.push(message.key);
          // The first key is held on its way out: the next one queues behind it.
          if (message.key === "a" && !holding) {
            holding = true;
            await first.promise;
          }
        }
        return relay.call(this, channel, message);
      });
    try {
      const before = gate.held;
      void send(key("a")).catch(() => undefined);
      await vi.waitFor(() => expect(holding).toBe(true));
      // Admitted at queue time, before any hold: its reservation is held while it waits.
      void other(key("b")).catch(() => undefined);
      await vi.waitFor(() => expect(gate.held).toBe(before + 2));
      // The restart's hold begins after that, while "b" waits behind "a".
      facts({ hold: "restart" });
      first.resolve();
      await vi.waitFor(() => expect(gate.held).toBe(before));
      // The hold ends; a later key is written, and "b" never was.
      facts({ hold: null });
      void other(key("c")).catch(() => undefined);
      await vi.waitFor(() => expect(written).toContain("c"));
      expect(written).toEqual(["a", "c"]);
    } finally {
      spy.mockRestore();
      pinned.mockRestore();
    }
  } finally {
    await q.j.close();
  }
});

it("delivers no pointer or wheel event aimed at a size the page no longer has, from a peer without capture revisions", async () => {
  const q = await queuedInput("queued-geometry");
  try {
    const { send, refused, attached } = await q.viewer();
    const [width, height] = await q.size();
    // Aimed at the picture before a resize: the size it names is not the page's now. Like an
    // older peer, it names no capture or geometry revision.
    const aimed = { surfaceId: q.tabId, viewportWidth: width + 13, viewportHeight: height + 7 };
    q.busy();
    await send({ type: "input.pointer", ...aimed, action: "down", button: "left", x: 0.5, y: 0.5 });
    await send({ type: "input.pointer", ...aimed, action: "up", button: "left", x: 0.5, y: 0.5 });
    await send({ type: "input.wheel", ...aimed, x: 0.5, y: 0.5, deltaX: 0, deltaY: 120 });
    // A key after them is the barrier: once it reached the page, the lane passed them. For a
    // peer without revisions on a page without capture, a stale point is dropped unannounced
    // (`controller.ts`, dispatchPointer); with revisions it is refused as stale geometry.
    await q.keys(send, "z");
    await until(async () => expect(await q.page.value()).toBe('["unsent draftz",99]'));
    expect(await q.counts()).toBe("[0,0]");
    expect(refused("browser-input-canceled")).toBe(false);
    attached.close();
  } finally {
    await q.j.close();
  }
});

it("keeps keys queued before a resize in order, and refuses a pointer aimed at the old size", async () => {
  const q = await queuedInput("queued-resize");
  try {
    const { send, attached } = await q.viewer();
    const [width, height] = await q.size();
    q.busy();
    await q.keys(send, "ab");
    // The resize waits behind what is queued on the page, so the keys meet the size they were
    // typed at.
    await send({
      type: "viewport.set",
      surfaceId: q.tabId,
      width: width - 40,
      height: height - 30,
    });
    await until(async () => expect(await q.page.value()).toBe('["unsent draftab",99]'));
    await until(async () => expect((await q.size())[0]).toBe(width - 40));
    await send({
      type: "input.pointer",
      surfaceId: q.tabId,
      viewportWidth: width,
      viewportHeight: height,
      action: "down",
      button: "left",
      x: 0.5,
      y: 0.5,
    });
    await q.keys(send, "z");
    await until(async () => expect(await q.page.value()).toBe('["unsent draftabz",99]'));
    expect(await q.counts()).toBe("[0,0]");
    attached.close();
  } finally {
    await q.j.close();
  }
});

it("ends the first viewer's queued keys when a second viewer takes over and the first goes, never the second's", async () => {
  const q = await queuedInput("queued-takeover");
  try {
    const first = await q.viewer();
    q.busy();
    await q.keys(first.send, "abcd");
    // A second viewer joins the same page: its own queue, which the first one's does not end.
    const second = await q.viewer();
    await q.keys(second.send, "x");
    // Taken over, the first viewer's socket closes: what it had queued and not begun ends.
    first.attached.close();
    await until(async () => expect(await q.page.value()).toMatch(/^\["unsent draft[a]?x",99\]$/u));
    expect(second.refused("browser-input-canceled")).toBe(false);
    second.attached.close();
  } finally {
    await q.j.close();
  }
});

for (const then of ["stays", "leaves"] as const)
  it(`${then === "stays" ? "keeps a viewer's queued keys when it drops its pictures on the same tab" : "cancels a viewer's queued keys when it drops its pictures and then leaves"}`, async () => {
    const q = await queuedInput(`queued-control-${then}`);
    try {
      const { send, refused, attached } = await q.viewer();
      q.busy();
      await q.keys(send, "abcd");
      await send({ type: "stream.subscribe", surfaceId: q.tabId, frames: false });
      if (then === "leaves") await send({ type: "stream.unsubscribe", surfaceId: q.tabId });
      if (then === "stays") {
        await until(async () => expect(await q.page.value()).toBe('["unsent draftabcd",99]'));
        expect(refused("browser-input-canceled")).toBe(false);
      } else {
        await until(() => expect(refused("browser-input-canceled")).toBe(true));
        await until(async () =>
          expect(await q.page.value()).toMatch(/^\["unsent draft[a]?",99\]$/u),
        );
      }
      attached.close();
    } finally {
      await q.j.close();
    }
  });

it("finishes a removal a Home crash interrupted after the revocation, with the notes", async () => {
  const j = await journey("removal-crash");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("removal"));
    await j.draft();
    await j.database
      .updateTable("runners")
      .set({ kind: "managed" })
      .where("id", "=", j.task.runnerId)
      .execute();
    // The revocation commits; the Home dies before the browser hears of it.
    const removed = await j.store.revokeRunner(j.task.runnerId, j.task.userId, {
      allowDeployment: true,
    });
    expect(removed.closedBrowserSessions).toContain(sessionId);
    const next = await j.crashHome(home);
    await next.coordinator.released();
    expect(next.coordinator.gate.phase).toBe("released");
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject([
      { sessionId, reason: "device-removed" },
    ]);
    expect(await j.slot()).toBeUndefined();
    expect(j.controller.effects).toEqual(["start", "stop"]);
  } finally {
    await j.close();
  }
});

it("restarts through the service while a park is retiring, with no reconnect after it", async () => {
  const inProbe = Promise.withResolvers<void>();
  const probe = Promise.withResolvers<void>();
  let holding = false;
  const j = await journey("restart-retiring", {
    probePage: async (_page, phase) => {
      if (holding && phase === "frozen") {
        inProbe.resolve();
        await probe.promise;
      }
      return [];
    },
  });
  try {
    const home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("retiring"));
    await j.draft();
    await until(() => expect(home.coordinator.gate.held).toBe(0));
    holding = true;
    const parking = home.coordinator.tryPark();
    await inProbe.promise;
    const asked = Date.now();
    const restarting = home.service.restartPooledBrowser(j.task.userId, j.task.runnerId, "r-1");
    holding = false;
    probe.resolve();
    await parking;
    await restarting;
    // The retiring broker's close was the park's own, never a lost channel: nothing waits for it.
    expect(home.coordinator.gate.phase).toBe("open");
    expect(Date.now() - asked).toBeLessThan(10_000);
    expect((await j.row(sessionId))?.state).toBe("failed");
  } finally {
    probe.resolve();
    await j.close();
  }
});

it("lets a Stop during a reconnect end that session's wait at once, and say closed only with the runtime's answer", async () => {
  const j = await journey("stop-reconnect");
  try {
    const home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("stop-reconnect"));
    const page = await j.draft();
    j.runnerDown();
    await until(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    const stopped = Date.now();
    await home.service.stop(j.task.userId, sessionId);
    // The stopped session no longer needs a channel: the gate does not hold for its window.
    await until(() => expect(home.coordinator.gate.phase).toBe("open"));
    expect(Date.now() - stopped).toBeLessThan(5_000);
    // The awake guest still holds the page: the row is closing, never closed, and nothing new
    // is admitted for it.
    expect((await j.row(sessionId))?.state).toBe("closing");
    expect(page.page.isClosed()).toBe(false);
    await expect(
      home.service.openTab(j.task.userId, {
        type: "browser.tab.open",
        sessionId: BrowserSessionIdSchema.parse(sessionId),
        idempotencyKey: "after-stop",
      }),
    ).rejects.toThrow("The browser has ended.");
    const ticketsBefore = j.issued.length;
    j.runnerUp();
    // The Home asks the guest's runtime to end it; its answer, after its teardown, is the
    // receipt. No channel is opened for a stopped session (P15).
    await until(async () => expect((await j.row(sessionId))?.state).toBe("closed"));
    expect(page.page.isClosed()).toBe(true);
    expect(j.issued.length).toBe(ticketsBefore);
  } finally {
    j.runnerUp();
    await j.close();
  }
});

it("never reads a pooled Stop closed while the guest still holds the page, whatever the Runner answers", async () => {
  const j = await journey("stop-runner-ack");
  try {
    const home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("stop-ack"));
    const page = await j.draft();
    // The tunnel to the guest breaks as the Stop's close leaves; the Runner answers 1000 for the
    // close it merely queued, as its relay does.
    const acked = vi
      .spyOn(TestRuntimeConnection.prototype, "close")
      .mockImplementationOnce(function (this: TestRuntimeConnection) {
        j.tunnelBreaks();
        this.lose(1000, "closed");
      });
    try {
      await home.service.stop(j.task.userId, sessionId);
    } finally {
      acked.mockRestore();
    }
    // The row leaves closing only for closed, and only once the guest's runtime ended the page.
    const ended = await vi.waitFor(
      async () => {
        const state = (await j.row(sessionId))?.state;
        expect(state).not.toBe("closing");
        return state;
      },
      { timeout: 20_000 },
    );
    expect(ended).toBe("closed");
    expect(page.page.isClosed()).toBe(true);
  } finally {
    await j.close();
  }
});

it("keeps a Stop's row closing while the guest holds the session on a channel it never saw close, until its pages are gone", async () => {
  const j = await journey("stop-stalled");
  try {
    const home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("stop-stalled"));
    const page = await j.draft();
    // The tunnel stalls as the Stop's close leaves: the Home's side ends with no answer, and the
    // guest's channel stays open, so the guest still holds the session and its pages.
    const stall = function (this: TestRuntimeConnection) {
      this.lose(1006, "runtime did not answer");
    };
    const stalled = [
      vi.spyOn(TestRuntimeConnection.prototype, "close").mockImplementationOnce(stall),
      vi.spyOn(TestRuntimeConnection.prototype, "terminate").mockImplementationOnce(stall),
    ];
    try {
      await home.service.stop(j.task.userId, sessionId);
    } finally {
      for (const spy of stalled) spy.mockRestore();
    }
    expect(page.page.isClosed()).toBe(false);
    expect((await j.row(sessionId))?.state).toBe("closing");
    // The Home asks the guest's runtime to end it; the row leaves closing only for closed, and
    // only once the guest's page is gone.
    const ended = await vi.waitFor(
      async () => {
        const state = (await j.row(sessionId))?.state;
        expect(state).not.toBe("closing");
        return state;
      },
      { timeout: 20_000 },
    );
    expect(ended).toBe("closed");
    expect(page.page.isClosed()).toBe(true);
  } finally {
    await j.close();
  }
});

it("writes closed only for the runtime's ended, from a running runtime under the same fence, and asks again after anything else", async () => {
  const j = await journey("stop-answers");
  try {
    // What the runtime answers first, before its own answer is let through.
    const answers: ((state: BrowserPoolRuntimeState) => BrowserPoolEndAnswer)[] = [
      (state) => ({ outcome: "not-yet", state }),
      (state) => ({ outcome: "unknown", state }),
      (state) => ({
        outcome: "ended",
        state: { ...state, fence: { ...state.fence!, epoch: state.fence!.epoch + 1 } },
      }),
      (state) => ({ outcome: "ended", state: { ...state, phase: "retired" } }),
    ];
    let sessionId: BrowserSessionId | undefined;
    let pageClosed: (() => boolean) | undefined;
    const rows: string[] = [];
    const home = await j.startHome({
      ...loopbackPoolChannel(j.guest),
      endSession: async (ticket) => {
        rows.push(`${(await j.row(sessionId!))?.state} ${pageClosed?.() ? "gone" : "open"}`);
        const answer = answers.shift();
        return answer ? answer(j.guest.poolState()!) : j.guest.endPoolSession(ticket);
      },
    });
    ({ sessionId } = await home.service.openTab(j.task.userId, j.command("stop-answers")));
    const page = await j.draft();
    pageClosed = () => page.page.isClosed();
    const stall = function (this: TestRuntimeConnection) {
      this.lose(1006, "runtime did not answer");
    };
    const stalled = [
      vi.spyOn(TestRuntimeConnection.prototype, "close").mockImplementationOnce(stall),
      vi.spyOn(TestRuntimeConnection.prototype, "terminate").mockImplementationOnce(stall),
    ];
    try {
      await home.service.stop(j.task.userId, sessionId!);
    } finally {
      for (const spy of stalled) spy.mockRestore();
    }
    await until(async () => expect((await j.row(sessionId!))?.state).toBe("closed"));
    // Each answer before the runtime's own left the row closing, and the page in the guest.
    expect(rows).toEqual(Array.from({ length: 5 }, () => "closing open"));
    expect(page.page.isClosed()).toBe(true);
  } finally {
    await j.close();
  }
});

it("neither reuses nor ends a pooled session a Stop left closing, at any door", async () => {
  const j = await journey("closing-doors");
  try {
    const home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("doors"));
    j.runnerDown();
    await until(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    await home.service.stop(j.task.userId, sessionId);
    expect((await j.row(sessionId))?.state).toBe("closing");
    // A person's start that would reuse their browser: the closing session is left to its
    // receipt, neither reused nor failed.
    const started = await home.service
      .start({
        ownerId: j.task.userId,
        fresh: true,
        reuseExisting: true,
        placement: { kind: "runner", runnerId: j.task.runnerId },
        operationBudget: { signal: AbortSignal.timeout(2_000), expiresAt: Date.now() + 2_000 },
      })
      .then(
        ({ session }) => session.id,
        () => undefined,
      );
    expect(started).not.toBe(sessionId);
    expect((await j.row(sessionId))?.state).toBe("closing");
    // A viewer is refused at once, and raises no demand for it.
    await expect(j.viewer(home, sessionId).attaching).rejects.toThrow();
    expect(home.coordinator.gate.demand).toBe(false);
    j.runnerUp();
    await until(async () => expect((await j.row(sessionId))?.state).toBe("closed"));
  } finally {
    j.runnerUp();
    await j.close();
  }
});

it("hands a stopped session whose guest died under a running slot to recovery, and spends no attachment meanwhile", async () => {
  const j = await journey("closing-dead-guest");
  try {
    const home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("dead"));
    j.runnerDown();
    await until(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    await home.service.stop(j.task.userId, sessionId);
    expect((await j.row(sessionId))?.state).toBe("closing");
    // Nothing is reconnecting any more: from here only the end step could spend an attachment.
    await until(() => expect(home.coordinator.gate.phase).toBe("open"));
    const attachments = (await j.slot())!.attachmentGeneration;
    // The guest dies while the slot reads running.
    j.controller.observe({ phase: "stopped", savedState: null, instance: null, epoch: null });
    // Recovery replaces the guest, and its end is the stopped session's evidence.
    await until(async () => expect((await j.row(sessionId))?.state).toBe("closed"));
    expect(j.controller.effects).toEqual(["start", "start"]);
    // No attachment was spent while the runtime could not be reached.
    expect((await j.slot())!.attachmentGeneration).toBe(attachments);
  } finally {
    j.runnerUp();
    await j.close();
  }
});

it("closes a session stopped while a park is under way once the park commits", async () => {
  const j = await journey("closing-during-park");
  try {
    const home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("park-stop"));
    // The park has retired the runtime and waits at its pause: the Stop lands in between.
    const pausing = Promise.withResolvers<void>();
    const pause = Promise.withResolvers<void>();
    j.controller.hold("pause", async () => {
      pausing.resolve();
      await pause.promise;
    });
    const parking = home.coordinator.tryPark();
    await pausing.promise;
    await home.service.stop(j.task.userId, sessionId);
    expect((await j.row(sessionId))?.state).toBe("closing");
    pause.resolve();
    expect(await parking).toBe("parked");
    // Parked, the guest is paused and its next adoption leaves the session out: closed.
    expect((await j.row(sessionId))?.state).toBe("closed");
    expect(j.controller.effects).toEqual(["start", "pause"]);
  } finally {
    await j.close();
  }
});

it("keeps a pooled Stop with a viewer attached closing while the runtime is silent, and closed once it answers", async () => {
  const j = await journey("stop-viewer-silent");
  try {
    const home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("stop-viewer"));
    const page = await j.draft();
    const watching = j.viewer(home, sessionId);
    const attached = await watching.attaching;
    // The Runner goes as the Stop's close leaves: the runtime never receives it.
    const silent = vi
      .spyOn(TestRuntimeConnection.prototype, "close")
      .mockImplementationOnce(() => j.runnerDown());
    try {
      await home.service.stop(j.task.userId, sessionId);
    } finally {
      silent.mockRestore();
    }
    attached.close();
    // Nothing heard: the row is closing, never closed, and nothing new is admitted for it.
    expect((await j.row(sessionId))?.state).toBe("closing");
    expect(page.page.isClosed()).toBe(false);
    await expect(
      home.service.openTab(j.task.userId, {
        type: "browser.tab.open",
        sessionId: BrowserSessionIdSchema.parse(sessionId),
        idempotencyKey: "after-silent-stop",
      }),
    ).rejects.toThrow("The browser has ended.");
    // The runtime is reached again: the end step closes it, and its answer is the receipt.
    j.runnerUp();
    await until(async () => expect((await j.row(sessionId))?.state).toBe("closed"));
    await until(() => expect(page.page.isClosed()).toBe(true));
  } finally {
    j.runnerUp();
    await j.close();
  }
});

it("keeps a pooled Trigger's stopped session closing while the runtime is silent, and closed once it answers", async () => {
  const j = await journey("stop-trigger-silent");
  try {
    const home = await j.startHome();
    const { session } = await home.service.start({
      ownerId: j.task.userId,
      fresh: true,
      origin: "trigger",
      placement: { kind: "runner", runnerId: j.task.runnerId },
    });
    expect((await j.row(session.id))?.origin).toBe("trigger");
    // The Runner is away: the session has no channel here, and the runtime hears nothing.
    j.runnerDown();
    await vi.waitFor(() => expect(home.service.pageInventory(session.id)).toBeUndefined());
    await home.service.stop(j.task.userId, session.id);
    expect((await j.row(session.id))?.state).toBe("closing");
    await expect(
      home.service.openTab(j.task.userId, {
        type: "browser.tab.open",
        sessionId: session.id,
        idempotencyKey: "after-trigger-stop",
      }),
    ).rejects.toThrow("The browser has ended.");
    j.runnerUp();
    await until(async () => expect((await j.row(session.id))?.state).toBe("closed"));
  } finally {
    j.runnerUp();
    await j.close();
  }
});

it("keeps a stopped session closing while its guest cannot be reached, across a Home restart", async () => {
  const j = await journey("stop-unreachable", { channelDeadlineMs: 1_500 });
  try {
    let home = await j.startHome();
    const { sessionId } = await home.service.openTab(j.task.userId, j.command("stop-away"));
    const page = await j.draft();
    j.runnerDown();
    await until(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    await home.service.stop(j.task.userId, sessionId);
    expect((await j.row(sessionId))?.state).toBe("closing");
    home = await j.restartHome(home);
    // The guest's own window ends the page; the Home has heard nothing, so it says nothing.
    await until(() => expect(page.page.isClosed()).toBe(true));
    await until(() => expect(home.coordinator.gate.phase).toBe("open"));
    expect((await j.row(sessionId))?.state).toBe("closing");
    // Reached again, the runtime answers that the session has ended: that is the receipt.
    j.runnerUp();
    await until(async () => expect((await j.row(sessionId))?.state).toBe("closed"));
    expect(j.controller.effects).toEqual(["start"]);
  } finally {
    j.runnerUp();
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
    await until(async () =>
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
    await until(() =>
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
    await until(() => expect(j.guest.poolState()?.phase).toBe("adopting"));
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
      await editVisibly(attached, watching, tabId, page.value, page.rendered);
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
    await until(() => expect(home.coordinator.gate.held).toBe(0));
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
    expect(restored).toMatchObject({ kind: "page", surfaceId: tabId });
    expect(restored.kind === "page" && restored.sessionId).not.toBe(sessionId);
    expect(page.page.isClosed()).toBe(true);
    expect((await j.row(sessionId))?.state).toBe("failed");
    expect(
      restored.kind === "page" &&
        home.service.pageInventory(restored.sessionId)?.records.get(tabId)?.documentId,
    ).not.toBe(original);
    // The report that carried the note may not have reached the person: until the client says
    // it showed it, every report, after every activation, carries it again.
    const activate = (key: string) =>
      j.tabs
        .get(j.task.userId, tabId)
        .then((row) => home.service.pageTabs.activate(j.task.userId, row!, key));
    const report = async () => (await home.service.resourcePools([j.task.runnerId]))[0];
    const reloaded = (noticeId: unknown) => [
      { surfaceId: tabId, noticeId, outcome: "reloaded", typed: "no" },
    ];
    expect((await report())?.pages).toEqual(reloaded(expect.any(String)));
    const noticeId = (await report())?.pages?.[0]?.noticeId;
    await activate("activate-retry");
    expect((await report())?.pages).toEqual(reloaded(noticeId));
    await home.service.poolNoticeSeen(j.task.userId, tabId, noticeId!);
    expect(await report()).not.toHaveProperty("pages");
    await activate("activate-later");
    expect(await report()).not.toHaveProperty("pages");
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
      await editVisibly(attached, watching, tabId, page.value, page.rendered);
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
    await until(async () =>
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
      await until(() => expect(watching.frames.length).toBeGreaterThan(0));
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
      await until(async () =>
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
    await until(() => expect(page.page.isClosed()).toBe(true));
  } finally {
    await j.close();
  }
});

it("parks under a running Trigger and a live Watch with no browser, and is vetoed while each holds one", async () => {
  const j = await journey("program-journey");
  let closeApp: (() => Promise<unknown>) | undefined;
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

    // Each program connects through its real CDP route, over a WebSocket: the demand wakes the
    // browser, the open connection vetoes the park, and once the program closes its socket the
    // route lets go of the attachment and the session it owns, and the browser parks.
    const fastify = requireFromHost("fastify") as (options: object) => FastifyLike;
    const websocket = requireFromHost("@fastify/websocket") as unknown;
    const app = fastify({ logger: false });
    await app.register(websocket);
    const scopes = new Map<string, unknown>([
      [
        "trigger-token-0123456789abcdef",
        {
          occurrenceId: occurrence.id,
          environmentId: j.task.environmentId,
          requestedBy: j.task.userId,
        },
      ],
      [
        "watch-token-0123456789abcdef",
        {
          activationId: activation!.id,
          environmentId: j.task.environmentId,
          createdBy: j.task.userId,
          exp: Math.floor(Date.now() / 1000) + 3_600,
        },
      ],
    ]);
    const tokens = {
      authenticate: async (token: string) => {
        const scope = scopes.get(token);
        if (!scope) throw new Error("Unknown token.");
        return scope;
      },
    };
    registerTriggerCdpBridge(app as never, home.service, tokens as never);
    registerWatchCdpBridge(app as never, home.service, tokens as never);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const origin = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const connect = async (token: string, path: string, bindingId: string) => {
      const socket = new WebSocket(`${origin}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      // A command answered means the route has attached its owned session.
      socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      await new Promise<void>((resolve) => socket.once("message", () => resolve()));
      const [session] = await j.database
        .selectFrom("browserSessionAttachments")
        .select("sessionId")
        .where("agentBindingId", "=", bindingId)
        .execute();
      return {
        session: session!.sessionId,
        close: async () => {
          socket.close();
          await until(async () => {
            expect(
              await j.database
                .selectFrom("browserSessionAttachments")
                .select("sessionId")
                .where("agentBindingId", "=", bindingId)
                .execute(),
            ).toEqual([]);
            expect((await j.row(session!.sessionId))?.state).toBe("closed");
            expect(home.coordinator.gate.held).toBe(0);
          });
        },
      };
    };
    closeApp = () => app.close();
    // The Trigger's attachment cleanup fails after doing its work: the session it owns still ends.
    const attach = home.service.attachCdpForAgent.bind(home.service);
    const failingCleanup = vi
      .spyOn(home.service, "attachCdpForAgent")
      .mockImplementation(async (...args) => {
        const attached = await attach(...args);
        return {
          ...attached,
          pooledClose: async () => {
            await attached.pooledClose?.();
            throw new Error("The attachment cleanup failed.");
          },
        };
      });
    const triggerBrowser = await connect(
      "trigger-token-0123456789abcdef",
      hostInternalRoutePaths.triggerCdp,
      trigger.agentBindingId,
    );
    expect((await j.row(triggerBrowser.session))?.origin).toBe("trigger");
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    await triggerBrowser.close();
    failingCleanup.mockRestore();
    expect(await home.coordinator.tryPark()).toBe("parked");
    const watchBrowser = await connect(
      "watch-token-0123456789abcdef",
      hostInternalRoutePaths.watchCdp,
      watcher.agentBindingId,
    );
    expect(await home.coordinator.tryPark()).toBe("vetoed");
    await watchBrowser.close();
    expect(await home.coordinator.tryPark()).toBe("parked");
    expect(j.controller.effects).toEqual(["start", "pause", "resume", "pause", "resume", "pause"]);
  } finally {
    await closeApp?.();
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
    await until(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
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
      await editVisibly(attached, watching, tabId, page.value, page.rendered);
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
    await until(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
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
      await editVisibly(attached, watching, tabId, page.value, page.rendered);
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
    await until(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    await until(() => expect(home.coordinator.gate.phase).toBe("open"));
    expect((await j.row(sessionId))?.state).toBe("failed");
    await until(() => expect(page.page.isClosed()).toBe(true));
    expect(await listBrowserPoolDocumentLosses(j.database, j.task.userId, tabId)).toMatchObject([
      { sessionId, surfaceId: tabId, reason: "not-adopted" },
    ]);
  } finally {
    j.runnerUp();
    await j.close();
  }
});

/** Every removal dependency but the store and the browser does nothing, as nothing else runs. */
function removalDependencies(
  store: unknown,
  browser: unknown,
  extra: Record<string, unknown> = {},
) {
  const passive: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : passive),
    apply: (_target, _this, args: unknown[]) => {
      const last = args.at(-1);
      return typeof last === "function" ? (last as () => unknown)() : Promise.resolve(undefined);
    },
  });
  const real: Record<string, unknown> = { store, browser, ...extra };
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
    // The revoke disconnects the Runner before the browser hears of the removal, as for real.
    await removeDevice(
      removalDependencies(j.store, home.service, {
        runners: { revoke: async () => j.runnerDown() },
      }),
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

it("lets every service call made while the Runner is away wait for it, never refuse as unavailable", async () => {
  const j = await journey("runner-away-calls");
  try {
    const home = await j.startHome();
    const { sessionId, tabId } = await home.service.openTab(j.task.userId, j.command("away"));
    j.runnerDown();
    await until(() => expect(home.coordinator.gate.phase).toBe("reconnecting"));
    // A placement read reports the browser; it does not throw.
    expect((await home.service.resourcePools([j.task.runnerId]))[0]).toMatchObject({
      runnerId: j.task.runnerId,
    });
    // An attach, an open and an activate made now wait for the Runner.
    const watching = j.viewer(home, sessionId, "watch");
    const opening = home.service.openTab(j.task.userId, j.command("away-open"));
    const activating = home.service.pageTabs.activate(
      j.task.userId,
      (await j.tabs.get(j.task.userId, tabId))!,
      "away-activate",
    );
    j.runnerUp();
    (await watching.attaching).close();
    expect(await opening).toMatchObject({ tabId: expect.any(String) });
    expect(await activating).toMatchObject({ kind: "page", sessionId });
    expect((await j.row(sessionId))?.state).toBe("ready");
  } finally {
    j.runnerUp();
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
      pages: [{ surfaceId: tabId, outcome: "lost", typed: "unknown" }],
    });
    expect(restarted).not.toHaveProperty("failures");
    expect((await j.row(sessionId))?.state).toBe("failed");
    // Reopened, the page came back by reloading, under the same note; once seen, it is no
    // longer reported.
    const noticeId = (await report())?.pages?.[0]?.noticeId;
    expect(noticeId).toEqual(expect.any(String));
    await home.service.pageTabs.activate(
      j.task.userId,
      (await j.tabs.get(j.task.userId, tabId))!,
      "report-reopen",
    );
    expect((await report())?.pages).toEqual([
      { surfaceId: tabId, noticeId, outcome: "reloaded", typed: "unknown" },
    ]);
    await home.service.poolNoticeSeen(j.task.userId, tabId, noticeId!);
    expect(await report()).not.toHaveProperty("pages");
  } finally {
    await j.close();
  }
});
