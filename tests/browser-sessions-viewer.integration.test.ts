import { seedBrowserSession } from "../packages/client/src/test-support/browser-snapshot.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { browserInventory } from "./browser-sessions.test-support.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import {
  nextJson,
  startBrowserRuntime,
} from "../apps/host/src/browser/browser-runtime.test-support.js";
import { WebSocket } from "../apps/host/src/browser/browser-watch-e2e.test-support.js";
import { injectRpcRequest } from "../apps/host/src/server/test-host-api-request.js";
import { type LaunchedBrowser } from "../packages/browser-runtime-core/src/index.js";
import { seedBrowserSnapshot } from "../packages/client/src/test-support/browser-snapshot.js";
import type { BrowserSessionSummary, HostSnapshot } from "../packages/client/src/host/client.js";
import {
  HttpHostClient,
  type WebSocketClient,
} from "../packages/client/src/host/host-session-client.js";
import { placeList } from "../packages/client/src/host/places.js";
import { createId, ModelSelectionSchema, UserIdSchema } from "../packages/core/src/index.js";
import {
  BrowserServerMessageSchema,
  BrowserSessionIdSchema,
} from "../packages/protocol/src/browser.js";
import {
  addCleanup,
  browserAvailable,
  deployment,
  enrollBrowserComputer,
  killChromium,
  run,
  startBrowser,
  waitFor,
} from "./browser-deployment.test-support.js";
import {
  describeViewerEntry,
  loadingSite,
  openBrowserView,
  popupDialogSite,
  recordBrowserView,
  sizeReportingSite,
  startPersonBrowser,
  waitForBrowserClosing,
  waitForBrowserFrame,
  waitForBrowserFrameAt,
  writeViewReport,
  type ViewerEntry,
} from "./browser-sessions.test-support.js";

function holdAdmittedTabOpen(
  store: Awaited<ReturnType<typeof deployment>>["host"]["store"],
  idempotencyKey: string,
) {
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const bind = store.bindBrowserTabOpen.bind(store);
  const spy = vi.spyOn(store, "bindBrowserTabOpen").mockImplementation(async (input) => {
    const result = await bind(input);
    if (input.binding.idempotencyKey === idempotencyKey) {
      admitted.resolve();
      await withTimeout(release.promise, 5_000, {
        timeoutError: () => new Error("The admitted tab open was not released"),
      });
    }
    return result;
  });
  return {
    waitForAdmission: () =>
      withTimeout(admitted.promise, 5_000, {
        timeoutError: () => new Error("The tab open was not admitted"),
      }),
    release: () => release.resolve(),
    restore: () => spy.mockRestore(),
  };
}

