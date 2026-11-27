import { createId } from "@opensteer/core";
import { BrowserRuntime, type BrowserAttachment } from "@opensteer/browser-runtime-core";
import {
  FakeIsolatingLauncher,
  FakeContext,
  FakePage,
} from "@opensteer/browser-runtime-core/test-support";
import {
  AgentConnectionStore,
  beginAgentSession,
  TabStore,
  withoutDatabaseOperationSignal,
  type DatabaseSchema,
} from "@opensteer/database";
import { TabService } from "../tabs/tab-service.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "@opensteer/database/test-support/store";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { BrowserAttachTicketClaimsSchema, type InitialPageReady } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { BrowserLocalProfiles } from "./browser-local-profiles.js";
import { BrowserService, type BrowserRuntimeConnection } from "./browser-service.js";
import { BrowserAttachTicketSigner } from "./browser-ticket.js";
import type { RunToolScope } from "../agents/run-tool-tokens.js";

class RuntimeConnection extends EventEmitter implements BrowserRuntimeConnection {
  readyState = 1;
  initialPage: InitialPageReady | undefined;
  readonly attachment: Promise<BrowserAttachment>;
  readonly commands: string[] = [];
  constructor(runtime: BrowserRuntime, ticket: string) {
    super();
    this.attachment = Promise.resolve()
      .then(() =>
        runtime.attach(ticket, {
          sendFrame: async () => {},
          sendServer: async (message) => {
            if (this.readyState === 1)
              this.emit("message", Buffer.from(JSON.stringify(message)), false);
          },
        }),
      )
      .then((attachment) => {
        this.initialPage = attachment.initialPage;
        return attachment;
      });
    void this.attachment.catch((error) => this.emit("error", error));
  }
  send(data: string, _options: { binary: false }, callback: (error?: Error) => void): void {
    const message = JSON.parse(data) as { command?: { method: string } };
    if (message.command) this.commands.push(message.command.method);
    void this.attachment
      .then((attachment) => {
        callback();
        return attachment.handle(data);
      })
      .catch((error) => {
        this.emit("error", error);
      });
  }
  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    void this.attachment
      .then(
        (attachment) => attachment.close(),
        () => undefined,
      )
      .finally(() => this.emit("close", 1000, Buffer.from("closed")));
  }
  terminate(): void {
    this.close();
  }
}
const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);
integration("page tab adapter", () => {
  it("binds live pages as they are, ends a closed tab's page and loads it again on reopen, and restores an ended session once without changing membership", async () => {
    const fixture = await createStoreFixture(),
      f = await fixture.startRunFixture("page-tabs");
    const root = await mkdtemp(join(tmpdir(), "opensteer-tab-runtime-"));
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();
    const tabs = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const launcher = new FakeIsolatingLauncher();
    const runtime = new BrowserRuntime({
      runtimeId: "tabs-test",
      launcher,
      sessionFilesRoot: root,
      ticketVerifier: {
        verify: async (token) =>
          BrowserAttachTicketClaimsSchema.parse(
            JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()),
          ),
      },
    });
    const connections: RuntimeConnection[] = [],
      errors: unknown[] = [];
    const browser = new BrowserService({
      deploymentId: f.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      repository: personalBrowserRepository(store),
      tabs,
      tabPlaces: { write: async () => false, notice: () => {} },
      signer: new BrowserAttachTicketSigner({
        keyId: "test",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      }),
      onSessionsChanged: () => {},
      onError: (error) => errors.push(error),
      targetResolver: {
        placements: () => [
          {
            kind: "runner",
            runnerId: f.runnerId,
            runtimeId: "tabs-test",
            label: "Computer",
            available: true,
            agents: true,
            environmentIds: [f.environmentId],
          },
        ],
        resolve: (placement) =>
          placement.runnerId === f.runnerId
            ? {
                runtimeId: "tabs-test",
                placementKey: "test",
                cdpBoundary: true,
                sharedControl: true,
                targetControl: true,
                surfaceState: 1,
                tabRestoreVersion: true,
                connect: (ticket) => {
                  const connection = new RuntimeConnection(runtime, ticket);
                  connections.push(connection);
                  return connection;
                },
              }
            : undefined,
      },
    });
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        await browser.close();
        await runtime.shutdown();
        await rm(root, { recursive: true, force: true });
      },
    }));
    const claims: RunToolScope = {
      aud: "opensteer-run-tools",
      iss: "opensteer-host",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: randomUUID(),
      requestedBy: f.userId,
      threadId: f.threadId,
      runId: f.runId,
      environmentId: f.environmentId,
      runnerId: f.runnerId,
      runnerBootId: f.runnerBootId,
      bindingGeneration: f.bindingGeneration,
    };
    const actor = { kind: "run", claims } as const;
    const descriptor = await browser.pageTabs.open(
      actor,
      { kind: "page", url: "https://example.com/saved", guest: true },
      "page",
    );
    const initialContext = [...launcher.browsersByPartition.values()].at(-1)!
      .context as FakeContext;
    const initialOpener = initialContext.pages()[0]!;
    initialContext.addPage(
      new FakePage({
        opener: initialOpener,
        title: "Initial popup",
        url: "https://example.com/initial-popup",
      }),
    );
    await vi.waitFor(
      () =>
        expect(
          [...browser.pageInventory(descriptor.pageBinding!.sessionId)!.records.values()].some(
            (page) => page.url === "https://example.com/initial-popup",
          ),
        ).toBe(true),
      { timeout: 3000 },
    );
    await browser.flushPendingTabDescriptors();
    expect((await tabs.snapshot(f.userId)).rows).toEqual([]);
    await tabs.open(descriptor, "page");
    await browser.pageTabs.admitted!(descriptor);
    expect(
      (await tabs.snapshot(f.userId)).rows.some(
        (page) => page.url === "https://example.com/initial-popup",
      ),
    ).toBe(true);
    let row = await tabs.get(f.userId, descriptor.id);
    if (!row) throw new Error("Admitted page missing");
    const first = await withTimeout(browser.bindPage(claims, row), 3000, {
      timeoutError: () => new Error("Live page bind did not complete"),
    });
    expect(first).toMatchObject({
      tabId: row.id,
      sessionId: row.pageBinding!.sessionId,
      reloaded: false,
    });
    // Z1: the runtime is asked, never this Home's copy of the tab's state; it woke nothing.
    expect(connections.flatMap((connection) => connection.commands)).toContain(
      "Opensteer.resumeTab",
    );
    expect(
      await browser.signInTarget({ ownerId: f.userId, tabId: row.id, sessionId: first.sessionId }),
    ).toMatchObject({ tabId: row.id });
    let viewerOpen = true;
    const viewer = await browser.attach(
      f.userId,
      first.sessionId,
      {
        id: "viewer",
        isOpen: () => viewerOpen,
        close: () => {
          viewerOpen = false;
        },
        send: async () => {},
      },
      { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
    );
    await viewer.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: row.id, frames: false })),
      false,
    );
    const siblingWrite = await browser.pageTabs.open(
      actor,
      { kind: "page", url: "https://example.com/sibling", guest: true },
      "sibling",
    );
    await tabs.open(siblingWrite, "sibling");
    await browser.pageTabs.admitted!(siblingWrite);
    const sibling = (await tabs.get(f.userId, siblingWrite.id))!;
    expect(sibling.pageBinding?.sessionId).toBe(first.sessionId);
    const oldRow = row;
    // The person closes the tab the Run holds, by the person's route: as in a regular browser, its
    // page ends, whoever opened it and whatever holds it.
    const personTabs = new TabService({
      store: tabs,
      pages: browser.pageTabs,
      nativeTargets: { onTargetAcquired: () => () => undefined },
      authorizeMembership: async () => undefined,
      onError: (error: unknown) => {
        throw error;
      },
    } as never);
    expect(
      (await personTabs.close({ kind: "person", ownerId: f.userId }, [row.id], "close-held"))
        .closed,
    ).toEqual([row.id]);
    await expect(
      viewer.handle(
        Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: row.id, frames: false })),
        false,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await browser.signInTarget({ ownerId: f.userId, tabId: row.id, sessionId: first.sessionId }),
    ).toBeNull();
    expect(connections.flatMap((connection) => connection.commands)).toContain(
      "Opensteer.closeTab",
    );
    expect(
      [...browser.pageInventory(first.sessionId)!.records.values()].some(
        (page) => page.url === "https://example.com/saved",
      ),
    ).toBe(false);
    // Reopening loads the address again: a new page, the same tab.
    await tabs.reopen(f.userId, row.id, "reopen");
    row = (await tabs.get(f.userId, row.id))!;
    const reopened = await withTimeout(browser.bindPage(claims, row), 3000, {
      timeoutError: () => new Error("The reopened tab did not load again"),
    });
    expect(reopened).toMatchObject({ tabId: row.id, reloaded: true });
    // Its old page is gone, so it loads in a session of its own; the sibling stays in the first.
    expect(reopened.sessionId).not.toBe(first.sessionId);
    row = (await tabs.get(f.userId, row.id))!;
    let nextViewerOpen = true;
    const nextViewer = await browser.attach(
      f.userId,
      reopened.sessionId,
      {
        id: "next-viewer",
        isOpen: () => nextViewerOpen,
        close: () => {
          nextViewerOpen = false;
        },
        send: async () => {},
      },
      { authSessionId: createId("authSession"), mode: "control", signedIn: async () => true },
    );
    await nextViewer.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: row.id, frames: false })),
      false,
    );
    await browser.pageTabs.closeViewers(f.userId, oldRow);
    expect(viewerOpen).toBe(false);
    expect(nextViewerOpen).toBe(true);
    viewer.close();
    nextViewer.close();
    await browser.stop(f.userId, reopened.sessionId);
    await browser.stop(f.userId, first.sessionId);
    expect(await tabs.get(f.userId, row.id)).toMatchObject({ id: row.id, generation: 3 });
    const restored = await withTimeout(browser.bindPage(claims, row), 3000, {
      timeoutError: () => new Error("Page restoration did not complete"),
    });
    expect(restored.tabId).toBe(row.id);
    expect([first.sessionId, reopened.sessionId]).not.toContain(restored.sessionId);
    expect(restored.reloaded).toBe(true);
    expect((await browser.bindPage(claims, (await tabs.get(f.userId, row.id))!)).reloaded).toBe(
      false,
    );
    const restoredContext = [...launcher.browsersByPartition.values()].at(-1)!
      .context as FakeContext;
    const siblingRestored = await browser.bindPage(claims, sibling);
    expect(siblingRestored.sessionId).not.toBe(restored.sessionId);
    // The first session, the reopened tab's, and one restore for each tab.
    expect(connections).toHaveLength(4);
    const context = restoredContext;
    const opener = context.pages()[0] as FakePage;
    opener.navigate("https://example.com/after-sibling", "A after sibling restoration");
    context.addPage(
      new FakePage({ opener, title: "Popup after sibling", url: "https://example.com/popup" }),
    );
    await vi.waitFor(
      async () => {
        await browser.flushPendingTabDescriptors();
        expect((await tabs.get(f.userId, row.id))?.url).toBe("https://example.com/after-sibling");
        expect(
          (await tabs.snapshot(f.userId)).rows.some(
            (row) => row.url === "https://example.com/popup",
          ),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
    expect((await tabs.snapshot(f.userId)).rows).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  async function createConnectedTabFixture(label: string) {
    const fixture = await createStoreFixture(),
      f = await fixture.startRunFixture(label);
    const root = await realpath(await mkdtemp(join(tmpdir(), "opensteer-tab-holder-")));
    const { database, store } = fixture;
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();
    const profile = await store.createBrowserProfile({
      name: "Connected profile",
      ownerId: f.userId,
      homeRunnerId: f.runnerId,
      idempotencyKey: `${label}-profile`,
    });
    const personProfile = await store.createBrowserProfile({
      name: "Person profile",
      ownerId: f.userId,
      homeRunnerId: f.runnerId,
      idempotencyKey: `${label}-person-profile`,
    });
    const connections = new AgentConnectionStore(database as unknown as Kysely<DatabaseSchema>);
    const connection = await connections.create({
      userId: f.userId,
      label: "Connected agent",
      clientName: "Connected agent",
      accessMode: "full-access",
      grant: { scope: "everything" },
      resource: "https://connected.test/mcp",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await connections.activate(connection.id, randomUUID())).toBe(true);
    const { session } = await beginAgentSession(database as unknown as Kysely<DatabaseSchema>, {
      userId: f.userId,
      agentConnectionId: connection.id,
    });
    const sessionBinding = `session:${session.id}`;
    const tabsStore = new TabStore(database as unknown as Kysely<DatabaseSchema>);
    const launcher = Object.assign(new FakeIsolatingLauncher(), {
      localProfiles: {
        engine: "chromium" as const,
        createFiles: async () => undefined,
        release: async () => "released" as const,
      },
    });
    const runtime = new BrowserRuntime({
      runtimeId: "tabs-holder-test",
      launcher,
      localProfiles: { root: join(root, "profiles") },
      sessionFilesRoot: join(root, "session-files"),
      ticketVerifier: {
        verify: async (token) =>
          BrowserAttachTicketClaimsSchema.parse(
            JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()),
          ),
      },
    });
    await runtime.prepare();
    const errors: unknown[] = [];
    const computerId = await store.requireSelfDeviceId(f.runnerId);
    let tabService: TabService | undefined;
    let closing = false;
    const seenFirstUsedBy = new Map<string, { taskId: string; since?: string | undefined }[]>();
    const observePublish = async () => {
      if (!tabService || closing) return;
      const state = await tabService.bootstrap(f.userId, 240 * 1024);
      for (const tab of state.tabs) {
        if (!seenFirstUsedBy.has(tab.tabId)) seenFirstUsedBy.set(tab.tabId, tab.usedBy);
      }
    };
    const observations: Promise<void>[] = [];
    const baseRepository = personalBrowserRepository(store);
    const faults = { failOpenerVisibility: false, rejectAuthorize: false };
    const browser = new BrowserService({
      deploymentId: f.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      repository: new Proxy(baseRepository, {
        get: (target, property, receiver) => {
          if (property === "authorizedPlaceThreadIds") {
            return async (ownerId: typeof f.userId, threadIds: readonly string[]) => {
              if (faults.failOpenerVisibility) throw new Error("opener visibility failed");
              return (await target.authorizedPlaceThreadIds?.(ownerId, threadIds as never)) ?? [];
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      localProfiles: new BrowserLocalProfiles({
        deploymentId: f.deploymentId,
        baseUrl: new URL("http://127.0.0.1"),
        repository: store,
      }),
      tabs: tabsStore,
      tabPlaces: { write: async () => false, notice: () => {} },
      signer: new BrowserAttachTicketSigner({
        keyId: "test",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      }),
      onTabsChanged: (ownerId, ids) => {
        tabService?.changed(ownerId, ids);
        observations.push(withoutDatabaseOperationSignal(() => observePublish()));
      },
      onSessionsChanged: () => {},
      onError: (error) => errors.push(error),
      targetResolver: {
        placements: () => [
          {
            kind: "runner",
            runnerId: f.runnerId,
            runtimeId: "tabs-holder-test",
            label: "Computer",
            available: true,
            agents: true,
            environmentIds: [f.environmentId],
          },
        ],
        resolve: (placement) =>
          placement.runnerId === f.runnerId
            ? {
                runtimeId: "tabs-holder-test",
                placementKey: "test",
                localProfileStorage: runtime.localProfileStorage!,
                cdpBoundary: true,
                sharedControl: true,
                targetControl: true,
                surfaceState: 1,
                tabRestoreVersion: true,
                connect: (ticket) => new RuntimeConnection(runtime, ticket),
              }
            : undefined,
      },
    });
    tabService = new TabService({
      store: tabsStore,
      devices: store,
      pages: browser.pageTabs,
      nativeTargets: {
        onTargetAcquired: () => () => undefined,
        windowState: async () => ({ state: "asleep", usedBy: [] }),
        phoneState: async () => ({ state: "asleep", usedBy: [] }),
        openOwnerView: async () => {
          throw new Error("unexpected");
        },
        closeOwnerViews: async () => undefined,
        resolveWindow: async () => {
          throw new Error("unexpected");
        },
      },
      apps: {
        get: async () => {
          throw new Error("unexpected");
        },
      },
      computer: async () => ({
        name: "Computer",
        connected: true,
        removed: false,
        selfRunnerId: f.runnerId,
      }),
      canRead: async () => true,
      canReadTask: async () => true,
      authorize: async () => {
        if (faults.rejectAuthorize) throw new Error("tab admission refused");
      },
      authorizeMembership: async () => undefined,
      onError: (error) => errors.push(error),
    });
    await ownTestDatabaseProducer(fixture.databaseUrl, async () => ({
      close: async () => {
        closing = true;
        await Promise.allSettled(observations);
        tabService?.dispose();
        await browser.close();
        await runtime.shutdown();
        await rm(root, { recursive: true, force: true });
      },
    }));
    const agentActor = {
      kind: "browser-binding" as const,
      authority: { ownerId: f.userId, agentBindingId: sessionBinding },
      threadId: session.threadId,
    };
    return {
      f,
      profile,
      personProfile,
      session,
      sessionBinding,
      tabsStore,
      launcher,
      browser,
      tabService,
      agentActor,
      computerId,
      seenFirstUsedBy,
      observations,
      faults,
      errors,
    };
  }

  it("carries a connected agent session's holder on the very first tabs.state publish of a new page", async () => {
    const {
      f,
      profile,
      personProfile,
      session,
      sessionBinding,
      browser,
      tabService,
      agentActor,
      computerId,
      seenFirstUsedBy,
      observations,
      errors,
    } = await createConnectedTabFixture("connected-holder-first-publish");

    // Warm the person's tabs.state catalog before the connected agent opens anything.
    expect((await tabService.bootstrap(f.userId, 240 * 1024)).tabs).toEqual([]);

    // 1) New agent session: the very first publish after tabs.open (before bindBrowserScript) carries usedBy.
    const openedNewSession = await tabService.open(
      agentActor,
      { kind: "page", profileId: profile.id, url: "https://example.com/new-session" },
      "connected-new-session",
    );
    await Promise.all(observations.splice(0));
    const afterNewSession = await tabService.bootstrap(f.userId, 240 * 1024);
    const firstTab = afterNewSession.tabs.find((tab) => tab.tabId === openedNewSession.tab.tabId);
    expect(openedNewSession.tab.usedBy).toEqual([
      { taskId: session.threadId, since: expect.any(String) },
    ]);
    expect(firstTab?.usedBy).toEqual([{ taskId: session.threadId, since: expect.any(String) }]);
    expect(seenFirstUsedBy.get(openedNewSession.tab.tabId)).toEqual([
      { taskId: session.threadId, since: expect.any(String) },
    ]);

    // 2) Reused person session: #flushTabDescriptors writes the tab row inside openTab; first publish still carries usedBy.
    const personOpened = await tabService.open(
      { kind: "person", ownerId: f.userId },
      { kind: "page", profileId: personProfile.id, url: "https://example.com/person-first" },
      "person-first",
    );
    expect(personOpened.tab.computer.computerId).toBe(computerId);
    await Promise.all(observations.splice(0));
    seenFirstUsedBy.clear();

    const openedInPersonSession = await tabService.open(
      agentActor,
      { kind: "page", profileId: personProfile.id, url: "https://example.com/in-person-session" },
      "connected-in-person-session",
    );
    await Promise.all(observations.splice(0));
    const afterPersonSession = await tabService.bootstrap(f.userId, 240 * 1024);
    const secondTab = afterPersonSession.tabs.find(
      (tab) => tab.tabId === openedInPersonSession.tab.tabId,
    );
    expect(openedInPersonSession.tab.usedBy).toEqual([
      { taskId: session.threadId, since: expect.any(String) },
    ]);
    expect(secondTab?.usedBy).toEqual([{ taskId: session.threadId, since: expect.any(String) }]);
    expect(seenFirstUsedBy.get(openedInPersonSession.tab.tabId)).toEqual([
      { taskId: session.threadId, since: expect.any(String) },
    ]);

    // 3) Releasing holds clears usedBy again.
    browser.releaseHolds(sessionBinding);
    const afterRelease = await tabService.bootstrap(f.userId, 240 * 1024);
    expect(
      afterRelease.tabs.find((tab) => tab.tabId === openedNewSession.tab.tabId)?.usedBy,
    ).toEqual([]);
    expect(
      afterRelease.tabs.find((tab) => tab.tabId === openedInPersonSession.tab.tabId)?.usedBy,
    ).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("rolls back a connected agent's open hold when openTab rejects after writing the tab row or before admission", async () => {
    const {
      f,
      profile,
      personProfile,
      session,
      tabService,
      agentActor,
      observations,
      faults,
      errors,
    } = await createConnectedTabFixture("connected-holder-rollback");

    // Seed a live person browser and a held agent tab on another profile.
    const personBase = await tabService.open(
      { kind: "person", ownerId: f.userId },
      { kind: "page", profileId: personProfile.id, url: "https://example.com/person-base" },
      "person-base",
    );
    const heldTab = await tabService.open(
      agentActor,
      { kind: "page", profileId: profile.id, url: "https://example.com/existing-held" },
      "existing-held",
    );
    await Promise.all(observations.splice(0));

    // 1) Reused person browser: runtime reply + catalog write succeed, then opener-visibility read throws.
    faults.failOpenerVisibility = true;
    await expect(
      tabService.open(
        agentActor,
        { kind: "page", profileId: personProfile.id, url: "https://example.com/rejected-open" },
        "connected-rejected-open",
      ),
    ).rejects.toThrow("Opening did not confirm its outcome");
    faults.failOpenerVisibility = false;
    await Promise.all(observations.splice(0));
    const afterRejectedOpen = await tabService.bootstrap(f.userId, 240 * 1024);
    const rejectedTab = afterRejectedOpen.tabs.find(
      (tab) => tab.tabId !== personBase.tab.tabId && tab.tabId !== heldTab.tab.tabId,
    );
    expect(rejectedTab).toBeDefined();
    expect(rejectedTab?.usedBy).toEqual([]);

    // 2) TabStore.open authorization refusal also rolls back only the hold that open installed.
    faults.rejectAuthorize = true;
    await expect(
      tabService.open(
        agentActor,
        { kind: "page", profileId: personProfile.id, url: "https://example.com/unadmitted-open" },
        "connected-unadmitted-open",
      ),
    ).rejects.toThrow("tab admission refused");
    faults.rejectAuthorize = false;
    await Promise.all(observations.splice(0));
    const afterUnadmitted = await tabService.bootstrap(f.userId, 240 * 1024);
    const unadmittedTab = afterUnadmitted.tabs.find(
      (tab) =>
        tab.tabId !== personBase.tab.tabId &&
        tab.tabId !== heldTab.tab.tabId &&
        tab.tabId !== rejectedTab!.tabId,
    );
    expect(unadmittedTab?.usedBy ?? []).toEqual([]);
    expect(afterUnadmitted.tabs.find((tab) => tab.tabId === heldTab.tab.tabId)?.usedBy).toEqual([
      { taskId: session.threadId, since: expect.any(String) },
    ]);
    expect(errors).toEqual([]);
  });

  it("carries a connected agent's holder on the first tabs.state publish of a script popup, and none on a person popup", async () => {
    const {
      f,
      profile,
      personProfile,
      session,
      sessionBinding,
      tabsStore,
      launcher,
      browser,
      tabService,
      agentActor,
      seenFirstUsedBy,
      observations,
      errors,
    } = await createConnectedTabFixture("connected-holder-popups");

    await tabService.open(
      agentActor,
      { kind: "page", profileId: profile.id, url: "https://example.com/agent-opener" },
      "agent-opener",
    );
    await tabService.open(
      { kind: "person", ownerId: f.userId },
      { kind: "page", profileId: personProfile.id, url: "https://example.com/person-opener" },
      "person-opener",
    );
    await Promise.all(observations.splice(0));
    seenFirstUsedBy.clear();

    const allContexts = [...launcher.browsersByPartition.values()].map(
      (entry) => entry.context as FakeContext,
    );
    const agentContext = allContexts[0]!;
    const agentOpener = agentContext.pages()[0] as FakePage;
    agentContext.addPage(
      new FakePage({
        opener: agentOpener,
        title: "Connected popup",
        url: "https://example.com/connected-popup",
      }),
    );
    await vi.waitFor(
      async () => {
        await browser.flushPendingTabDescriptors();
        expect(
          (await tabsStore.snapshot(f.userId)).rows.some(
            (row) => row.url === "https://example.com/connected-popup",
          ),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
    await Promise.all(observations.splice(0));
    const afterAgentPopup = await tabService.bootstrap(f.userId, 240 * 1024);
    const agentPopupTab = afterAgentPopup.tabs.find(
      (tab) => tab.kind === "page" && tab.url === "https://example.com/connected-popup",
    );
    expect(agentPopupTab?.usedBy).toEqual([
      { taskId: session.threadId, since: expect.any(String) },
    ]);
    expect(seenFirstUsedBy.get(agentPopupTab!.tabId)).toEqual([
      { taskId: session.threadId, since: expect.any(String) },
    ]);

    const personContext = allContexts[1]!;
    const personOpener = personContext.pages()[0] as FakePage;
    personContext.addPage(
      new FakePage({
        opener: personOpener,
        title: "Person popup",
        url: "https://example.com/person-popup",
      }),
    );
    await vi.waitFor(
      async () => {
        await browser.flushPendingTabDescriptors();
        expect(
          (await tabsStore.snapshot(f.userId)).rows.some(
            (row) => row.url === "https://example.com/person-popup",
          ),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
    await Promise.all(observations.splice(0));
    const afterPersonPopup = await tabService.bootstrap(f.userId, 240 * 1024);
    const personPopupTab = afterPersonPopup.tabs.find(
      (tab) => tab.kind === "page" && tab.url === "https://example.com/person-popup",
    );
    expect(personPopupTab?.usedBy).toEqual([]);
    expect(seenFirstUsedBy.get(personPopupTab!.tabId)).toEqual([]);

    browser.releaseHolds(sessionBinding);
    const afterRelease = await tabService.bootstrap(f.userId, 240 * 1024);
    expect(afterRelease.tabs.find((tab) => tab.tabId === agentPopupTab!.tabId)?.usedBy).toEqual([]);
    expect(errors).toEqual([]);
  });
});
