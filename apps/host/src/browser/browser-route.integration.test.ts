import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import type { HostConfig } from "@opensteer/config";
import { createDatabase, migrateToLatest } from "@opensteer/database";
import {
  BrowserServerMessageSchema,
  decodeBrowserFrameEnvelope,
  hostApiVersionHeader,
} from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { sql } from "kysely";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostRuntime, type HostRuntime } from "../runtime/runtime.js";
import { startPortableFsManagerFake as startPortableFsController } from "../runtime/portablefs-manager.test-support.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const accessToken = "browser-access-".padEnd(40, "a");

integration("Host browser broker vertical", () => {
  let browserRuntime: Awaited<ReturnType<typeof startBrowserRuntime>> | undefined;
  let dataDirectory: string | undefined;
  let portableFs: Awaited<ReturnType<typeof startPortableFsController>> | undefined;
  let runtime: HostRuntime | undefined;
  let uiSocket: WebSocket | undefined;

  beforeEach(async () => {
    const database = createDatabase({ connectionString: databaseUrl ?? "postgres://unconfigured" });
    await migrateToLatest(database);
    await sql`
      truncate table
        credential_access_audit,
        credential_vault_canaries,
        browser_profile_grants,
        browser_sessions,
        browser_profile_revisions,
        browser_profiles,
        credentials,
        workspace_events,
        commands,
        provider_sessions,
        messages,
        runs,
        threads,
        harness_instances,
        workspaces,
        execution_environments,
        runners,
        deployments,
        users
      restart identity cascade
    `.execute(database);
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
    await database.destroy();
  });

  afterEach(async () => {
    uiSocket?.terminate();
    await runtime?.close();
    await Promise.allSettled([browserRuntime?.close(), portableFs?.close()]);
    if (dataDirectory) await rm(dataDirectory, { force: true, recursive: true });
  });

  it("keeps Browser Runtime private while relaying authenticated view and input", async () => {
    portableFs = await startPortableFsController();
    dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-browser-host-integration-"));
    const hostPort = await freePort();
    const config: HostConfig = {
      acceptsExternalRunners: true,
      authSecret: "browser-auth-secret".padEnd(40, "x"),
      bindAddress: "127.0.0.1",
      canonicalOrigin: new URL(`http://127.0.0.1:${hostPort}`),
      browserRuntime: { attachKeyId: "host-integration" },
      browserProfileKeyPath: undefined,
      credentialKeyPath: undefined,
      databaseUrl: databaseUrl ?? "postgres://unconfigured",
      dataDirectory,
      identity: {
        initialOwnerEnrollment: { lifetimeSeconds: 3_600, token: accessToken },
        localPasswordEnabled: true,
        oidcConfigPath: undefined,
        signupPolicy: "invite-only",
      },
      executionLeaseMs: 90_000,
      maxConcurrentDispatches: 2,
      maxConcurrentTriggerDispatches: 2,
      mode: "development",
      port: hostPort,
      exposure: "networked" as const,
      privateKeyPath: undefined,
      publicKeyPath: undefined,
      runtimeOrigin: new URL(`http://127.0.0.1:${hostPort}`),
      workspace: {
        deletionRetentionDays: 14,
        shape: {
          defaultWorkspaceBacking: "portablefs",
          kind: "server" as const,
        },
        storage: {
          archiveAfterDays: 7,
          authorizationDomain: "opensteer-test",
          defaultBlockLimitBytes: 10 * 1_024 * 1_024 * 1_024,
          defaultInodeLimit: 1_000_000,
          filesServiceUrl: new URL("http://127.0.0.1:4315"),
          kind: "portablefs",
          maxBlockLimitBytes: 100 * 1_024 * 1_024 * 1_024,
          maxInodeLimit: 10_000_000,
          managerCaPath: undefined,
          managerCertPath: undefined,
          managerKeyPath: undefined,
          managerServerName: undefined,
          managerUrl: portableFs.url,
          productIssuer: "opensteer-test",
          productPrivateKeyPath: undefined,
          serviceId: "test-portablefs",
        },
      },
    };
    runtime = await createHostRuntime(config);
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    const cookie = await setupInitialOwner(origin, accessToken);
    const sessionHeaders = { cookie, origin };
    // The browser is a module of an enrolled computer: it dials the Host and
    // relays over its own stream, so no Runtime address is ever configured.
    const enrollment = await testRpcData(
      origin,
      "commands.dispatch",
      {
        allowedModules: ["browser"],
        idempotencyKey: "browser-relay-computer",
        name: "Relay computer",
        type: "runner.enrollment.createLocal",
      },
      { headers: sessionHeaders },
    );
    if (enrollment.type !== "runner.enrollment.createLocal") {
      throw new Error("Runner enrollment command mismatch.");
    }
    browserRuntime = await startBrowserRuntime(hostPort, enrollment.token, {
      agentReady: true,
      navigation: true,
    });

    const created = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-workspace-1",
        name: "Browser workspace",
        type: "workspace.create",
      },
      { headers: sessionHeaders },
    );
    if (created.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    // Identity is explicit at open: profiles are never auto-provisioned.
    const createdProfile = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-profile-1",
        input: { name: "Integration browser" },
        type: "browser.profile.create",
      },
      { headers: sessionHeaders },
    );
    if (createdProfile.type !== "browser.profile.create")
      throw new Error("Profile command mismatch.");
    const starting = testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-session-1",
        input: {
          initialUrl: "https://example.com/",
          profileId: createdProfile.profile.id,
          reuseExisting: false,
        },
        type: "browser.session.start",
        workspaceId: created.workspace.id,
      },
      { headers: sessionHeaders },
    );
    const targets = await browserRuntime.nextCommand();
    browserRuntime.sendServer({
      type: "cdp.result",
      requestId: targets.requestId,
      result: { targetInfos: [{ targetId: "target-integration", type: "page" }] },
    });
    const attach = await browserRuntime.nextCommand();
    browserRuntime.sendServer({
      type: "cdp.result",
      requestId: attach.requestId,
      result: { sessionId: "cdp-integration" },
    });
    const navigation = await browserRuntime.nextCommand();
    expect(navigation).toMatchObject({
      type: "cdp.command",
      command: {
        method: "Page.navigate",
        parameters: { url: "https://example.com/" },
        sessionId: "cdp-integration",
      },
    });
    browserRuntime.sendServer({
      type: "cdp.result",
      requestId: navigation.requestId,
      result: { frameId: "frame-integration" },
    });
    const detach = await browserRuntime.nextCommand();
    browserRuntime.sendServer({ type: "cdp.result", requestId: detach.requestId, result: {} });
    const started = await starting;
    if (started.type !== "browser.session.start") throw new Error("Session command mismatch.");
    expect(started.session).toMatchObject({
      runtimeId: "browser-runtime-integration",
      navigationVersion: 1,
      state: "ready",
      workspaceId: created.workspace.id,
    });
    expect(browserRuntime.connectionCount()).toBe(1);
    const profileClaims = browserRuntime.lastClaims();
    if (profileClaims?.identity.kind !== "profile") {
      throw new Error("Browser Runtime did not retain its profile attach claims.");
    }
    expect(profileClaims.navigationVersion).toBe(1);
    const { profileLeaseToken, profileStateUrl } = profileClaims.identity;
    const loadedProfile = await jsonFetch(profileStateUrl, {
      headers: authorization(profileLeaseToken),
    });
    expect(loadedProfile).toEqual({ revision: 0, snapshot: { cookies: [], origins: [] } });
    const committedProfile = await jsonFetch(profileStateUrl, {
      body: JSON.stringify({
        expectedRevision: 0,
        snapshot: { cookies: [], origins: [] },
      }),
      headers: {
        ...authorization(profileLeaseToken),
        "content-type": "application/json",
      },
      method: "PUT",
    });
    expect(committedProfile).toMatchObject({ revision: 1 });

    await expectUpgradeRejected(
      `ws://127.0.0.1:${hostPort}/v1/browser-sessions/${started.session.id}/connect`,
      { cookie, origin: "http://evil.example" },
      403,
    );

    const connected = await openBrowserSocket(
      `ws://127.0.0.1:${hostPort}/v1/browser-sessions/${started.session.id}/connect`,
      { cookie, origin },
    );
    uiSocket = connected.socket;
    expect(connected.messages.map((message) => message.type)).toEqual(["browser.snapshot"]);
    uiSocket.send(JSON.stringify({ type: "stream.subscribe" }));
    await expect(browserRuntime.nextCommand()).resolves.toMatchObject({
      type: "stream.subscribe",
    });
    const framePromise = waitForBinary(uiSocket);
    browserRuntime.sendFrame(browserFrame(3));
    expect((await framePromise).subarray(-4)).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

    uiSocket.send(JSON.stringify({ type: "navigation.reload", ignoreCache: true }));
    await expect(browserRuntime.nextCommand()).resolves.toMatchObject({
      type: "navigation.reload",
      ignoreCache: true,
    });
    uiSocket.send(
      JSON.stringify({
        height: 1_000,
        surfaceId: "page-integration",
        type: "viewport.set",
        width: 1_600,
      }),
    );
    await expect(browserRuntime.nextCommand()).resolves.toEqual({
      height: 1_000,
      surfaceId: "page-integration",
      type: "viewport.set",
      width: 1_600,
    });

    const watched = await openBrowserSocket(
      `ws://127.0.0.1:${hostPort}/v1/browser-sessions/${started.session.id}/connect?mode=watch`,
      { cookie, origin },
    );
    const watchSocket = watched.socket;
    const watchFrames: Buffer[] = [];
    watchSocket.on("message", (raw, isBinary) => {
      if (isBinary) watchFrames.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
    });
    // Joining a stream already under way starts from its current picture.
    const firstWatchFrame = waitForBinary(watchSocket);
    watchSocket.send(JSON.stringify({ type: "stream.subscribe" }));
    const firstWatchHeader = decodeBrowserFrameEnvelope(await firstWatchFrame).header;
    expect(firstWatchHeader.frameId).toBe(3);
    expect(firstWatchHeader.watchToken).toBeDefined();
    const fastViewerFrame = waitForFrameId(uiSocket, 6);
    browserRuntime.sendFrame(browserFrame(4));
    browserRuntime.sendFrame(browserFrame(5));
    browserRuntime.sendFrame(browserFrame(6));
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(watchFrames).toHaveLength(1);
    expect((await fastViewerFrame).frameId).toBe(6);
    // A new title or address while a picture is out is the same picture: its
    // acknowledgement still counts and nothing is dropped.
    browserRuntime.sendServer({
      surfaces: [
        {
          active: true,
          id: "page-integration",
          canGoBack: true,
          canGoForward: false,
          title: "Renamed page",
          url: "https://example.com/next",
        },
      ],
      type: "browser.surfaces.changed",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const latestWatchFrame = waitForBinary(watchSocket);
    watchSocket.send(JSON.stringify({ type: "stream.ack", token: firstWatchHeader.watchToken }));
    const latestWatchHeader = decodeBrowserFrameEnvelope(await latestWatchFrame).header;
    expect(latestWatchHeader.frameId).toBe(6);
    expect(latestWatchHeader.watchToken).not.toBe(firstWatchHeader.watchToken);
    for (const frames of [connected.messages, watched.messages]) {
      for (const frame of frames) {
        if (frame.type !== "browser.snapshot" && frame.type !== "browser.surfaces.changed")
          continue;
        const parsed = BrowserServerMessageSchema.parse(frame);
        if (parsed.type !== "browser.snapshot" && parsed.type !== "browser.surfaces.changed")
          throw new Error("Expected browser surfaces");
        const surfaces = parsed.surfaces;
        expect(surfaces).toHaveLength(1);
        expect(surfaces[0]).not.toHaveProperty("canGoBack");
        expect(surfaces[0]).not.toHaveProperty("canGoForward");
      }
    }
    const catalog = await testRpcData(
      origin,
      "browser.tabs.get",
      { sessionId: started.session.id },
      { headers: sessionHeaders },
    );
    expect(catalog.tabs[0]).toMatchObject({ canGoBack: true, canGoForward: false });
    // A late or repeated acknowledgement changes nothing and ends nothing.
    watchSocket.send(JSON.stringify({ type: "stream.ack", token: firstWatchHeader.watchToken }));
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(watchSocket.readyState).toBe(WebSocket.OPEN);
    const watchClosed = waitForClose(watchSocket);
    watchSocket.send(JSON.stringify({ type: "navigation.reload" }));
    expect((await watchClosed).code).toBe(4002);

    const secondViewer = await openBrowserSocket(
      `ws://127.0.0.1:${hostPort}/v1/browser-sessions/${started.session.id}/connect?mode=watch`,
      { cookie, origin },
    );
    const currentPicture = waitForBinary(secondViewer.socket);
    secondViewer.socket.send(JSON.stringify({ type: "stream.subscribe" }));
    const currentHeader = decodeBrowserFrameEnvelope(await currentPicture).header;
    expect(currentHeader.frameId).toBe(6);
    secondViewer.socket.send(
      JSON.stringify({ type: "stream.ack", token: firstWatchHeader.watchToken }),
    );
    const nextPicture = waitForBinary(secondViewer.socket);
    browserRuntime.sendFrame(browserFrame(7));
    secondViewer.socket.send(
      JSON.stringify({ type: "stream.ack", token: currentHeader.watchToken }),
    );
    expect(decodeBrowserFrameEnvelope(await nextPicture).header.frameId).toBe(7);
    expect(secondViewer.socket.readyState).toBe(WebSocket.OPEN);
    secondViewer.socket.close();
    const deliveredFrameIds = watchFrames.map(
      (frame) => decodeBrowserFrameEnvelope(frame).header.frameId,
    );

    const bootstrap = await testRpcData(origin, "bootstrap.get", {}, { headers: { cookie } });
    expect(bootstrap.browser).toMatchObject({
      available: true,
      profiles: [{ name: "Integration browser" }],
      sessions: [{ attachedRunIds: [], id: started.session.id, state: "ready" }],
    });
    // Only an active Run holds a session; one that is not running holds nothing.
    const projectionRunId = createId("run");
    await expect(
      runtime.store.attachBrowserSession({
        agentBindingId: `run:${projectionRunId}`,
        ownerId: bootstrap.user.id,
        sessionId: started.session.id,
        workspaceId: started.session.workspaceId,
      }),
    ).resolves.toBe(false);
    const detachedBootstrap = await testRpcData(
      origin,
      "bootstrap.get",
      {},
      { headers: { cookie } },
    );
    expect(
      detachedBootstrap.browser.sessions.find(
        (session: { id: string }) => session.id === started.session.id,
      ),
    ).toMatchObject({ acting: false, attachedRunIds: [] });

    // A fresh session needs no profile and no grant, and carries no lease.
    const freshWorkspace = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-workspace-2",
        name: "Fresh workspace",
        type: "workspace.create",
      },
      { headers: sessionHeaders },
    );
    if (freshWorkspace.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    const freshSession = await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-session-2",
        input: { fresh: true, reuseExisting: false },
        type: "browser.session.start",
        workspaceId: freshWorkspace.workspace.id,
      },
      { headers: sessionHeaders },
    );
    if (freshSession.type !== "browser.session.start") throw new Error("Session command mismatch.");
    expect(freshSession.session).toMatchObject({ profileId: null, state: "ready" });
    expect(browserRuntime.lastClaims()?.identity).toEqual({ kind: "fresh" });

    const saving = testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-save-profile-1",
        input: { name: "Saved login" },
        sessionId: freshSession.session.id,
        type: "browser.session.profile.save",
      },
      { headers: sessionHeaders },
    );
    await expect(browserRuntime.nextCommand()).resolves.toMatchObject({ type: "state.export" });
    browserRuntime.sendServer({
      snapshot: { cookies: [], origins: [] },
      type: "state.exported",
    });
    await expect(saving).resolves.toMatchObject({
      profile: { name: "Saved login", revision: 1 },
    });

    const stopped = await testRpcRequest(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-close-1",
        sessionId: started.session.id,
        type: "browser.session.close",
      },
      { headers: sessionHeaders },
    );
    expect(stopped.status).toBe(200);
    expect(
      await fetch(profileStateUrl, {
        headers: authorization(profileLeaseToken),
      }),
    ).toMatchObject({ status: 200 });
    expect(
      await fetch(profileStateUrl, {
        headers: authorization("wrong-profile-lease"),
      }),
    ).toMatchObject({ status: 403 });

    const revocationViewer = await openBrowserSocket(
      `ws://127.0.0.1:${hostPort}/v1/browser-sessions/${freshSession.session.id}/connect?mode=watch`,
      { cookie, origin },
    );
    const revokedSocket = waitForClose(revocationViewer.socket);
    const inventory = await testRpcData(origin, "sessions.list", {}, { headers: { cookie } });
    const ownSession = inventory.sessions.find((item: { current: boolean }) => item.current);
    if (!ownSession) throw new Error("Current login was absent from session inventory.");
    await testRpcData(
      origin,
      "commands.dispatch",
      {
        idempotencyKey: "browser-watch-login-revoke",
        sessionId: ownSession.id,
        type: "session.revoke",
      },
      { headers: sessionHeaders },
    );
    const revokedCloseCode = (await revokedSocket).code;
    expect(revokedCloseCode).toBe(1008);

    const artifact = process.env.OPENSTEER_BROWSER_WATCH_ARTIFACT_PATH;
    if (artifact) {
      await writeFile(
        artifact,
        JSON.stringify(
          {
            mode: "watch",
            sessionId: started.session.id,
            sentFrameIds: [4, 5, 6],
            deliveredFrameIds,
            mutationCloseCode: 4002,
            staleAckIgnored: true,
            secondViewerFirstFrameId: 6,
            inactiveRunProjection: [],
            revokedSocketCloseCode: revokedCloseCode,
          },
          null,
          2,
        ),
      );
    }
  });
});