run("Browser Sessions through a whole deployment", () => {
  it.each(["close-before-admission", "admitted-before-close", "open-before-close"] as const)(
    "verifies the explicit %s tab interleaving without losing or resurrecting durable rows",
    async (order) => {
      const browser = await startBrowser();
      addCleanup("interleaving Browser Runtime", () => browser.close());
      const stack = await deployment(browser);
      await browserAvailable(stack);
      const owner = await stack.host.store.firstUser();
      if (!owner) throw new Error("Missing owner");
      const sessionId = BrowserSessionIdSchema.parse(
        await startPersonBrowser(stack, { viewport: { height: 700, width: 1000 } }),
      );
      const initial = await browserInventory(stack, sessionId);
      expect(initial.tabs).toHaveLength(1);
      const command = {
        type: "browser.tab.open" as const,
        sessionId,
        idempotencyKey: randomUUID(),
      };
      const close = () =>
        stack.api["commands.dispatch"]({
          type: "browser.tab.close",
          sessionId,
          surfaceId: initial.tabs[0]!.id,
          inventoryRevision: initial.inventoryRevision,
          idempotencyKey: randomUUID(),
        });
      const barrier =
        order === "admitted-before-close"
          ? holdAdmittedTabOpen(stack.host.store, command.idempotencyKey)
          : null;
      let opening: Awaited<ReturnType<(typeof stack.api)["commands.dispatch"]>>;
      let closing: Awaited<ReturnType<typeof close>>;
      try {
        if (order === "close-before-admission") {
          closing = await close();
          opening = await stack.api["commands.dispatch"](command);
        } else if (order === "admitted-before-close") {
          const pending = stack.api["commands.dispatch"](command);
          await barrier!.waitForAdmission();
          closing = await close();
          barrier!.release();
          opening = await pending;
        } else {
          opening = await stack.api["commands.dispatch"](command);
          closing = await close();
        }
      } finally {
        barrier?.release();
        barrier?.restore();
      }
      const replay = await stack.api["commands.dispatch"](command);
      const record = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      const rows = await stack.host.store.database
        .selectFrom("personalTabs")
        .select(["id", "closedAt", "state"])
        .where("sessionId", "=", sessionId)
        .orderBy("id")
        .execute();
      const binding = await stack.host.store.getBrowserTabOpen(owner.id, command.idempotencyKey);
      if (order === "open-before-close") {
        expect(opening).toMatchObject({ ok: true, data: { type: "browser.tab.open" } });
        expect(closing).toMatchObject({ ok: false, error: { reason: "stale-tab-inventory" } });
        expect(record?.state).toBe("ready");
        expect(rows).toHaveLength(2);
        if (!opening.ok || opening.data.type !== "browser.tab.open")
          throw new Error("The ordered open did not succeed");
        expect(rows.map((row) => row.id)).toEqual([initial.tabs[0]!.id, opening.data.tabId].sort());
        expect(rows.every((row) => row.closedAt === null && row.state === "live")).toBe(true);
        const inventory = await browserInventory(stack, sessionId);
        expect(inventory.tabs.map((tab) => tab.id).sort()).toEqual(rows.map((row) => row.id));
        expect(binding?.outcome.kind).toBe("opened");
      } else {
        expect(closing).toMatchObject({ ok: true, data: { outcome: "session-closed" } });
        expect(opening).toMatchObject({
          ok: false,
          error: {
            reason:
              order === "close-before-admission"
                ? "browser-session-closed"
                : "browser-tab-open-failed",
          },
        });
        expect(record?.state).toBe("closed");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(initial.tabs[0]!.id);
        expect(rows[0]!.closedAt).not.toBeNull();
        expect(binding?.outcome.kind).toBe(
          order === "close-before-admission" ? undefined : "failed",
        );
        await vi.waitFor(() => expect(browser.health().sessionCount).toBe(0), { timeout: 5_000 });
      }
      expect(replay).toEqual(opening);
      expect(
        await stack.host.store.database
          .selectFrom("personalTabs")
          .select(["id", "closedAt", "state"])
          .where("sessionId", "=", sessionId)
          .orderBy("id")
          .execute(),
      ).toEqual(rows);
    },
  );

  it("opens authoritative tabs without a viewer, replays keys, and fences last-tab close", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1000 } }),
    );
    const command = { type: "browser.tab.open" as const, sessionId, idempotencyKey: randomUUID() };
    const [first, retry] = await Promise.all([
      stack.api["commands.dispatch"](command),
      stack.api["commands.dispatch"](command),
    ]);
    if (!first.ok || first.data.type !== "browser.tab.open") throw new Error(JSON.stringify(first));
    const firstOpened = first.data;
    expect(retry).toEqual(first);
    const firstInventory = await browserInventory(stack, sessionId);
    expect(firstInventory.tabs).toHaveLength(2);
    expect(firstInventory.tabs.some((tab) => tab.id === firstOpened.tabId)).toBe(true);
    const mismatch = await stack.api["commands.dispatch"]({
      ...command,
      url: "https://example.com/",
    });
    expect(mismatch).toMatchObject({ ok: false, error: { code: "conflict" } });
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:secret@example.com/",
    ]) {
      const invalid = { ...command, url, idempotencyKey: randomUUID() };
      expect(await stack.api["commands.dispatch"](invalid)).toMatchObject({
        ok: false,
        error: { reason: "invalid-payload", retryable: false },
      });
      const response = await injectRpcRequest(stack.host.app, "commands.dispatch", invalid, {
        cookie: stack.sessionCookie,
        origin: stack.hostOrigin.origin,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<unknown>()).toMatchObject({ ok: false, error: { code: "bad_request" } });
    }
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing owner");
    await expect(
      stack.host.browser.openTab(UserIdSchema.parse(`usr_${randomUUID()}`), command),
    ).rejects.toMatchObject({ code: "not_found" });
    const closed = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: first.data.tabId,
      inventoryRevision: firstInventory.inventoryRevision,
      idempotencyKey: randomUUID(),
    });
    if (!closed.ok || closed.data.type !== "browser.tab.close")
      throw new Error(JSON.stringify(closed));
    expect(await stack.api["commands.dispatch"](command)).toMatchObject({
      ok: true,
      data: { tabId: first.data.tabId },
    });
    const site = await sizeReportingSite();
    addCleanup("test site", () => site.close());
    const client = new HttpHostClient({
      baseUrl: stack.hostOrigin,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", stack.sessionCookie);
        headers.set("origin", stack.hostOrigin.origin);
        return fetch(input, { ...init, headers });
      },
      webSocketFactory: (url) => {
        expect(url).not.toContain("/browser-sessions/");
        return new WebSocket(url, {
          headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
        }) as unknown as WebSocketClient;
      },
    });
    addCleanup("Host client", async () => client.dispose());
    const urlSessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1000 } }),
    );
    await client.load();
    const clientOpened = await client.openBrowserTab(urlSessionId, { url: site.origin });
    expect(
      (
        client
          .getSnapshot()
          .browserSessions.find((session) => session.id === clientOpened.sessionId)!
          .browserTabs?.sessionTabs(
            client
              .getSnapshot()
              .browserSessions.find((session) => session.id === clientOpened.sessionId)!.id,
          ) ?? []
      ).some((tab) => tab.id === clientOpened.tabId),
    ).toBe(true);
    await waitFor(
      async () =>
        (await client.readBrowserContextCandidate(urlSessionId, clientOpened.tabId)).url ===
        `${site.origin}/`,
      15_000,
    );
    await stack.host.browser.stop(owner.id, urlSessionId);
    const afterClose = await browserInventory(stack, sessionId);
    const last = afterClose.tabs[0]!;
    // Keep the open admitted but not sent to the Runtime when last-tab close wins.
    const raceKey = randomUUID();
    const barrier = holdAdmittedTabOpen(stack.host.store, raceKey);
    const openingRequest = stack.api["commands.dispatch"]({ ...command, idempotencyKey: raceKey });
    const racingClose = async () => {
      await barrier.waitForAdmission();
      try {
        return await stack.api["commands.dispatch"]({
          type: "browser.tab.close",
          sessionId,
          surfaceId: last.id,
          inventoryRevision: afterClose.inventoryRevision,
          idempotencyKey: randomUUID(),
        });
      } finally {
        barrier.release();
      }
    };
    const race = await Promise.all([racingClose(), openingRequest]).finally(() => {
      barrier.release();
      barrier.restore();
    });
    const closing = race[0];
    const opening = race[1];
    if (
      closing.ok &&
      closing.data.type === "browser.tab.close" &&
      closing.data.outcome === "session-closed"
    ) {
      expect(opening).toMatchObject({ ok: false, error: { reason: "browser-tab-open-failed" } });
      expect(
        await stack.api["commands.dispatch"]({ ...command, idempotencyKey: randomUUID() }),
      ).toMatchObject({ ok: false, error: { reason: "browser-session-closed" } });
    } else {
      expect(closing).toMatchObject({ ok: false, error: { reason: "stale-tab-inventory" } });
      expect(opening.ok).toBe(true);
    }
    await stack.host.browser.stop(owner.id, sessionId);
    expect(
      await stack.api["commands.dispatch"]({ ...command, idempotencyKey: randomUUID() }),
    ).toMatchObject({ ok: false, error: { reason: "browser-session-closed" } });
    expect(await stack.api["commands.dispatch"](command)).toMatchObject({
      ok: true,
      data: { tabId: first.data.tabId },
    });
    const directory =
      process.env.OPENSTEER_TAB_OPEN_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-tab-open-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "host-tab-open.json"),
      JSON.stringify(
        {
          first,
          retry,
          mismatch,
          race,
          clientOpened,
          sessionClosedAfterRace: true,
          noViewerRequired: true,
          invalidSchemesAndCredentialsRefused: true,
          outsiderRefused: true,
        },
        null,
        2,
      ),
    );
  }, 90_000);

  it("says a tab is loading only while its own page loads, through the catalog, and Stop ends it", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    const site = await loadingSite();
    addCleanup("test site", () => site.close());
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1000 } }),
    );
    const started = Date.now();
    const timeline: { at: number; step: string; loading: boolean | undefined }[] = [];
    const catalog = async () => {
      const read = await browserInventory(stack, sessionId);
      return read;
    };
    const tabOf = async (tabId: string) => (await catalog()).tabs.find((tab) => tab.id === tabId);
    const note = async (step: string, tabId: string) =>
      timeline.push({ at: Date.now() - started, step, loading: (await tabOf(tabId))?.loading });
    const until = async (step: string, tabId: string, loading: boolean) => {
      await waitFor(async () => ((await tabOf(tabId))?.loading === true) === loading, 15_000);
      await note(step, tabId);
    };

    // A page whose response is still arriving: its tab loads, as a browser's spinner says.
    const opened = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId,
      url: `${site.origin}/slow`,
      idempotencyKey: randomUUID(),
    });
    if (!opened.ok || opened.data.type !== "browser.tab.open")
      throw new Error(JSON.stringify(opened));
    const tabId = opened.data.tabId;
    await until("its page's response is held open", tabId, true);
    // The sidebar's place list reads exactly that field.
    const read = await catalog();
    const listed = placeList(
      seedBrowserSnapshot({
        browserSessions: [
          seedBrowserSession(
            {
              createdAt: new Date().toISOString(),
              id: sessionId,
              profileId: null,
              placement: { kind: "runner", runnerId: "rnr_11111111-1111-4111-8111-111111111111" },
              state: "ready",
            },
            { rows: read.tabs, revision: read.inventoryRevision },
            [],
          ) as unknown as BrowserSessionSummary,
        ],
        browserProfiles: [],
        browserPlacements: [],
        machines: [],
      } as unknown as HostSnapshot),
    );
    expect(listed.find((place) => place.key === `browser:${sessionId}:${tabId}`)?.loading).toBe(
      true,
    );
    // Another tab of the same browser is not loading.
    expect(read.tabs.filter((tab) => tab.id !== tabId).every((tab) => !tab.loading)).toBe(true);

    // Stop, from that tab's own targeted view, ends it; the server never finished the page.
    const control = await openBrowserView(stack, sessionId, "control");
    addCleanup("control viewer", async () => control.socket.terminate());
    control.socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId: tabId }));
    control.socket.send(JSON.stringify({ type: "navigation.stop", surfaceId: tabId }));
    await until("Stop", tabId, false);
    expect(site.finished).not.toContain("/slow");

    // A page that finishes loads and then stops by itself.
    control.socket.send(
      JSON.stringify({ type: "navigation.go", surfaceId: tabId, url: `${site.origin}/frame-host` }),
    );
    await waitFor(async () => (await tabOf(tabId))?.title === "Frame host", 15_000);
    await until("a page that finished", tabId, false);
    // Its script then adds a frame whose page never finishes: a frame loading is not the tab.
    await waitFor(async () => site.requests.includes("/slow-frame"), 15_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await note("1.5 s into a frame that never finishes", tabId);
    expect(timeline.at(-1)?.loading).toBe(false);

    // A navigation the server answers with 204 leaves no spinner behind.
    control.socket.send(
      JSON.stringify({ type: "navigation.go", surfaceId: tabId, url: `${site.origin}/empty` }),
    );
    await waitFor(async () => site.requests.includes("/empty"), 15_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await note("1 s after a 204 answer", tabId);
    expect(timeline.at(-1)?.loading).toBe(false);

    // Reloading a held page loads again, and closing the tab takes it all away.
    control.socket.send(
      JSON.stringify({ type: "navigation.go", surfaceId: tabId, url: `${site.origin}/slow` }),
    );
    await until("held again", tabId, true);
    const current = await catalog();
    const closed = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: tabId,
      inventoryRevision: current.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    expect(closed).toMatchObject({ ok: true });
    expect((await catalog()).tabs.some((tab) => tab.loading)).toBe(false);

    const directory =
      process.env.OPENSTEER_TAB_OPEN_E2E_ARTIFACT_DIR ??
      path.join(tmpdir(), "opensteer-tab-open-e2e");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "host-tab-loading.json"),
      JSON.stringify({ timeline, requests: site.requests, finished: site.finished }, null, 2),
    );
  }, 90_000);

  it("recovers the ninth Chromium target and refuses an old two-tab close decision", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 600, width: 800 } }),
    );
    for (let index = 1; index < 9; index++) {
      const opened = await stack.api["commands.dispatch"]({
        type: "browser.tab.open",
        sessionId,
        idempotencyKey: `capacity-tab-${index}`,
      });
      expect(opened.ok).toBe(true);
    }
    const catalog = await browserInventory(stack, sessionId);
    expect(catalog.tabs).toHaveLength(9);
    const client = new HttpHostClient({
      baseUrl: stack.hostOrigin,
      refreshIntervalMs: 0,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", stack.sessionCookie);
        headers.set("origin", stack.hostOrigin.origin);
        return fetch(input, { ...init, headers });
      },
      webSocketFactory: (url) =>
        new WebSocket(url, {
          headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
        }) as unknown as WebSocketClient,
    });
    addCleanup("Host client", async () => client.dispose());
    await client.load();
    const targets = catalog.tabs.map((tab) => tab.id);
    const release = targets
      .slice(0, 8)
      .map((surfaceId) => client.retainBrowserWatch(sessionId, surfaceId));
    await waitFor(
      async () =>
        targets
          .slice(0, 8)
          .every((id) => client.browserWatchState(sessionId, id).status === "live"),
      25_000,
    );
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("Missing browser owner");
    let failOutcome = false;
    let writerFailures = 0;
    let failedReaderClosed = false;
    const brittle = await stack.host.browser.attach(
      owner.id,
      sessionId,
      {
        id: `failed-reader-${randomUUID()}`,
        isOpen: () => !failedReaderClosed,
        close: () => {
          failedReaderClosed = true;
        },
        send: async (data, binary) => {
          if (!binary && JSON.parse(String(data)).type === "browser.stream.state" && failOutcome) {
            failOutcome = false;
            writerFailures++;
            throw new Error("The reader disconnected while its capture outcome was sent.");
          }
        },
      },
      { authSessionId: createId("authSession"), mode: "watch", signedIn: async () => true },
    );
    addCleanup("brittle viewer", async () => brittle.close());
    await brittle.handle(
      Buffer.from(JSON.stringify({ type: "stream.subscribe", surfaceId: targets[8]! })),
      false,
    );
    failOutcome = true;
    release.push(client.retainBrowserWatch(sessionId, targets[8]!));
    addCleanup("browser watch leases", async () => {
      for (const drop of release) drop();
    });
    await waitFor(
      async () =>
        targets
          .slice(0, 8)
          .every((id) => client.browserWatchState(sessionId, id).status === "live") &&
        client.browserWatchState(sessionId, targets[8]!).error !== null,
      25_000,
    );
    const saturated = targets.map((id) => ({
      id,
      ...client.browserWatchState(sessionId, id),
      frame: undefined,
    }));
    expect(client.browserWatchState(sessionId, targets[8]!)).toMatchObject({
      status: "unavailable",
      error: "Too many browser capture targets.",
    });
    release[0]!();
    await waitFor(
      async () => client.browserWatchState(sessionId, targets[8]!).status === "live",
      20_000,
    );
    expect(
      targets.slice(1).every((id) => client.browserWatchState(sessionId, id).status === "live"),
    ).toBe(true);
    expect(writerFailures).toBe(1);
    expect(failedReaderClosed).toBe(true);
    const recovered = targets.slice(1).map((id) => ({
      id,
      status: client.browserWatchState(sessionId, id).status,
      frameId: client.browserWatchFrame(sessionId, id)?.header.frameId,
    }));
    for (const drop of release) drop();
    let current = catalog;
    for (const surfaceId of targets.slice(2)) {
      const closed = await stack.api["commands.dispatch"]({
        type: "browser.tab.close",
        sessionId,
        surfaceId,
        inventoryRevision: current.inventoryRevision!,
        idempotencyKey: randomUUID(),
      });
      if (!closed.ok || closed.data.type !== "browser.tab.close")
        throw new Error(JSON.stringify(closed));
      current = await browserInventory(stack, sessionId);
    }
    expect(current.tabs).toHaveLength(2);
    const displayed = current;
    const removedElsewhere = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: targets[1]!,
      inventoryRevision: displayed.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    const firstDecision = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: targets[0]!,
      inventoryRevision: displayed.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    expect(firstDecision).toMatchObject({ ok: false, error: { reason: "stale-tab-inventory" } });
    const surviving = await browserInventory(stack, sessionId);
    expect(surviving.tabs).toEqual([
      expect.objectContaining({ id: targets[0]!, availability: "ready" }),
    ]);
    const secondDecision = await stack.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId,
      surfaceId: targets[0]!,
      inventoryRevision: surviving.inventoryRevision!,
      idempotencyKey: randomUUID(),
    });
    expect(secondDecision).toMatchObject({ ok: true, data: { outcome: "session-closed" } });
    await writeViewReport("capacity-and-confirmation", {
      sessionId,
      saturated,
      recovered,
      displayed,
      removedElsewhere,
      firstDecision,
      surviving,
      secondDecision,
      refreshIntervalMs: 0,
      isolatedReaderWriteFailure: writerFailures === 1 && failedReaderClosed,
    });
  }, 120_000);

  it("finishes persisting a closed session before acknowledging its close", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1_000 } }),
    );
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("The deployment has no owner");
    const transition = stack.host.store.transitionBrowserSession.bind(stack.host.store);
    const persisting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = vi
      .spyOn(stack.host.store, "transitionBrowserSession")
      .mockImplementation(async (input) => {
        if (input.sessionId === sessionId && input.state === "closed") {
          persisting.resolve();
          await release.promise;
        }
        return transition(input);
      });
    let closeCompleted = false;
    const closing = stack.host.browser.stop(owner.id, sessionId).then(() => {
      closeCompleted = true;
    });
    try {
      await persisting.promise;
      // Drain the socket-close continuations while the terminal write is held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const before = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      expect(before?.state).toBe("closing");
      expect(closeCompleted).toBe(false);
      release.resolve();
      await closing;
      const after = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      expect(after?.state).toBe("closed");
      const endedMessage =
        "This tab has ended or is unavailable. Use Browser Harness listTabs() and switchTab(tabId).";
      await expect(
        stack.host.browser.attachCdpForAgent(
          {
            agentBindingId: `trigger:${createId("triggerOccurrence")}`,
            ownerId: owner.id,
            sessionId,
          },
          () => undefined,
        ),
      ).rejects.toThrow(endedMessage);
      await writeViewReport("closed-session-durable", {
        after: after?.state,
        before: before?.state,
        closeCompleted,
        endedMessage,
        sessionId,
      });
    } finally {
      release.resolve();
      await closing;
      held.mockRestore();
    }
  }, 60_000);

  it("keeps a terminal session when an earlier closing write finishes later", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    await browserAvailable(stack);
    const sessionId = BrowserSessionIdSchema.parse(
      await startPersonBrowser(stack, { viewport: { height: 700, width: 1_000 } }),
    );
    const owner = await stack.host.store.firstUser();
    if (!owner) throw new Error("The deployment has no owner");
    const transition = stack.host.store.transitionBrowserSession.bind(stack.host.store);
    const persisting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    const writes: { requested: string; persisted: string }[] = [];
    const spy = vi
      .spyOn(stack.host.store, "transitionBrowserSession")
      .mockImplementation(async (input) => {
        if (input.sessionId === sessionId && input.state === "closing" && !held) {
          held = true;
          persisting.resolve();
          await release.promise;
        }
        const result = await transition(input);
        if (input.sessionId === sessionId)
          writes.push({ requested: input.state, persisted: result.session.state });
        return result;
      });
    const closing = stack.host.browser.stop(owner.id, sessionId);
    try {
      await persisting.promise;
      killChromium(process.pid);
      await waitFor(
        async () =>
          (await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id))?.state ===
          "closed",
        10_000,
      );
      const before = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      release.resolve();
      await closing;
      const after = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
      expect(after).toEqual(before);
      expect(after?.state).toBe("closed");
      await expect(
        stack.host.browser.attachCdpForAgent(
          {
            agentBindingId: `trigger:${createId("triggerOccurrence")}`,
            ownerId: owner.id,
            sessionId,
          },
          () => undefined,
        ),
      ).rejects.toThrow(
        "This tab has ended or is unavailable. Use Browser Harness listTabs() and switchTab(tabId).",
      );
      await writeViewReport("closed-session-delayed-closing", { before, after, sessionId, writes });
    } finally {
      release.resolve();
      await closing.finally(() => spy.mockRestore());
    }
  }, 60_000);

  it.each(["requested", "unsolicited"] as const)(
    "reports failed terminal persistence after %s close and still cleans up",
    async (source) => {
      const browser = await startBrowser();
      addCleanup("local Browser Runtime", () => browser.close());
      const stack = await deployment(browser);
      await browserAvailable(stack);
      const sessionId = BrowserSessionIdSchema.parse(
        await startPersonBrowser(stack, { viewport: { height: 700, width: 1_000 } }),
      );
      const owner = await stack.host.store.firstUser();
      if (!owner) throw new Error("The deployment has no owner");
      const threadId = await stack.createThread({
        title: "Observe browser close",
        modelSelection: ModelSelectionSchema.parse({
          modelId: "gpt-5.6-sol",
          providerId: "openai",
          options: {},
        }),
      });
      const agent = {
        agentBindingId: `thread:${threadId}`,
        ownerId: owner.id,
        sessionId,
      };
      const consumerClosed = vi.fn();
      const attachment = await stack.host.browser.attachCdpForAgent(
        agent,
        () => undefined,
        consumerClosed,
      );
      const transition = stack.host.store.transitionBrowserSession.bind(stack.host.store);
      const failure = new Error("Injected terminal database failure");
      let attempts = 0;
      const spy = vi
        .spyOn(stack.host.store, "transitionBrowserSession")
        .mockImplementation(async (input) => {
          if (
            input.sessionId === sessionId &&
            (input.state === "closed" || input.state === "failed")
          ) {
            attempts += 1;
            throw failure;
          }
          return transition(input);
        });
      const reported = vi.spyOn(console, "error");
      try {
        let outcome = "unsolicited";
        if (source === "requested") {
          outcome = await stack.host.browser.closeAgentSession(agent).then(
            () => "resolved",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
        } else {
          killChromium(process.pid);
          await waitFor(
            () => Promise.resolve(reported.mock.calls.some((call) => call.includes(sessionId))),
            10_000,
          );
        }
        const after = await stack.host.store.getBrowserSessionForOwner(sessionId, owner.id);
        const refusal = await stack.host.browser
          .attachCdpForAgent(agent, () => undefined)
          .then(
            () => "attached",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
        if (source === "requested")
          expect(outcome).toBe(
            "The browser disconnected, but Opensteer could not save its ended state. Use Browser Harness listTabs() to select another tab.",
          );
        expect(consumerClosed).toHaveBeenCalledOnce();
        expect(attempts).toBe(1);
        expect(after?.state).toBe("closing");
        expect(refusal).toBe(
          "This tab lost its browser connection. Use Browser Harness listTabs() and switchTab(tabId) to reconnect.",
        );
        expect(reported.mock.calls.some((call) => call.includes(sessionId))).toBe(true);
        await writeViewReport(`closed-session-failed-${source}`, {
          attempts,
          consumerClosed: consumerClosed.mock.calls.length,
          outcome,
          refusal,
          reported: reported.mock.calls.map((call) => call.map(String)),
          sessionId,
          state: after?.state,
        });
      } finally {
        spy.mockRestore();
        reported.mockRestore();
        attachment.close();
        await stack.host.browser.stop(owner.id, sessionId);
      }
    },
    60_000,
  );

  it("opens a person's browser at their view's size and follows only their own view", async () => {
    const browser = await startBrowser();
    addCleanup("local Browser Runtime", () => browser.close());
    const stack = await deployment(browser);
    const site = await sizeReportingSite();
    addCleanup("test site", () => site.close());
    await browserAvailable(stack);

    // The first page loads at the view's size; it never reflows into it.
    const startView = { height: 777, width: 1_111 };
    const sessionId = await startPersonBrowser(stack, {
      initialUrl: `${site.origin}/sized`,
      viewport: startView,
    });
    await waitFor(async () => site.seen.some((entry) => entry.at === "load"), 20_000);
    const firstLoad = site.seen.find((entry) => entry.at === "load");
    expect(firstLoad).toMatchObject(startView);
    const control = await openBrowserView(stack, sessionId, "control");
    addCleanup("control viewer", async () => control.socket.terminate());
    const surfaceId = control.activeSurfaceId;
    const firstFrame = waitForBrowserFrame(control.socket, true);
    control.socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId }));
    const startFrame = (await firstFrame).header;
    expect(startFrame).toMatchObject({ viewportHeight: 777, viewportWidth: 1_111 });
    const reflowsBeforeFollow = site.seen.filter((entry) => entry.at === "resize");
    expect(reflowsBeforeFollow).toEqual([]);

    // A browser that follows the view takes the person's size.
    const followed = { height: 700, width: 1_000 };
    const followedFrame = waitForBrowserFrameAt(control.socket, followed);
    control.socket.send(JSON.stringify({ ...followed, surfaceId, type: "viewport.follow" }));
    const followedHeader = (await followedFrame).header;
    await waitFor(
      async () =>
        site.seen.some(
          (entry) =>
            entry.at === "resize" &&
            entry.width === followed.width &&
            entry.height === followed.height,
        ),
      10_000,
    );

    // A watch is refused like any other command and sizes nothing.
    const watch = await openBrowserView(stack, sessionId, "watch");
    addCleanup("watch viewer", async () => watch.socket.terminate());
    const watchClosed = waitForBrowserClosing(watch.socket);
    watch.socket.send(
      JSON.stringify({ height: 650, surfaceId, type: "viewport.follow", width: 900 }),
    );
    const watchRefusal = await watchClosed;
    expect(watchRefusal).toEqual({
      code: 4002,
      reason: "Watch can only manage its picture subscription and receipts.",
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    const watchResizes = site.seen.filter(
      (entry) => entry.at === "resize" && entry.width === 900 && entry.height === 650,
    );
    expect(watchResizes).toEqual([]);
    const afterWatch = waitForBrowserFrame(control.socket, true);
    control.socket.send(JSON.stringify({ type: "navigation.reload", surfaceId }));
    const afterWatchHeader = (await afterWatch).header;
    expect(afterWatchHeader).toMatchObject({ viewportHeight: 700, viewportWidth: 1_000 });
    await waitFor(async () => site.seen.filter((entry) => entry.at === "load").length >= 2, 10_000);
    const reload = site.seen.filter((entry) => entry.at === "load").at(-1);
    expect(reload).toMatchObject(followed);

    // A tab opened into the running browser starts at its own view's size, not
    // the size the browser last followed: an unfocused view never corrects it.
    const tabView = { height: 640, width: 1_180 };
    const loads = () => site.seen.filter((entry) => entry.at === "load");
    const loadsBeforeTab = loads().length;
    const opened = await stack.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId,
      url: `${site.origin}/sized`,
      viewport: tabView,
      idempotencyKey: randomUUID(),
    });
    expect(opened).toMatchObject({ ok: true, data: { browserStarted: false } });
    await waitFor(async () => loads().length > loadsBeforeTab, 10_000);
    const tabLoad = loads().at(-1);
    expect(tabLoad).toMatchObject(tabView);

    await writeViewReport("relayed-chromium", {
      startView,
      firstLoad,
      startFrame,
      reflowsBeforeFollow,
      followed: { requested: followed, frame: followedHeader },
      watchRefusal,
      watchResizes,
      afterWatch: { frame: afterWatchHeader, reload },
      openedTab: { requested: tabView, load: tabLoad },
      pageSizeLog: site.seen,
    });
  }, 120_000);

  it.each([
    "natural",
    "renderer handoff",
    "stopped navigation",
    "stopped before rejection",
    "startup failure",
  ] as const)(
    "keeps the session when a popup asks before it draws, and pictures a tab whose dialog waits (%s)",
    async (mode) => {
      let openingAsking = false;
      let handoffInjected = false;
      const handoff = Promise.withResolvers<void>();
      const stoppedResponse = Promise.withResolvers<void>();
      const loadingStopped = Promise.withResolvers<void>();
      const cdpTrace: Record<string, unknown>[] = [];
      const browser = await startBrowser({
        onLaunch: (launched) => {
          const observe = (page: ReturnType<LaunchedBrowser["context"]["pages"]>[number]) => {
            const cdp = page.cdp.bind(page);
            const injectHandoff = openingAsking && mode !== "natural";
            const loading = Promise.withResolvers<void>();
            let observed = false;
            vi.spyOn(page, "cdp").mockImplementation(async () => {
              const session = await cdp();
              if (!observed) {
                observed = true;
                session.on("Page.frameStartedLoading", () => loading.resolve());
                if (injectHandoff)
                  session.on("Page.frameStoppedLoading", () => loadingStopped.resolve());
                const send = session.send.bind(session);
                vi.spyOn(session, "send").mockImplementation(
                  async <Result>(
                    method: string,
                    parameters?: Record<string, unknown>,
                  ): Promise<Result> => {
                    const at = performance.now();
                    try {
                      // Hold the fixture response until Chromium's observed renderer-handoff
                      // rejection has reached the real Runtime subscription path.
                      if (injectHandoff && !handoffInjected && method === "Page.startScreencast") {
                        if (mode !== "startup failure") await loading.promise;
                        handoffInjected = true;
                        handoff.resolve();
                        if (mode === "stopped before rejection") {
                          await send("Page.stopLoading");
                          await loadingStopped.promise;
                        }
                        throw new Error(
                          mode === "startup failure"
                            ? "Unrelated cast startup failure"
                            : "Protocol error (Page.startScreencast): Not attached to an active page",
                        );
                      }
                      const result = await send<Result>(method, parameters);
                      if (/Screencast|DeviceMetrics|navigate/.test(method))
                        cdpTrace.push({
                          at,
                          completed: performance.now(),
                          url: page.url(),
                          method,
                          parameters,
                        });
                      if (
                        process.env.OPENSTEER_BROWSER_DIAGNOSTICS === "1" &&
                        /Screencast|DeviceMetrics|navigate/.test(method)
                      )
                        console.info(
                          JSON.stringify({
                            popupCdp: true,
                            at,
                            completed: performance.now(),
                            url: page.url(),
                            method,
                            parameters,
                          }),
                        );
                      return result;
                    } catch (error) {
                      cdpTrace.push({
                        at,
                        rejected: performance.now(),
                        url: page.url(),
                        method,
                        parameters,
                        error: inspect(error, { depth: 8 }),
                      });
                      console.info(
                        JSON.stringify({
                          popupCdp: true,
                          at,
                          rejected: performance.now(),
                          url: page.url(),
                          method,
                          parameters,
                          error: inspect(error, { depth: 8 }),
                        }),
                      );
                      throw error;
                    }
                  },
                );
              }
              return session;
            });
          };
          launched.context.pages().forEach(observe);
          launched.context.onPage(observe);
        },
      });
      addCleanup("local Browser Runtime", () => browser.close());
      const stack = await deployment(browser);
      const site = await popupDialogSite(
        mode === "stopped navigation" || mode === "stopped before rejection"
          ? stoppedResponse.promise
          : mode === "renderer handoff"
            ? handoff.promise
            : undefined,
      );
      addCleanup("test site", () => site.close());
      await browserAvailable(stack);
      const view = { height: 700, width: 1_000 };
      const sessionId = await startPersonBrowser(stack, {
        initialUrl: `${site.origin}/opener`,
        viewport: view,
      });
      const control = await openBrowserView(stack, sessionId, "control");
      addCleanup("control viewer", async () => control.socket.terminate());
      const opener = control.activeSurfaceId;
      const viewer = recordBrowserView(control.socket);
      control.socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId: opener }));
      await waitFor(async () => site.seen.includes("opener-load"), 20_000);
      const frameOf = (surfaceId: string) => (entry: ViewerEntry) =>
        entry.kind === "frame" &&
        entry.header.surfaceId === surfaceId &&
        entry.header.viewportWidth === view.width &&
        entry.header.viewportHeight === view.height;
      const directory =
        process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
        path.join(tmpdir(), "opensteer-browser-follow-e2e");
      await mkdir(directory, { recursive: true });
      const journeys = [];
      for (const kind of ["confirm", "alert"] as const) {
        await waitFor(async () => viewer.entries.some(frameOf(opener)), 10_000);
        // The person clicks the page's button in its picture; it opens a popup
        // whose first script asks before the popup draws anything.
        const from = viewer.entries.length;
        for (const action of ["down", "up"] as const) {
          control.socket.send(
            JSON.stringify({
              action,
              button: "left",
              clickCount: 1,
              surfaceId: opener,
              type: "input.pointer",
              viewportHeight: view.height,
              viewportWidth: view.width,
              x: 0.5,
              y: 0.5,
            }),
          );
        }
        let openedPopup: string | undefined;
        await waitFor(async () => {
          openedPopup = (await browserInventory(stack, sessionId)).tabs.find(
            (surface) => surface.openerId != null && surface.id !== opener,
          )?.id;
          return openedPopup !== undefined;
        }, 10_000);
        expect(control.activeSurfaceId).toBe(opener);
        control.socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId: openedPopup }));
        const since = () => viewer.entries.slice(from);
        const shownAt = () =>
          since().findIndex(
            (entry) =>
              entry.kind === "message" &&
              entry.message.type === "browser.dialog.changed" &&
              entry.message.dialog !== null &&
              entry.message.dialog.surfaceId !== opener,
          );
        await waitFor(async () => shownAt() !== -1, 10_000);
        const shown = since()[shownAt()];
        const dialog =
          shown?.kind === "message" && shown.message.type === "browser.dialog.changed"
            ? shown.message.dialog
            : null;
        if (!dialog) throw new Error("The popup's dialog was not shown.");
        const popup = dialog.surfaceId;
        const namedAt = since().findIndex(
          (entry) =>
            entry.kind === "message" &&
            entry.message.type === "browser.surface" &&
            entry.message.surface?.id === popup,
        );
        const order = since()
          .slice(0, shownAt() + 1)
          .map((entry) => describeViewerEntry(entry, { [opener]: "opener", [popup]: "popup" }));

        // They answer the dialog they see, by its id; the popup then draws.
        const answeredFrom = viewer.entries.length;
        control.socket.send(
          JSON.stringify({
            accept: true,
            dialogId: dialog.id,
            surfaceId: popup,
            type: "dialog.respond",
          }),
        );
        await waitFor(
          async () => site.seen.some((at) => at.startsWith(`popup-answered:${kind}`)),
          10_000,
        );
        await waitFor(
          async () => viewer.entries.slice(answeredFrom).some(frameOf(popup)),
          10_000,
        ).catch(async (error: unknown) => {
          await writeFile(
            path.join(directory, "popup-frame-failure.json"),
            JSON.stringify(
              {
                kind,
                popup,
                opener,
                seen: site.seen,
                entries: viewer.entries.map((entry) =>
                  entry.kind === "frame" ? { kind: entry.kind, header: entry.header } : entry,
                ),
              },
              null,
              2,
            ),
          );
          throw error;
        });
        const popupFrame = viewer.entries.slice(answeredFrom).find(frameOf(popup));
        if (popupFrame?.kind !== "frame") throw new Error("The popup was never pictured.");
        await writeFile(path.join(directory, `deployment-popup-${kind}.jpeg`), popupFrame.jpeg);
        const cleared = viewer.entries
          .slice(answeredFrom)
          .some(
            (entry) =>
              entry.kind === "message" &&
              entry.message.type === "browser.dialog.changed" &&
              entry.message.dialog === null,
          );

        // Closing the popup returns them to the opener, which is as it was.
        const closedFrom = viewer.entries.length;
        const closed = await stack.api["commands.dispatch"]({
          type: "tab.close",
          tabId: popup,
          idempotencyKey: randomUUID(),
        });
        expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true });
        control.socket.send(JSON.stringify({ surfaceId: opener, type: "stream.subscribe" }));
        await waitFor(async () => viewer.entries.slice(closedFrom).some(frameOf(opener)), 10_000);
        const surfacesAfterClose = (await browserInventory(stack, sessionId)).tabs.map(
          (surface) => ({ id: surface.id }),
        );
        journeys.push({
          kind,
          dialog,
          order,
          namedBeforeShown: namedAt !== -1 && namedAt < shownAt(),
          answeredInPage: site.seen.filter((at) => at.startsWith(`popup-answered:${kind}`)),
          dialogCleared: cleared,
          popupFrame: { header: popupFrame.header, decoded: popupFrame.decoded },
          openerAfterClose: surfacesAfterClose,
        });
      }

      // A tab whose dialog waits cannot draw. Turning back to it shows its last
      // picture beneath the dialog, after the list that makes it the tab shown.
      const isDialogOn = (surfaceId: string) => (entry: ViewerEntry) =>
        entry.kind === "message" &&
        entry.message.type === "browser.dialog.changed" &&
        entry.message.dialog?.surfaceId === surfaceId;
      const shownTab = (from: number) =>
        viewer.entries
          .slice(from)
          .flatMap((entry) =>
            entry.kind === "message" &&
            entry.message.type === "browser.surface" &&
            entry.message.surface
              ? [entry.message.surface.id]
              : [],
          )
          .at(-1);
      const openedFrom = viewer.entries.length;
      openingAsking = true;
      if (mode === "startup failure") {
        const stoppedFrom = cdpTrace.length;
        control.socket.send(JSON.stringify({ type: "stream.unsubscribe" }));
        await waitFor(
          async () =>
            cdpTrace.slice(stoppedFrom).some((entry) => entry.method === "Page.stopScreencast"),
          10_000,
        );
      }
      const existingTabs = new Set(
        (await browserInventory(stack, sessionId)).tabs.map((tab) => tab.id),
      );
      control.socket.send(
        JSON.stringify({ type: "surface.open", url: `${site.origin}/asks`, viewport: view }),
      );
      let askingId: string | undefined;
      await waitFor(async () => {
        askingId = (await browserInventory(stack, sessionId)).tabs.find(
          (tab) => !existingTabs.has(tab.id),
        )?.id;
        return askingId !== undefined;
      }, 10_000);
      if (mode === "startup failure") {
        await loadingStopped.promise;
        await waitFor(
          async () =>
            (await browserInventory(stack, sessionId)).tabs.some(
              (surface) => surface.id === askingId && !surface.loading,
            ),
          10_000,
        );
      }
      control.socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId: askingId }));
      if (
        mode === "stopped navigation" ||
        mode === "stopped before rejection" ||
        mode === "startup failure"
      ) {
        await handoff.promise;
        await waitFor(
          async () => shownTab(openedFrom) !== undefined && shownTab(openedFrom) !== opener,
          10_000,
        );
        const asking = shownTab(openedFrom)!;
        const errors = () =>
          viewer.entries.filter(
            (entry) => entry.kind === "message" && entry.message.type === "browser.error",
          );
        const report = () =>
          writeViewReport(`popup-first-script-dialog-${mode.replaceAll(" ", "-")}`, {
            mode,
            asking,
            handoffInjected,
            cdpTrace,
            seen: site.seen,
            entries: viewer.entries.map((entry) =>
              entry.kind === "frame" ? { kind: entry.kind, header: entry.header } : entry,
            ),
          });
        if (mode === "startup failure") {
          try {
            await waitFor(async () => errors().length > 0, 10_000);
          } finally {
            await report();
          }
          expect(errors()).toHaveLength(1);
        } else {
          if (mode === "stopped before rejection") await loadingStopped.promise;
          else control.socket.send(JSON.stringify({ type: "navigation.stop", surfaceId: asking }));
          try {
            await waitFor(
              async () => viewer.entries.slice(openedFrom).some(frameOf(asking)),
              10_000,
            );
          } finally {
            await report();
          }
          expect(site.seen).not.toContain("asks-load");
          expect(errors()).toEqual([]);
        }
        expect(handoffInjected).toBe(true);
        return;
      }
      await waitFor(
        async () =>
          shownTab(openedFrom) !== undefined &&
          shownTab(openedFrom) !== opener &&
          site.seen.includes("asks-load"),
        10_000,
      ).catch(async (error: unknown) => {
        await writeFile(
          path.join(directory, "surface-open-failure.json"),
          JSON.stringify(
            {
              closed: viewer.closed(),
              seen: site.seen,
              entries: viewer.entries.map((entry) =>
                entry.kind === "frame" ? { kind: entry.kind, header: entry.header } : entry,
              ),
              bootstrap: await stack.api["bootstrap.get"]({}),
            },
            null,
            2,
          ),
        );
        throw error;
      });
      const asking = shownTab(openedFrom)!;
      await waitFor(
        async () => viewer.entries.slice(openedFrom).some(frameOf(asking)),
        10_000,
      ).catch(async (error: unknown) => {
        await writeFile(
          path.join(directory, "surface-frame-failure.json"),
          JSON.stringify(
            {
              closed: viewer.closed(),
              seen: site.seen,
              asking,
              cdpTrace,
              entries: viewer.entries.map((entry) =>
                entry.kind === "frame" ? { kind: entry.kind, header: entry.header } : entry,
              ),
            },
            null,
            2,
          ),
        );
        throw error;
      });
      const askFrom = viewer.entries.length;
      for (const action of ["down", "up"] as const) {
        control.socket.send(
          JSON.stringify({
            action,
            button: "left",
            clickCount: 1,
            surfaceId: asking,
            type: "input.pointer",
            viewportHeight: view.height,
            viewportWidth: view.width,
            x: 0.5,
            y: 0.5,
          }),
        );
      }
      await waitFor(async () => viewer.entries.slice(askFrom).some(isDialogOn(asking)), 10_000);
      const askedEntry = viewer.entries.slice(askFrom).find(isDialogOn(asking));
      const waitingDialog =
        askedEntry?.kind === "message" && askedEntry.message.type === "browser.dialog.changed"
          ? askedEntry.message.dialog
          : null;
      if (!waitingDialog) throw new Error("The tab's dialog was not shown.");
      const awayFrom = viewer.entries.length;
      control.socket.send(JSON.stringify({ surfaceId: opener, type: "stream.subscribe" }));
      await waitFor(async () => viewer.entries.slice(awayFrom).some(frameOf(opener)), 10_000);
      const returnFrom = viewer.entries.length;
      const returnedAt = performance.now();
      control.socket.send(JSON.stringify({ surfaceId: asking, type: "stream.subscribe" }));
      await vi.waitFor(
        () =>
          expect(
            viewer.entries.slice(returnFrom).some(frameOf(asking)),
            "The held tab did not return its picture while the dialog waited.",
          ).toBe(true),
        { timeout: 10_000 },
      );
      const back = viewer.entries.slice(returnFrom);
      const listAt = back.findIndex(
        (entry) =>
          entry.kind === "message" &&
          entry.message.type === "browser.surface" &&
          entry.message.surface?.id === asking,
      );
      const pictureAt = back.findIndex(frameOf(asking));
      const retained = back[pictureAt];
      const reshown = back.find(isDialogOn(asking));
      const pageAnsweredBeforePicture = site.seen.some((at) => at.startsWith("asked:"));
      if (retained?.kind === "frame") {
        await writeFile(path.join(directory, "deployment-waiting-tab-return.jpeg"), retained.jpeg);
      }
      const answerFrom = viewer.entries.length;
      control.socket.send(
        JSON.stringify({
          accept: true,
          dialogId: waitingDialog.id,
          surfaceId: asking,
          type: "dialog.respond",
        }),
      );
      await waitFor(async () => site.seen.includes("asked:true"), 10_000);
      await waitFor(async () => viewer.entries.slice(answerFrom).some(frameOf(asking)), 10_000);
      const live = viewer.entries.slice(answerFrom).find(frameOf(asking));
      const waitingTab = {
        dialog: waitingDialog,
        order: back
          .slice(0, Math.max(pictureAt, listAt) + 1)
          .map((entry) =>
            describeViewerEntry(entry, { [opener]: "opener", [asking]: "waiting tab" }),
          ),
        listBeforePicture: listAt !== -1 && pictureAt > listAt,
        pictureAfterMs: retained ? Math.round(retained.at - returnedAt) : null,
        picture:
          retained?.kind === "frame"
            ? { header: retained.header, decoded: retained.decoded }
            : null,
        reshownDialog:
          reshown?.kind === "message" && reshown.message.type === "browser.dialog.changed"
            ? reshown.message.dialog
            : null,
        pageAnsweredBeforePicture,
        liveAfterAnswer: live?.kind === "frame" ? live.header : null,
      };
      const bootstrap = await stack.api["bootstrap.get"]({});
      const sessionState =
        bootstrap.ok &&
        bootstrap.data.browser.groups.rows.find((s) => s.sessionId === sessionId)?.state;
      const outcome = {
        mode,
        handoffInjected,
        cdpTrace,
        view,
        journeys,
        waitingTab,
        viewerClosed: viewer.closed(),
        sessionState,
        pageLog: site.seen,
      };
      await writeViewReport(`popup-first-script-dialog-${mode.replaceAll(" ", "-")}`, outcome);
      expect(handoffInjected).toBe(mode === "renderer handoff");
      expect(
        viewer.entries.filter(
          (entry) => entry.kind === "message" && entry.message.type === "browser.error",
        ),
      ).toEqual([]);
      for (const journey of journeys) {
        expect(journey.dialog, journey.kind).toMatchObject({
          message: "Immediate popup",
          type: journey.kind,
        });
        expect(journey.namedBeforeShown, JSON.stringify(journey.order)).toBe(true);
        expect(journey.answeredInPage).toEqual([
          `popup-answered:${journey.kind}:${journey.kind === "confirm" ? "true" : "undefined"}`,
        ]);
        expect(journey.dialogCleared).toBe(true);
        expect(journey.popupFrame.header).toMatchObject({
          viewportHeight: view.height,
          viewportWidth: view.width,
        });
        expect(journey.popupFrame.decoded).toEqual({
          height: journey.popupFrame.header.rasterHeight,
          width: journey.popupFrame.header.rasterWidth,
        });
        expect(journey.openerAfterClose).toEqual([{ id: opener }]);
      }
      expect(waitingTab.listBeforePicture, JSON.stringify(waitingTab.order)).toBe(true);
      expect(waitingTab.pictureAfterMs).not.toBeNull();
      expect(waitingTab.picture?.header).toMatchObject({
        surfaceId: asking,
        viewportHeight: view.height,
        viewportWidth: view.width,
      });
      expect(waitingTab.picture?.decoded).toEqual({
        height: waitingTab.picture?.header.rasterHeight,
        width: waitingTab.picture?.header.rasterWidth,
      });
      expect(waitingTab.reshownDialog).toEqual(waitingDialog);
      expect(waitingTab.pageAnsweredBeforePicture).toBe(false);
      expect(waitingTab.liveAfterAnswer).not.toBeNull();
      expect(outcome.viewerClosed).toBeNull();
      expect(outcome.sessionState).toBe("ready");
    },
    120_000,
  );

  it("keeps current browser computers connected while forwarding viewer commands", async () => {
    const startView = { height: 777, width: 1_111 };
    const journey = async () => {
      const stack = await deployment(undefined);
      const enrollmentToken = await enrollBrowserComputer(stack, "Browser computer");
      const releasedDialog = {
        message: "Continue?",
        surfaceId: "page-integration",
        type: "confirm",
      };
      const runtime = await startBrowserRuntime(Number(stack.hostOrigin.port), enrollmentToken, {
        agentReady: true,
        initialDialog: { ...releasedDialog, id: randomUUID() },
      });
      addCleanup("protocol runtime", () => runtime.close());
      const forwarded: Record<string, unknown>[] = [];
      void (async () => {
        for (;;) {
          const command = await runtime.nextCommand();
          if (command.type !== "cdp.command") {
            forwarded.push(command);
            continue;
          }
          const method = (command.command as { method?: string } | undefined)?.method;
          runtime.sendServer({
            requestId: command.requestId,
            result:
              method === "Target.getTargets"
                ? { targetInfos: [{ targetId: "target-integration", type: "page" }] }
                : method === "Target.attachToTarget"
                  ? { sessionId: "cdp-integration" }
                  : {},
            type: "cdp.result",
          });
        }
      })();
      await browserAvailable(stack);
      const sessionId = await startPersonBrowser(stack, {
        placement: { kind: "runner", runnerId: runtime.runnerId },
        viewport: startView,
      });
      const ticketViewport = runtime.lastClaims()?.viewport ?? null;
      const control = await openBrowserView(stack, sessionId, "control");
      addCleanup("control viewer", async () => control.socket.terminate());
      const surfaceId = control.activeSurfaceId;
      expect(control.snapshot.dialog).toBeNull();
      const held = nextJson(control.socket, "browser.dialog.changed");
      control.socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId }));
      const heldMessage = BrowserServerMessageSchema.parse(await held);
      if (heldMessage.type !== "browser.dialog.changed") throw new Error("Expected held dialog");
      const snapshotDialog = heldMessage.dialog;
      expect(snapshotDialog).toMatchObject(releasedDialog);
      expect(snapshotDialog?.id).toMatch(/^[0-9a-f-]{36}$/);
      const late = await openBrowserView(stack, sessionId, "control");
      addCleanup("late viewer", async () => late.socket.terminate());
      expect(late.snapshot.dialog).toBeNull();
      const lateHeld = nextJson(late.socket, "browser.dialog.changed");
      late.socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId }));
      expect(BrowserServerMessageSchema.parse(await lateHeld)).toMatchObject({
        dialog: snapshotDialog,
      });

      control.socket.send(
        JSON.stringify({ height: 700, surfaceId, type: "viewport.follow", width: 1_000 }),
      );
      control.socket.send(
        JSON.stringify({ type: "surface.open", url: "https://example.com/", viewport: startView }),
      );
      control.socket.send(
        JSON.stringify({ height: 650, surfaceId, type: "viewport.set", width: 900 }),
      );

      const changed = nextJson(control.socket, "browser.dialog.changed");
      runtime.sendServer({
        dialog: { ...releasedDialog, id: randomUUID() },
        type: "browser.dialog.changed",
      });
      const dialogEvent = BrowserServerMessageSchema.parse(await changed);
      if (dialogEvent.type !== "browser.dialog.changed" || !dialogEvent.dialog) {
        throw new Error("The browser sent no active dialog.");
      }
      const dialogId = dialogEvent.dialog.id;
      expect(dialogId).not.toBe(snapshotDialog?.id);
      control.socket.send(
        JSON.stringify({ accept: true, dialogId, surfaceId, type: "dialog.respond" }),
      );
      control.socket.send(JSON.stringify({ type: "navigation.reload", surfaceId }));
      await vi.waitFor(
        () => expect(forwarded).toContainEqual({ type: "navigation.reload", surfaceId }),
        {
          timeout: 10_000,
        },
      );
      expect(runtime.protocolErrors()).toEqual([]);
      expect(runtime.streamOpen()).toBe(true);
      expect(control.socket.readyState).toBe(WebSocket.OPEN);
      const bootstrap = await stack.api["bootstrap.get"]({});
      expect(
        bootstrap.ok &&
          bootstrap.data.browser.groups.rows.find((s) => s.sessionId === sessionId)?.state,
      ).toBe("ready");
      return {
        browserModule: runtime.browserModule(),
        dialogId,
        forwarded,
        protocolErrors: runtime.protocolErrors(),
        receivedCommands: runtime.receivedCommands(),
        snapshotDialog,
        streamOpen: runtime.streamOpen(),
        ticketViewport,
      };
    };
    const current = await journey();
    expect(current.browserModule).toEqual({
      wireVersion: 2,
      localProfileStorage: {
        storageInstanceId: "20000000-0000-4000-8000-000000000001",
        engine: "chromium",
      },
      runtimeId: "browser-runtime-integration",
      cdpBoundary: 1,
      sharedControl: 1,
    });
    expect(current.ticketViewport).toEqual(startView);
    expect(current.forwarded).toEqual([
      { type: "stream.subscribe", surfaceId: "page-integration" },
      { height: 700, surfaceId: "page-integration", type: "viewport.follow", width: 1_000 },
      { type: "surface.open", url: "https://example.com/", viewport: startView },
      { height: 650, surfaceId: "page-integration", type: "viewport.set", width: 900 },
      {
        accept: true,
        dialogId: current.dialogId,
        surfaceId: "page-integration",
        type: "dialog.respond",
      },
      { type: "navigation.reload", surfaceId: "page-integration" },
    ]);
    await writeViewReport("current-runtime", { startView, current });
  }, 120_000);

  it("requires dialog ids from a computer advertising shared control", async () => {
    const stack = await deployment(undefined);
    const enrollmentToken = await enrollBrowserComputer(stack, "Malformed current browser");
    const runtime = await startBrowserRuntime(Number(stack.hostOrigin.port), enrollmentToken, {
      agentReady: true,
      initialDialog: { message: "Continue?", surfaceId: "page-integration", type: "confirm" },
    });
    addCleanup("protocol runtime", () => runtime.close());
    await browserAvailable(stack);
    await expect(
      startPersonBrowser(stack, {
        placement: { kind: "runner", runnerId: runtime.runnerId },
        viewport: { height: 777, width: 1_111 },
      }),
    ).rejects.toThrow();
    expect(runtime.streamOpen()).toBe(true);
    await writeViewReport("current-runtime-requires-dialog-id", { refused: true });
  }, 60_000);
});
