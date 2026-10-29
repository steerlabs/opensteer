import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import { z } from "zod";
import { createId } from "@opensteer/core";
import {
  DeploymentCatalogSchema,
  DeploymentConnectionSchema,
  HostTransportError,
  resolveConnection,
  type DeploymentCatalog,
  type HostNetwork,
} from "@opensteer/client/connections";
import { HostSessionExchange } from "@opensteer/client/auth";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testDiscoveryEnvelope,
  testHostAuthorityKeys,
} from "@opensteer/client/test-support";
import { HostApiErrorSchema } from "@opensteer/protocol";
import { readBoundedText } from "@opensteer/shared/boundedJson";
import { registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { desktopWebPreferences } from "../src/app/electron-window.js";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { desktopBridgeChannels } from "../src/bridge/desktop-bridge-channels.js";
import type { DesktopBridgeContext } from "../src/bridge/context.js";
import {
  handleHostBinaryClose,
  handleHostBinaryFinish,
  handleHostBinaryOpen,
  handleHostBinaryRead,
  handleHostBinaryWrite,
  handleHostRequest,
} from "../src/bridge/methods/host.js";
import { DesktopHostTransport } from "../src/connections/host-transport.js";

const root = mkdtempSync(
  path.join(
    process.env.OPENSTEER_HOST_TRANSPORT_E2E_ARTIFACT_DIR ?? tmpdir(),
    "opensteer-host-transport-e2e-",
  ),
);
const artifactPath = path.join(root, "host-transport.json");
const legacy = process.env.OPENSTEER_TRANSPORT_EXPECT_LEGACY === "1";
const began = Date.now();
const events: object[] = [];
const cases: object[] = [];
app.setPath("userData", path.join(root, "profile"));
registerDesktopAppScheme(protocol);
app.on("window-all-closed", () => undefined);
const watchdog = setTimeout(() => finish(1, "Smoke exceeded its 45 second deadline."), 45_000);
void run().then(
  () => finish(0),
  (error: unknown) => finish(1, String(error instanceof Error ? error.stack : error)),
);

function record(kind: string, fields: object = {}): void {
  events.push({ ms: Date.now() - began, kind, ...fields });
}

function finish(code: number, error?: string): void {
  clearTimeout(watchdog);
  writeFileSync(
    artifactPath,
    `${JSON.stringify({ code, legacy, electron: process.versions.electron, cases, events, error }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ code, artifactPath, error })}\n`);
  app.exit(code);
}

async function run(): Promise<void> {
  await app.whenReady();
  const payload = Buffer.alloc(53_022_789, 120);
  const unauthorizedBody = Buffer.from(
    '{"ok":false,"error":{"code":"unauthorized","message":"Your Host session expired.","retryable":false}}',
  );
  const pending = new Set<string>();
  const counts = new Map<string, number>();
  let rpcMode: "large" | "stall" | "unreachable" | "normal" = "large";
  let sessionStatus = 200;
  const handleRequest: RequestListener = (request, response) => {
    const target = request.url ?? "/";
    const url = new URL(target, "http://localhost");
    const count = (counts.get(target) ?? 0) + 1;
    counts.set(target, count);
    pending.add(target);
    record("server.request", { target, count, socket: request.socket.remotePort });
    response.on("close", () => {
      pending.delete(target);
      record("server.close", { target });
    });
    const rpc = url.pathname === "/v1/rpc/auth.config";
    if (rpc && rpcMode === "unreachable") {
      response.destroy();
      return;
    }
    const unauthorized =
      (url.pathname === "/v1/recovery" && count === 1) ||
      url.pathname === "/v1/oversized-unauthorized" ||
      url.pathname === "/v1/stalled-unauthorized";
    const session = url.pathname === "/v1/auth/session-exchange";
    const stall =
      url.pathname === "/v1/stall" ||
      url.pathname === "/v1/stalled-unauthorized" ||
      session ||
      url.pathname === "/v1/auth/session" ||
      (rpc && rpcMode === "stall");
    response.statusCode = unauthorized ? 401 : session ? sessionStatus : 200;
    response.setHeader("content-type", "application/json");
    if (unauthorized) response.setHeader("cache-control", "no-store");
    if (stall) {
      response.setHeader("content-length", 128);
      response.write("{");
      return;
    }
    const large =
      url.pathname === "/v1/large" ||
      url.pathname === "/v1/chunked" ||
      url.pathname === "/v1/oversized-unauthorized" ||
      url.pathname === "/v1/rpc/attachment.content" ||
      (rpc && rpcMode === "large");
    const bytes = large
      ? payload
      : unauthorized
        ? unauthorizedBody
        : Buffer.from(
            '{"ok":false,"error":{"code":"forbidden","message":"Normal response arrived.","retryable":false}}',
          );
    if (url.pathname !== "/v1/chunked" && url.searchParams.get("chunked") !== "1")
      response.setHeader("content-length", bytes.byteLength);
    response.end(bytes);
  };
  const server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const keyPath = path.join(root, "session-key.pem");
  const certPath = path.join(root, "session-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  const secureServer = createSecureServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    handleRequest,
  );
  await new Promise<void>((resolve) => secureServer.listen(0, "127.0.0.1", resolve));
  const secureAddress = secureServer.address();
  assert(secureAddress && typeof secureAddress !== "string");
  const sessionOrigin = `https://127.0.0.1:${secureAddress.port}`;
  const now = "2026-10-16T12:00:00.000Z";
  const connection = DeploymentConnectionSchema.parse({
    authority: testDiscoveryEnvelope({
      canonicalOrigin: origin,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
    }),
    bootstrapMethods: ["password"],
    createdAt: now,
    endpoints: [{ kind: "canonical", origin, verifiedAt: now }],
    kind: "self-hosted",
    lastUsedAt: null,
    name: "Transport smoke",
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: now,
  });
  let catalog: DeploymentCatalog = DeploymentCatalogSchema.parse({
    deployments: [connection],
    revision: 1,
    schemaVersion: 4,
    selectedDeploymentId: connection.authority.document.deploymentId,
    updatedAt: now,
  });
  const store = {
    load: async () => catalog,
    select: async () => catalog,
    setPreferredEndpoint: async () => catalog,
    subscribe: () => () => undefined,
  };
  const network = new ElectronHostNetwork();
  const makeTransport = (
    sessions?: ConstructorParameters<typeof DesktopHostTransport>[0]["sessions"],
    hostNetwork: HostNetwork = network,
  ) =>
    new DesktopHostTransport({
      catalog: store,
      localRuntime: { current: async () => null },
      network: hostNetwork,
      projection: {
        read: async () => ({
          deployments: [],
          revision: 1,
          selectedDeploymentId: catalog.selectedDeploymentId,
        }),
      },
      ...(sessions ? { sessions } : {}),
    });
  const transport = makeTransport();
  const request = (target: string) =>
    transport.request({ headers: {}, method: "GET", path: target, timeoutMs: 500 });
  const failures: string[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      try {
        await request(`/v1/large?attempt=${index}`);
        assert.fail("Oversized response was accepted.");
      } catch (error) {
        if (!legacy)
          assert(error instanceof HostTransportError && error.code === "response-too-large");
        failures.push(error instanceof HostTransportError ? error.code : String(error));
      }
    }
    if (legacy) {
      await assert.rejects(request("/v1/normal"));
      assert.equal(counts.get("/v1/normal"), undefined);
      cases.push({
        case: "legacy-pool-starvation",
        failures,
        normalReachedServer: false,
        pending: [...pending],
      });
      return;
    }
    const normal = await request("/v1/normal");
    assert.equal(normal.status, 200);
    assert.match(normal.body, /Normal response arrived/u);
    cases.push({
      case: "eight-oversized-then-normal",
      failures,
      normalStatus: normal.status,
      normalReachedServer: counts.get("/v1/normal") === 1,
    });
    await assert.rejects(request("/v1/chunked"), { code: "response-too-large" });
    cases.push({ case: "chunked-limit", code: "response-too-large" });

    const keys = testHostAuthorityKeys();
    const authority = signTestDiscoveryEnvelope(
      {
        canonicalOrigin: origin,
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
        hostKey: { algorithm: "Ed25519" },
        deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
      },
      keys,
    );
    const route = signTestPersonalAccessRoute(
      {
        authority: authority.document,
        documentVersion: 2,
        purpose: "opensteer-personal-access-route",
        route: { generation: 1, kind: "private", origin: sessionOrigin },
      },
      keys,
    );
    const personal = DeploymentConnectionSchema.parse({
      ...connection,
      authority,
      bootstrapMethods: ["pairing-code"],
      endpoints: [{ kind: "direct", origin: sessionOrigin, verifiedAt: now }],
      kind: "personal",
      personalAccessRoute: route,
      preferredEndpointOrigin: sessionOrigin,
      reachability: "routed",
    });
    const resolved = resolveConnection(personal, null, { authorization: null });
    // This fresh partition trusts only the local server's test certificate.
    const testCertificate = readFileSync(certPath, "utf8").trim();
    session
      .fromPartition(`persist:opensteer-host-${resolved.deploymentId}`)
      .setCertificateVerifyProc((request, callback) =>
        callback(request.certificate.data.trim() === testCertificate ? 0 : -3),
      );
    const sessionExchange = new HostSessionExchange({
      application: "desktop",
      account: {
        issuePersonalHostSessionGrant: async () => {
          throw new Error("Private pairing must not request an Account grant.");
        },
      },
      fetch: (id, input, init) => network.partitionFetch(id, input, init),
      requestTimeoutMs: 250,
    });
    const sessionBegan = Date.now();
    await assert.rejects(
      sessionExchange.establish(resolved, { pairingCode: `osp_${"p".repeat(43)}` }),
      (error: unknown) => error instanceof Error && /in time/u.test(error.message),
    );
    await waitUntil(() => !pending.has("/v1/auth/session-exchange"));
    assert(Date.now() - sessionBegan < 2_000);
    cases.push({
      case: "session-stalled-body",
      elapsedMs: Date.now() - sessionBegan,
      connectionReleased: true,
    });
    sessionStatus = 403;
    await assert.rejects(
      sessionExchange.establish(resolved, { pairingCode: `osp_${"p".repeat(43)}` }),
      { outcome: "pairing-required" },
    );
    await waitUntil(() => !pending.has("/v1/auth/session-exchange"));
    assert.equal(
      await sessionExchange.probe({ ...resolved, key: `${resolved.key}-probe` }),
      "authenticated",
    );
    await waitUntil(() => !pending.has("/v1/auth/session"));
    cases.push({ case: "refused-session-and-probe", connectionReleased: true });

    for (const chunked of [false, true]) {
      let recoveryCalls = 0;
      const recovering = makeTransport({
        recoverUnauthorized: async () => {
          recoveryCalls += 1;
          return "recovered";
        },
      });
      const target = `/v1/oversized-unauthorized?chunked=${chunked ? 1 : 0}`;
      await assert.rejects(
        recovering.request({ headers: {}, method: "GET", path: target, timeoutMs: 500 }),
        { code: "response-too-large" },
      );
      await waitUntil(() => !pending.has(target));
      assert.equal(recoveryCalls, 0);
      assert.equal(counts.get(target), 1);
      assert.equal((await request(`/v1/normal?after-unauthorized=${chunked}`)).status, 200);
      cases.push({
        case: chunked ? "oversized-401-chunked" : "oversized-401",
        code: "response-too-large",
        connectionReleased: true,
        recoveryCalls,
        normalStatus: 200,
      });
    }
    let stalledRecoveryCalls = 0;
    const stalledRecovery = makeTransport({
      recoverUnauthorized: async () => {
        stalledRecoveryCalls += 1;
        return "recovered";
      },
    });
    await assert.rejects(
      stalledRecovery.request({
        headers: {},
        method: "GET",
        path: "/v1/stalled-unauthorized",
        timeoutMs: 250,
      }),
      { code: "timed-out" },
    );
    await waitUntil(() => !pending.has("/v1/stalled-unauthorized"));
    assert.equal(stalledRecoveryCalls, 0);
    cases.push({ case: "stalled-401", code: "timed-out", connectionReleased: true });

    const concurrentCount = 8;
    const exchangeSignals = new Map<string, AbortSignal>();
    let recoveriesStarted = 0;
    let recoveriesCompleted = 0;
    let unAbortedAtBarrier = 0;
    let releaseRecoveries: () => void = () => undefined;
    const allRecoveriesReady = new Promise<void>((resolve) => {
      releaseRecoveries = resolve;
    });
    const concurrentRecovery = makeTransport(
      {
        recoverUnauthorized: async ({ resolved }) => {
          const index = recoveriesStarted++;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1_500);
          try {
            const response = await network.partitionFetch(
              resolved.deploymentId,
              `${resolved.origin}/v1/recovery-session?concurrent=${index}`,
              { method: "POST", signal: controller.signal },
            );
            assert.equal(response.status, 200);
            assert.match(await response.text(), /Normal response arrived/u);
          } finally {
            controller.abort();
            clearTimeout(timeout);
          }
          recoveriesCompleted += 1;
          if (recoveriesCompleted === concurrentCount) {
            unAbortedAtBarrier = [...exchangeSignals.values()].filter(
              (signal) => !signal.aborted,
            ).length;
            record("recovery.barrier", {
              recoveriesStarted,
              recoveriesCompleted,
              unAbortedAtBarrier,
            });
            releaseRecoveries();
          }
          // A recovery must release its own socket before waiting for the rest.
          await allRecoveriesReady;
          return "recovered";
        },
      },
      {
        openWebSocket: (input, events) => network.openWebSocket(input, events),
        request: (input) => {
          exchangeSignals.set(input.request.path, input.signal);
          return network.request(input);
        },
      },
    );
    const concurrentResults = await Promise.allSettled(
      Array.from({ length: concurrentCount }, (_, index) =>
        concurrentRecovery.request({
          headers: {},
          method: "GET",
          path: `/v1/recovery?concurrent=${index}`,
          timeoutMs: 2_000,
        }),
      ),
    );
    cases.push({
      case: "concurrent-recoveries",
      partition: `persist:opensteer-host-${connection.authority.document.deploymentId}`,
      concurrentCount,
      recoveriesStarted,
      recoveriesCompleted,
      unAbortedAtBarrier,
      results: concurrentResults.map((result) =>
        result.status === "fulfilled"
          ? { status: result.status, responseStatus: result.value.status }
          : {
              status: result.status,
              reason: String(result.reason),
              code: result.reason instanceof HostTransportError ? result.reason.code : null,
            },
      ),
    });
    assert.equal(recoveriesStarted, concurrentCount);
    assert.equal(recoveriesCompleted, concurrentCount);
    assert.equal(unAbortedAtBarrier, concurrentCount);
    for (const [index, result] of concurrentResults.entries()) {
      assert.equal(result.status, "fulfilled");
      if (result.status !== "fulfilled") continue;
      assert.equal(result.value.status, 200);
      assert.match(result.value.body, /Normal response arrived/u);
      assert.equal(counts.get(`/v1/recovery?concurrent=${index}`), 2);
      assert.equal(counts.get(`/v1/recovery-session?concurrent=${index}`), 1);
    }

    for (const outcome of ["recovered", "blocked", "throws", "aborted", "timed-out"] as const) {
      const reason = new Error("Recovery interrupted by caller.");
      const controller = new AbortController();
      const recovering = makeTransport({
        recoverUnauthorized: async () => {
          if (outcome === "throws") throw reason;
          if (outcome === "timed-out") return new Promise<never>(() => undefined);
          if (outcome === "aborted") {
            controller.abort(reason);
            return new Promise<never>(() => undefined);
          }
          return outcome;
        },
      });
      const target = `/v1/recovery?outcome=${outcome}`;
      const result = recovering.exchange(
        { headers: {}, method: "GET", path: target, signal: controller.signal, timeoutMs: 500 },
        async (response) => {
          assert.equal(response.status, outcome === "blocked" ? 401 : 200);
          if (outcome === "blocked") {
            assert.equal(response.headers.get("content-type"), "application/json");
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal(response.headers.get("content-length"), String(unauthorizedBody.length));
          }
          return readBoundedText(response, {
            maximumBytes: 16 * 1_024 * 1_024,
            sizeError: () => new HostTransportError("response-too-large"),
          });
        },
      );
      if (outcome === "recovered") assert.match(await result, /Normal response arrived/u);
      else if (outcome === "blocked") assert.equal(await result, unauthorizedBody.toString());
      else if (outcome === "timed-out") await assert.rejects(result, { code: "timed-out" });
      else await assert.rejects(result, (error: unknown) => error === reason);
      await waitUntil(() => !pending.has(target));
      cases.push({
        case: `unauthorized-${outcome}`,
        connectionReleased: true,
        requests: counts.get(target),
      });
    }
    const direct = createHttpHostApiClient({
      baseUrl: new URL(origin),
      fetch: globalThis.fetch,
      onAuthenticationRequired: () => undefined,
    });
    rpcMode = "unreachable";
    const directFailure = await direct["auth.config"]({});
    assert(!directFailure.ok);
    assert.equal(directFailure.error.reason, "transport-unreachable");
    rpcMode = "stall";
    const directController = new AbortController();
    const directReason = new Error("Direct fetch caller stopped reading.");
    const directPending = direct["auth.config"]({}, { signal: directController.signal });
    await waitUntil(() => [...pending].some((target) => target.startsWith("/v1/rpc/auth.config")));
    directController.abort(directReason);
    await assert.rejects(directPending, (error: unknown) => error === directReason);
    await waitUntil(() => ![...pending].some((target) => target.startsWith("/v1/rpc/auth.config")));
    cases.push({
      case: "direct-fetch-network-and-body-abort",
      failure: directFailure,
      callerReasonPreserved: true,
    });
    rpcMode = "large";
    const changing = request("/v1/stall?fence=1");
    const changed = assert.rejects(changing, { code: "deployment-changed" });
    await waitUntil(() => pending.has("/v1/stall?fence=1"));
    catalog = { ...catalog, revision: 2, selectedDeploymentId: null };
    await transport.selection();
    await changed;
    catalog = {
      ...catalog,
      revision: 3,
      selectedDeploymentId: connection.authority.document.deploymentId,
    };
    cases.push({ case: "attachment-fence", code: "deployment-changed" });

    const bridgeToken = randomBytes(32).toString("base64url");
    const context = {
      options: { bridgeToken, hostTransport: transport },
      trackedHostSenders: new Set<number>(),
    } as unknown as DesktopBridgeContext;
    const handlers = [
      [desktopBridgeChannels.hostRequest, handleHostRequest(context)],
      [desktopBridgeChannels.hostBinaryOpen, handleHostBinaryOpen(context)],
      [desktopBridgeChannels.hostBinaryRead, handleHostBinaryRead(context)],
      [desktopBridgeChannels.hostBinaryClose, handleHostBinaryClose(context)],
      [desktopBridgeChannels.hostBinaryWrite, handleHostBinaryWrite(context)],
      [desktopBridgeChannels.hostBinaryFinish, handleHostBinaryFinish(context)],
    ] as const;
    for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);
    protocol.handle(
      "app",
      () =>
        new Response("<!doctype html><title>Host transport smoke</title>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const window = new BrowserWindow({
      show: false,
      webPreferences: desktopWebPreferences(
        { mode: "production" },
        bridgeToken,
        path.join(import.meta.dirname, "desktop-preload.cjs"),
      ),
    });
    try {
      await window.loadURL("app://opensteer/");
      await window.webContents.executeJavaScript(
        readFileSync(
          path.join(import.meta.dirname, "host-transport-renderer-smoke.global.js"),
          "utf8",
        ),
      );
      const execute = (action: "rpc" | "abort" | "binary"): Promise<unknown> =>
        window.webContents.executeJavaScript(
          `window.hostTransportSmoke(${JSON.stringify(origin)}, ${JSON.stringify(action)})`,
        );
      for (const [mode, code, retryable] of [
        ["large", "response-too-large", false],
        ["stall", "timed-out", true],
        ["unreachable", "unreachable", true],
      ] as const) {
        rpcMode = mode;
        const result = z
          .strictObject({ ok: z.literal(false), error: HostApiErrorSchema })
          .parse(await execute("rpc"));
        assert.equal(result.error.reason, `transport-${code}`);
        assert.equal(result.error.retryable, retryable);
        assert.equal(result.error.message, new HostTransportError(code).message);
        cases.push({ case: `renderer-rpc-${mode}`, ...result });
      }
      rpcMode = "stall";
      const moved = execute("rpc");
      await waitUntil(() =>
        [...pending].some((target) => target.startsWith("/v1/rpc/auth.config")),
      );
      catalog = { ...catalog, revision: 4, selectedDeploymentId: null };
      await transport.selection();
      const movedResult = z
        .strictObject({ ok: z.literal(false), error: HostApiErrorSchema })
        .parse(await moved);
      assert.equal(movedResult.error.reason, "transport-deployment-changed");
      assert.equal(movedResult.error.retryable, false);
      cases.push({ case: "renderer-deployment-changed", ...movedResult });
      catalog = {
        ...catalog,
        revision: 5,
        selectedDeploymentId: connection.authority.document.deploymentId,
      };
      const binary = z
        .strictObject({ code: z.literal("response-too-large"), retryable: z.literal(false) })
        .parse(await execute("binary"));
      cases.push({ case: "renderer-binary-error", ...binary });
      const aborted = z
        .strictObject({ callerReasonPreserved: z.literal(true) })
        .parse(await execute("abort"));
      cases.push({ case: "renderer-caller-abort", ...aborted });
      await waitUntil(() => !pending.has("/v1/stall?renderer=1"));
      rpcMode = "normal";
      const final = z
        .strictObject({ ok: z.literal(false), error: HostApiErrorSchema })
        .parse(await execute("rpc"));
      assert.equal(final.error.message, "Normal response arrived.");
      cases.push({ case: "renderer-normal-after-failures", ...final });
    } finally {
      window.destroy();
      for (const [channel] of handlers) ipcMain.removeHandler(channel);
      protocol.unhandle("app");
    }
  } finally {
    secureServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      secureServer.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert(Date.now() < deadline, "Expected connection state was not observed.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