function expectUpgradeRejected(
  url: string,
  headers: Record<string, string>,
  expectedStatus: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => reject(new Error("Unexpected WebSocket upgrade success.")));
    socket.once("unexpected-response", (_request, response) => {
      if (response.statusCode === expectedStatus) resolve();
      else reject(new Error(`Expected HTTP ${expectedStatus}, received ${response.statusCode}.`));
      response.resume();
    });
    socket.once("error", () => undefined);
  });
}

function openBrowserSocket(
  url: string,
  headers: Record<string, string>,
): Promise<{ readonly messages: Array<{ type: string }>; readonly socket: WebSocket }> {
  return new Promise((resolve, reject) => {
    const messages: Array<{ type: string }> = [];
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => reject(new Error("Browser UI attach timed out.")), 5_000);
    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        if (new URL(url).searchParams.get("mode") !== "watch") {
          const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
          const { watchToken } = decodeBrowserFrameEnvelope(bytes).header;
          if (watchToken) socket.send(JSON.stringify({ type: "stream.ack", token: watchToken }));
        }
        return;
      }
      const message = JSON.parse(raw.toString()) as { type: string };
      messages.push(message);
      if (message.type !== "browser.snapshot") return;
      clearTimeout(timeout);
      resolve({ messages, socket });
    });
    socket.once("error", reject);
  });
}

