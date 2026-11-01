import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zeroSequence } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closed,
  createMachineAccessDatabase,
  connectCallerMachine,
  dispatchCallerRun,
  enrollmentToken,
  signUpUser,
  startMachineAccessHost,
  waitForMessage,
  type MachineAccessHost,
} from "../runtime/machine-access.test-support.js";
import { createHostRuntime } from "../runtime/runtime.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";

/*
 * A durable tab keeps its site icon after its browser is gone. Through a real
 * Host on PostgreSQL and a relayed Browser Runtime:
 *
 * - the icon a live page shows is stored with its tab, and a later icon-only
 *   change is stored once, while loading and geometry changes are not writes;
 * - a navigation the Runtime commits clears the old icon, and an icon shown
 *   for another address is never stored against the committed one;
 * - after the Runtime ends, and again after the Host restarts against the same
 *   database, a cold client's tab metadata names an icon reference without its
 *   image, and the existing icon RPC returns the bytes without reaching a
 *   Runtime, starting a session or subscribing a stream;
 * - closing the tab revokes its icon, and a stranger is refused.
 *
 * The artifact records the revisions, references and statuses each step saw.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const iconA =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=";
const iconB =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const iconC =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function until<Value>(
  produce: () => Value | undefined | Promise<Value | undefined>,
  describeState: () => unknown = () => undefined,
  timeoutMs = 10_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error(`timed out; last state ${JSON.stringify(await describeState())}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** The owner's realtime socket, following the Workspace so catalog notices arrive. */