async function setupInitialOwner(origin: string, token: string): Promise<string> {
  const exchanged = await fetch(`${origin}/v1/rpc/auth.setup.exchange`, {
    body: JSON.stringify({ token }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      origin,
    },
    method: "POST",
  });
  if (!exchanged.ok) throw new Error(`Setup exchange failed with HTTP ${exchanged.status}.`);
  const admissionCookies = responseCookies(exchanged);
  const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
    body: JSON.stringify({
      email: "browser-owner@example.com",
      kind: "password",
      password: "browser-owner-password",
    }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      cookie: admissionCookies.join("; "),
      origin,
    },
    method: "POST",
  });
  if (!claimed.ok) throw new Error(`Owner claim failed with HTTP ${claimed.status}.`);
  const sessionCookies = responseCookies(claimed);
  if (sessionCookies.length === 0) throw new Error("Host did not issue a session cookie.");
  return sessionCookies.join("; ");
}

function responseCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value));
}

function waitForBinary(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Browser frame timed out.")), 5_000);
    const receive = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
    };
    socket.on("message", receive);
  });
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

function waitForFrameId(socket: WebSocket, frameId: number): Promise<{ frameId: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`Browser frame ${frameId} timed out.`));
    }, 5_000);
    const receive = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      const header = decodeBrowserFrameEnvelope(buffer).header;
      if (header.frameId !== frameId) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve({ frameId: header.frameId });
    };
    socket.on("message", receive);
  });
}

function browserFrame(frameId: number): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      encoding: "jpeg",
      frameId,
      rasterHeight: 1,
      rasterWidth: 1,
      surfaceId: "page-integration",
      viewportHeight: 720,
      viewportWidth: 1_280,
    }),
  );
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const frame = Buffer.alloc(4 + header.byteLength + image.byteLength);
  frame.writeUInt32BE(header.byteLength, 0);
  header.copy(frame, 4);
  image.copy(frame, 4 + header.byteLength);
  return frame;
}

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const body = (await response.json()) as any;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function authorization(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