async function listen(host: MachineAccessHost, workspaceId: string, headers = host.ownerHeaders) {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/v1/realtime`, {
    headers,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as Record<string, unknown> & {
      readonly events?: readonly { readonly sequence?: string }[];
    };
    messages.push(message);
    const latest = message.events?.at(-1);
    if (message.type === "host.events" && latest?.sequence)
      socket.send(JSON.stringify({ sequence: latest.sequence, type: "client.ack", workspaceId }));
  });
  const synchronized = waitForMessage(socket, (message) => message.type === "host.synchronized");
  socket.send(
    JSON.stringify({
      afterSequence: zeroSequence,
      apiVersion: hostApiVersion,
      threadId: null,
      type: "client.subscribe",
      workspaceId,
    }),
  );
  await synchronized;
  return {
    messages,
    close: async () => {
      socket.close();
      await closed(socket);
    },
  };
}

integration("Durable tab icons", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  });

  it("records committed person visits per profile and keeps their icons after tab closure", async () => {
    const database = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    cleanups.push(() => host.close());
    const runtime = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "history-browser",
        name: "History browser",
      }),
      {
        agentReady: true,
        targetedStreaming: true,
        navigation: true,
        navigationAttribution: true,
        workspaceTabs: true,
      },
    );
    cleanups.push(() => runtime.close());
    await vi.waitFor(() => expect(host.runtime.browser.available).toBe(true), { timeout: 5_000 });
    await testRpcData(host.origin, "bootstrap.get", {}, { headers: host.ownerHeaders });
    const profile = await host.store.createBrowserProfile({
      ownerId: host.ownerId,
      name: "History",
      idempotencyKey: "history-profile",
    });
    const profileId = profile.id;
    const workspace = await host.store.findMainWorkspaceForOwner(host.ownerId);
    if (!workspace) throw new Error("Main Workspace missing");
    const stranger = await signUpUser(host, {
      email: "history-stranger@example.com",
      password: "history-stranger-password",
    });
    await testRpcData(host.origin, "bootstrap.get", {}, { headers: stranger.headers });
    const strangerWorkspace = await host.store.findMainWorkspaceForOwner(stranger.userId);
    if (!strangerWorkspace) throw new Error("Stranger Workspace missing");
    const devices = await Promise.all([
      listen(host, workspace.id),
      listen(host, workspace.id),
      listen(host, strangerWorkspace.id, stranger.headers),
    ]);
    for (const device of devices) cleanups.push(() => device.close());
    const notices = (device: (typeof devices)[number]) =>
      device.messages.filter((message) => message.type === "host.browser-history-changed");
    let noticeCount = 0;
    const changed = async () => {
      noticeCount++;
      await vi.waitFor(
        () => {
          for (const device of devices.slice(0, 2)) {
            expect(notices(device)).toHaveLength(noticeCount);
            expect(notices(device).at(-1)).toEqual({
              type: "host.browser-history-changed",
              profileId,
            });
          }
        },
        { timeout: 5_000 },
      );
      expect(notices(devices[2]!)).toEqual([]);
    };
    const read = () =>
      testRpcData(
        host.origin,
        "browser.history.get",
        { profileId },
        { headers: host.ownerHeaders },
      );
    const mutate = (
      type: "browser.history.clear" | "browser.history.remove",
      key: string,
      url?: string,
    ) =>
      type === "browser.history.clear"
        ? testRpcData(
            host.origin,
            "commands.dispatch",
            { type, profileId, idempotencyKey: key },
            { headers: host.ownerHeaders },
          )
        : testRpcData(
            host.origin,
            "commands.dispatch",
            { type, profileId, idempotencyKey: key, url: url! },
            { headers: host.ownerHeaders },
          );
    const request = async (method: string, after = 0) =>
      vi.waitFor(
        () => {
          const command = runtime
            .receivedCommands()
            .slice(after)
            .find(
              (command) =>
                command.type === "cdp.command" &&
                (command.command as { method?: string })?.method === method,
            );
          expect(command, `Runtime never received ${method}`).toBeDefined();
          return command!;
        },
        { timeout: 5_000 },
      );
    const answer = (command: Record<string, unknown>, result: unknown) =>
      runtime.sendServer({
        type: "cdp.result",
        requestId: command.requestId,
        result,
      });
    const surface = (
      id: string,
      url: string,
      documentId: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      url,
      documentId,
      title: "Amazon",
      active: true,
      order: 0,
      openerId: null,
      ...extra,
    });
    // Initial navigation carries the same browser attribution as later address-bar actions.
    const opening = testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "browser.tab.open",
        identity: { kind: "profile", profileId },
        url: "https://amazon.com/",
        typed: true,
        idempotencyKey: "history-first",
      },
      { headers: host.ownerHeaders },
    );
    // The Runtime submits it from the signed ticket; the Host sends no CDP navigation.
    const opened = await opening;
    if (opened.type !== "browser.tab.open") throw new Error("Unexpected command");
    const sessionId = opened.sessionId;
    const initialNavigation = runtime.lastClaims()?.initialNavigation;
    expect(initialNavigation).toMatchObject({ url: "https://amazon.com/" });
    expect(runtime.receivedCommands().some((command) => command.type === "cdp.command")).toBe(
      false,
    );
    runtime.sendServer(
      {
        type: "browser.surfaces.changed",
        surfaces: [
          surface("page-integration", "https://www.amazon.com/", "amazon-1", {
            favicon: iconA,
          }),
        ],
      },
      sessionId,
    );
    runtime.sendServer(
      {
        type: "navigation.committed",
        navigationId: initialNavigation!.navigationId!,
        surfaceId: "page-integration",
        documentId: "amazon-1",
        url: "https://www.amazon.com/",
      },
      sessionId,
    );
    await changed();
    expect((await read()).entries).toMatchObject([
      { url: "https://www.amazon.com/", typedCount: 1, visitCount: 1 },
    ]);
    expect((await read()).entries.some((entry) => entry.url === "https://amazon.com/")).toBe(false);
    const viewer = new WebSocket(
      `ws://127.0.0.1:${host.hostPort}/v1/browser-sessions/${sessionId}/connect`,
      {
        headers: host.ownerHeaders,
      },
    );
    cleanups.push(async () => {
      viewer.close();
      await closed(viewer);
    });
    await waitForMessage(viewer, (message) => message.type === "browser.snapshot");
    const sendSurfaces = async (surfaces: Record<string, unknown>[]) => {
      const received = waitForMessage(
        viewer,
        (message) => message.type === "browser.surfaces.changed",
      );
      runtime.sendServer(
        {
          type: "browser.surfaces.changed",
          surfaces: surfaces.map(({ navigationId: _navigationId, ...surface }) => surface),
        },
        sessionId,
      );
      for (const surface of surfaces)
        if (surface.navigationId)
          runtime.sendServer(
            {
              type: "navigation.committed",
              navigationId: surface.navigationId,
              surfaceId: surface.id,
              documentId: surface.documentId,
              url: surface.url,
            },
            sessionId,
          );
      await received;
    };
    const go = async (url: string, typed = false) => {
      const count = runtime.receivedCommands().length;
      viewer.send(
        JSON.stringify({ type: "navigation.go", surfaceId: "page-integration", url, typed }),
      );
      await vi.waitFor(
        () =>
          expect(
            runtime
              .receivedCommands()
              .slice(count)
              .some((command) => command.type === "navigation.go"),
          ).toBe(true),
        { timeout: 5_000 },
      );
      return runtime
        .receivedCommands()
        .slice(count)
        .find((command) => command.type === "navigation.go")!.navigationId;
    };
    await sendSurfaces([
      surface("page-integration", "https://www.amazon.com/", "amazon-1", {
        favicon: iconA,
        title: "Amazon shopping",
      }),
    ]);
    expect((await read()).entries[0]).toMatchObject({
      title: "Amazon shopping",
      typedCount: 1,
      visitCount: 1,
    });
    await changed();
    // Agent snapshots can refresh a visited site's icon, but cannot create visits.
    await sendSurfaces([
      surface("page-integration", "https://agent.example/", "agent-1", { favicon: iconB }),
    ]);
    expect((await read()).entries).toHaveLength(1);
    await sendSurfaces([
      surface("page-integration", "https://www.amazon.com/agent", "agent-2", { favicon: iconB }),
    ]);
    expect((await read()).entries).toHaveLength(1);
    let iconRef = (await read()).icons[0]!.iconRef;
    expect(
      await testRpcData(
        host.origin,
        "browser.history.icons.get",
        { profileId, iconRefs: [iconRef] },
        { headers: host.ownerHeaders },
      ),
    ).toEqual({ icons: [{ iconRef, favicon: iconB }] });

    await changed();
    // The icon was already shown for an agent-only origin; that no-op write must not suppress it after a person visits.
    await sendSurfaces([
      surface("page-integration", "https://committed.example/agent", "agent-only", {
        favicon: iconC,
      }),
    ]);
    const personNavigation = await go("https://requested.example/", true);
    // Only a browser-attributed commit satisfies the navigation, even while loading.
    await sendSurfaces([surface("page-integration", "https://www.amazon.com/agent", "agent-2")]);
    expect((await read()).entries).toHaveLength(1);
    await sendSurfaces([
      surface("page-integration", "https://committed.example/", "person-2", {
        loading: true,
        navigationId: personNavigation,
      }),
    ]);
    expect((await read()).entries).toHaveLength(2);
    await changed();
    await sendSurfaces([
      surface("page-integration", "https://committed.example/", "person-2", { favicon: iconC }),
    ]);
    expect((await read()).entries[0]).toMatchObject({
      url: "https://committed.example/",
      typedCount: 1,
      visitCount: 1,
    });
    await changed();
    expect((await read()).icons).toContainEqual({
      origin: "https://committed.example",
      iconRef: expect.any(String),
    });
    await go("https://stopped.example/", true);
    const stoppedAt = runtime.receivedCommands().length;
    viewer.send(JSON.stringify({ type: "navigation.stop", surfaceId: "page-integration" }));
    await vi.waitFor(
      () =>
        expect(
          runtime
            .receivedCommands()
            .slice(stoppedAt)
            .some((command) => command.type === "navigation.stop"),
        ).toBe(true),
      { timeout: 5_000 },
    );
    await sendSurfaces([surface("page-integration", "https://stopped.example/", "stopped")]);
    expect((await read()).entries).toHaveLength(2);
    await go("https://superseded.example/", true);
    const latestNavigation = await go("https://latest.example/", false);
    await sendSurfaces([
      surface("page-integration", "https://latest.example/", "latest", {
        navigationId: latestNavigation,
      }),
    ]);
    expect((await read()).entries[0]).toMatchObject({
      url: "https://latest.example/",
      typedCount: 0,
    });

    await changed();
    // A reused browser may publish the opened tab before its correlated CDP result.
    const beforeOpen = runtime.receivedCommands().length;
    const secondOpen = testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "browser.tab.open",
        sessionId,
        url: "https://second.example/",
        typed: false,
        idempotencyKey: "history-second",
      },
      { headers: host.ownerHeaders },
    );
    void secondOpen.catch(() => undefined);
    const openCommand = await request("Opensteer.openTab", beforeOpen);
    await sendSurfaces([
      surface("page-integration", "https://latest.example/", "latest", { active: false }),
      surface("second-page", "https://www.second.example/", "second", {
        favicon: iconA,
        order: 1,
        navigationId: openCommand.navigationId,
      }),
    ]);
    answer(openCommand, { tabId: "second-page" });
    await secondOpen;
    expect((await read()).entries[0]).toMatchObject({
      url: "https://www.second.example/",
      visitCount: 1,
      typedCount: 0,
    });
    await changed();
    await sendSurfaces([]);
    iconRef = (await read()).icons.find(
      (icon) => icon.origin === "https://www.second.example",
    )!.iconRef;
    expect(
      await testRpcData(
        host.origin,
        "browser.history.icons.get",
        { profileId, iconRefs: [iconRef] },
        { headers: host.ownerHeaders },
      ),
    ).toEqual({ icons: [{ iconRef, favicon: iconA }] });

    for (const method of ["browser.history.get", "browser.history.icons.get"] as const) {
      const response =
        method === "browser.history.get"
          ? await testRpcRequest(host.origin, method, { profileId }, { headers: stranger.headers })
          : await testRpcRequest(
              host.origin,
              method,
              { profileId, iconRefs: [iconRef] },
              { headers: stranger.headers },
            );
      expect(response.status).toBe(404);
    }
    for (const command of [
      {
        type: "browser.history.remove" as const,
        profileId,
        url: "https://www.second.example/",
        idempotencyKey: "unauthorized-remove",
      },
      { type: "browser.history.clear" as const, profileId, idempotencyKey: "unauthorized-clear" },
    ]) {
      const response = await testRpcRequest(host.origin, "commands.dispatch", command, {
        headers: stranger.headers,
      });
      expect(response.status).toBe(404);
    }
    await mutate("browser.history.remove", "history-remove", "https://www.second.example/");
    expect((await read()).icons.some((icon) => icon.origin === "https://www.second.example")).toBe(
      false,
    );
    await changed();
    await sendSurfaces([surface("page-integration", "https://latest.example/", "latest")]);
    const clearedNavigation = await go("https://pending-clear.example/");
    await mutate("browser.history.clear", "history-clear");
    await changed();
    await sendSurfaces([
      surface("page-integration", "https://pending-clear.example/", "cleared", {
        favicon: iconA,
        navigationId: clearedNavigation,
      }),
    ]);
    expect((await read()).entries).toMatchObject([{ url: "https://pending-clear.example/" }]);
    await changed();
    // A replay neither erases the new visit nor publishes another invalidation.
    await mutate("browser.history.clear", "history-clear");
    expect((await read()).entries).toHaveLength(1);
    await mutate("browser.history.clear", "clear-before-revisit");
    await changed();
    const revisitNavigation = await go("https://pending-clear.example/");
    await sendSurfaces([
      surface("page-integration", "https://pending-clear.example/", "revisited", {
        navigationId: revisitNavigation,
      }),
    ]);
    await changed();
    expect((await read()).icons).toContainEqual({
      origin: "https://pending-clear.example",
      iconRef: expect.any(String),
    });
    await mutate("browser.history.remove", "remove-new", "https://pending-clear.example/");
    await changed();
    await host.store.browserHistory.recordVisit({
      profileId,
      ownerId: host.ownerId,
      url: "https://expired.example/",
      title: "Expired",
      typed: false,
    });
    await host.store.database
      .updateTable("browserHistoryEntries")
      .set({ lastVisitAt: new Date(0) })
      .where("profileId", "=", profileId)
      .execute();
    await host.runtime.browser.pruneHistory();
    await changed();
    expect(await read()).toEqual({ entries: [], icons: [] });
    // Guest navigation never writes a profile's history or icon rows.
    const guest = await host.runtime.browser.start({
      ownerId: host.ownerId,
      workspaceId: workspace.id,
      fresh: true,
    });
    const guestViewer = new WebSocket(
      `ws://127.0.0.1:${host.hostPort}/v1/browser-sessions/${guest.session.id}/connect`,
      { headers: host.ownerHeaders },
    );
    cleanups.push(async () => {
      guestViewer.close();
      await closed(guestViewer);
    });
    await waitForMessage(guestViewer, (message) => message.type === "browser.snapshot");
    guestViewer.send(
      JSON.stringify({
        type: "navigation.go",
        surfaceId: "page-integration",
        url: "https://guest.example/",
        typed: true,
      }),
    );
    const guestCommitted = waitForMessage(
      guestViewer,
      (message) => message.type === "browser.surfaces.changed",
    );
    runtime.sendServer(
      {
        type: "browser.surfaces.changed",
        surfaces: [
          surface("page-integration", "https://guest.example/", "guest", { favicon: iconA }),
        ],
      },
      guest.session.id,
    );
    await guestCommitted;
    expect(await read()).toEqual({ entries: [], icons: [] });
    expect(
      await host.store.database.selectFrom("browserHistoryEntries").selectAll().execute(),
    ).toEqual([]);
    await host.runtime.browser.deleteProfile({ ownerId: host.ownerId, profileId });
    await host.runtime.browser.deleteProfile({ ownerId: host.ownerId, profileId });
    await expect(host.runtime.browser.readHistory(host.ownerId, profileId)).rejects.toMatchObject({
      code: "not_found",
    });
    // A history mutation is a delivery barrier: neither deletion emits a history notice.
    const otherProfile = await host.store.createBrowserProfile({
      ownerId: host.ownerId,
      name: "Other",
      idempotencyKey: "other-history-profile",
    });
    await host.store.browserHistory.recordVisit({
      profileId: otherProfile.id,
      ownerId: host.ownerId,
      url: "https://other.example/",
      title: "Other",
      typed: false,
    });
    const otherChanged = devices.slice(0, 2).map((device) => device.messages.length);
    await host.runtime.browser.forgetHistory(host.ownerId, {
      profileId: otherProfile.id,
      idempotencyKey: "history-after-profile-deletion",
    });
    await vi.waitFor(
      () => {
        for (const [index, device] of devices.slice(0, 2).entries()) {
          expect(device.messages.length).toBeGreaterThan(otherChanged[index]!);
          expect(notices(device)).toHaveLength(noticeCount + 1);
          expect(notices(device).at(-1)).toEqual({
            type: "host.browser-history-changed",
            profileId: otherProfile.id,
          });
        }
      },
      { timeout: 5_000 },
    );
    expect(notices(devices[2]!)).toEqual([]);
  }, 60_000);

  it("stores live icons, survives Runtime end and Host restart, and serves them lazily to the owner", async () => {
    const database = await createMachineAccessDatabase(databaseUrl!);
    cleanups.push(() => database.drop());
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    cleanups.push(() => host.close());
    const caller = await connectCallerMachine(host, {
      name: "Icon caller",
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "icon-caller",
        name: "Icon caller",
      }),
    });
    cleanups.push(() => caller.close());
    const run = await dispatchCallerRun(host, caller, { key: "icons", title: "Icons" });
    const runtime = await startBrowserRuntime(
      host.hostPort,
      await enrollmentToken(host, {
        allowedModules: ["browser"],
        idempotencyKey: "icon-browser",
        name: "Icon browser",
      }),
      { agentReady: true, targetedStreaming: true, workspaceTabs: true },
    );
    cleanups.push(() => runtime.close());
    await until(() => (host.runtime.browser.available ? true : undefined));
    const owner = await listen(host, run.workspaceId);
    cleanups.push(() => owner.close());
    const opened = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "browser.session.start",
        workspaceId: run.workspaceId,
        idempotencyKey: "icon-session",
        input: { fresh: true },
      },
      { headers: host.ownerHeaders },
    );
    if (opened.type !== "browser.session.start") throw new Error("Unexpected command");
    const sessionId = opened.session.id;
    let db = host.store.database;
    const row = (id: string) =>
      db.selectFrom("workspaceTabs").selectAll().where("id", "=", id).executeTakeFirst();
    const revision = async () =>
      (
        await db
          .selectFrom("browserSessions")
          .select("tabRevision")
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow()
      ).tabRevision;
    const tabsChanged = () =>
      owner.messages.filter(
        (message) =>
          message.type === "host.browser-tabs-changed" && message.sessionId === sessionId,
      ).length;
    const settledNotice = async (from: number) =>
      until(
        () => (tabsChanged() > from ? true : undefined),
        () => owner.messages.map((message) => message.type),
      );
    const surface = (
      id: string,
      url: string,
      favicon: string | undefined,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      active: id === "page-a",
      title: id.toUpperCase(),
      url,
      order: id === "page-a" ? 0 : 1,
      documentId: `document-${id}`,
      geometryRevision: 1,
      openerId: null,
      ...(favicon ? { favicon } : {}),
      ...extra,
    });
    const descriptor = (id: string, url: string) => ({
      id,
      title: id.toUpperCase(),
      url,
      order: id === "page-a" ? 0 : 1,
      openerId: null,
    });
    const urlOne = "https://a.example/one?token=hidden";
    const urlTwo = "https://a.example/two";
    const urlB = "https://b.example/";
    const steps: Record<string, unknown>[] = [];

    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [surface("page-a", urlOne, iconA), surface("page-b", urlB, undefined)],
    });
    runtime.sendServer({
      type: "browser.workspace-tabs",
      tabs: [descriptor("page-a", urlOne), descriptor("page-b", urlB)],
      closed: ["page-integration"],
    });
    await until(
      async () => ((await row("page-a"))?.favicon === iconA ? true : undefined),
      async () => row("page-a"),
    );
    expect((await row("page-b"))?.favicon ?? null).toBeNull();
    const stored = await revision();
    steps.push({ step: "live icon stored", revision: stored });

    // An icon-only change: the Runtime's durable descriptors do not change.
    let notices = tabsChanged();
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [surface("page-a", urlOne, iconB), surface("page-b", urlB, undefined)],
    });
    await until(
      async () => ((await row("page-a"))?.favicon === iconB ? true : undefined),
      async () => row("page-a"),
    );
    await settledNotice(notices);
    expect(await revision()).toBe(stored + 1);
    steps.push({ step: "icon-only change stored", revision: await revision() });

    // Loading, geometry and a transiently absent icon on the same page are not writes.
    notices = tabsChanged();
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        surface("page-a", urlOne, undefined, { loading: true, geometryRevision: 2 }),
        surface("page-b", urlB, undefined, { geometryRevision: 2 }),
      ],
    });
    await settledNotice(notices);
    const retainedCatalog = await testRpcData(
      host.origin,
      "browser.tabs.get",
      { sessionId },
      { headers: host.ownerHeaders },
    );
    expect(retainedCatalog.tabs.find((tab) => tab.id === "page-a")?.iconRef).toBe(
      (await row("page-a"))?.iconRef,
    );
    notices = tabsChanged();
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        surface("page-a", urlOne, iconB, { geometryRevision: 3 }),
        surface("page-b", urlB, undefined, { geometryRevision: 3 }),
      ],
    });
    await settledNotice(notices);
    expect(await revision()).toBe(stored + 1);
    expect((await row("page-a"))?.favicon).toBe(iconB);
    steps.push({ step: "loading and geometry not stored", revision: await revision() });

    // A committed navigation clears the old icon before the new page names one.
    notices = tabsChanged();
    runtime.sendServer({
      type: "browser.workspace-tabs",
      tabs: [descriptor("page-a", urlTwo), descriptor("page-b", urlB)],
      closed: [],
    });
    await until(
      async () => ((await row("page-a"))?.url === urlTwo ? true : undefined),
      async () => row("page-a"),
    );
    await settledNotice(notices);
    expect((await row("page-a"))?.favicon ?? null).toBeNull();
    expect((await row("page-a"))?.iconRef ?? null).toBeNull();
    // The descriptor arrives first; a flush must not copy the preceding document's image.
    expect((await row("page-a"))?.url).toBe(urlTwo);
    // An icon shown while the address differs from the committed one is not stored.
    notices = tabsChanged();
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        surface("page-a", "https://a.example/three", iconC),
        surface("page-b", urlB, undefined),
      ],
    });
    await settledNotice(notices);
    expect((await row("page-a"))?.favicon ?? null).toBeNull();
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [surface("page-a", urlTwo, iconC), surface("page-b", urlB, undefined)],
    });
    // Only the raw URL changed, at the same origin and with identical icon bytes.
    await until(async () => ((await row("page-a"))?.favicon === iconC ? true : undefined));
    runtime.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [surface("page-a", urlTwo, iconA), surface("page-b", urlB, undefined)],
    });
    await until(
      async () => ((await row("page-a"))?.favicon === iconA ? true : undefined),
      async () => row("page-a"),
    );
    steps.push({ step: "navigation cleared then settled", revision: await revision() });

    const coldTabs = async () => {
      const bootstrap = await testRpcData(
        host.origin,
        "bootstrap.get",
        {},
        {
          headers: host.ownerHeaders,
        },
      );
      const group = bootstrap.browser.workspaceTabs?.find((group) => group.id === sessionId);
      const read = await testRpcData(
        host.origin,
        "workspace.tabs.get",
        { groupId: sessionId },
        { headers: host.ownerHeaders },
      );
      expect(JSON.stringify(group)).not.toContain("data:image");
      expect(JSON.stringify(read)).not.toContain("data:image");
      const refs = (
        tabs: readonly { id: string; iconRef?: string | null | undefined }[] | undefined,
      ) => Object.fromEntries((tabs ?? []).map((tab) => [tab.id, tab.iconRef ?? null]));
      expect(refs(read.tabs)).toEqual(refs(group?.tabs));
      return { group, refs: refs(read.tabs) };
    };
    const live = await coldTabs();
    expect(live.refs["page-a"]).toEqual(expect.any(String));
    expect(live.refs["page-b"]).toBeNull();
    const iconRef = live.refs["page-a"]!;
    const fetchIcon = (headers: Record<string, string>, ref = iconRef) =>
      testRpcRequest(host.origin, "browser.tabIcon.get", { sessionId, iconRef: ref }, { headers });
    const liveIcon = await fetchIcon(host.ownerHeaders);
    expect(liveIcon.status).toBe(200);
    expect(JSON.stringify(await liveIcon.json())).toContain(iconA);

    // The Runtime ends: the tabs are dormant and their icons are still served from the store.
    const sessionCount = async () =>
      Number(
        (
          await db
            .selectFrom("browserSessions")
            .select((eb) => eb.fn.countAll().as("count"))
            .executeTakeFirstOrThrow()
        ).count,
      );
    const sessionsBefore = await sessionCount();
    await runtime.close();
    await until(
      async () => ((await row("page-a"))?.state === "suspended" ? true : undefined),
      async () => row("page-a"),
      30_000,
    );
    const commandsAfterEnd = runtime.receivedCommands().length;
    const ended = await coldTabs();
    expect(ended.refs).toEqual(live.refs);
    expect(ended.group?.tabs?.map((tab) => tab.state)).toEqual(["suspended", "suspended"]);
    const endedIcon = await fetchIcon(host.ownerHeaders);
    expect(endedIcon.status).toBe(200);
    expect(await endedIcon.json()).toMatchObject({ data: { favicon: iconA } });
    steps.push({ step: "icon served after Runtime end", status: endedIcon.status });

    // The Host restarts against the same database; the Runtime does not return.
    await host.runtime.close();
    const restarted = await createHostRuntime(host.config);
    db = restarted.store.database;
    cleanups.push(() => restarted.close());
    await restarted.listen();
    const restartedHost: MachineAccessHost = {
      ...host,
      runtime: restarted,
      store: restarted.store,
    };
    const afterRestart = await coldTabs();
    expect(afterRestart.refs).toEqual(live.refs);
    const restartedIcon = await fetchIcon(host.ownerHeaders);
    expect(restartedIcon.status).toBe(200);
    expect(await restartedIcon.json()).toMatchObject({ data: { favicon: iconA } });
    const stranger = await signUpUser(restartedHost, {
      email: "icon-stranger@example.com",
      password: "icon-stranger-password",
    });
    const strangerIcon = await fetchIcon(stranger.headers);
    expect(strangerIcon.status).toBe(404);
    expect(await strangerIcon.text()).not.toContain("data:image");
    const wrongRef = await fetchIcon(host.ownerHeaders, "A".repeat(43));
    expect(await wrongRef.text()).not.toContain("data:image");
    // Reading icons neither restored the browser nor reached the departed Runtime.
    expect(await sessionCount()).toBe(sessionsBefore);
    expect(runtime.receivedCommands()).toHaveLength(commandsAfterEnd);
    expect(runtime.receivedCommands().some((command) => command.type === "stream.subscribe")).toBe(
      false,
    );
    expect((await row("page-a"))?.state).toBe("suspended");
    steps.push({ step: "icon served after Host restart", status: restartedIcon.status });

    const closedTab = await testRpcData(
      host.origin,
      "commands.dispatch",
      { type: "workspace.tab.close", tabId: "page-a", idempotencyKey: "icon-close" },
      { headers: host.ownerHeaders },
    );
    expect(closedTab.type).toBe("workspace.tab.close");
    const revoked = await fetchIcon(host.ownerHeaders);
    const revokedBody = await revoked.text();
    expect(revokedBody).not.toContain("data:image");
    expect(revoked.status === 404 || JSON.parse(revokedBody).data?.favicon === null).toBe(true);
    steps.push({ step: "closed tab revoked", status: revoked.status });

    const directory = process.env.OPENSTEER_BROWSER_PRESENCE_ARTIFACT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "durable-favicon.json"),
        JSON.stringify(
          {
            sessionId,
            iconRef,
            refs: { live: live.refs, ended: ended.refs, restarted: afterRestart.refs },
            steps,
            statuses: {
              live: liveIcon.status,
              ended: endedIcon.status,
              restarted: restartedIcon.status,
              stranger: strangerIcon.status,
              wrongRef: wrongRef.status,
              revoked: revoked.status,
            },
            runtimeCommands: runtime.receivedCommands(),
            protocolErrors: runtime.protocolErrors(),
          },
          null,
          2,
        ),
      );
    }
  }, 120_000);
});
