import { DeploymentConnectionSchema } from "@opensteer/client/connections";
import { hostApiVersion, hostKeyFingerprint } from "@opensteer/deployment-authority";
import { hostApi, hostApiVersionHeader } from "@opensteer/protocol";
import { DesktopAccessOriginSchema } from "@opensteer/protocol/desktop";
import { processSupervisorExecutableVariable } from "@opensteer/shared/processControl";
import {
  app,
  BrowserWindow,
  dialog,
  powerMonitor,
  session,
  utilityProcess,
  webContents,
} from "electron";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { configureDesktopApplicationPaths } from "../src/app/application-paths.js";
import { DesktopShutdown } from "../src/app/desktop-shutdown.js";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { electronBrowserPartition } from "../src/browser/electron-browser-launcher.js";
import { readDesktopConfiguration } from "../src/config.js";
import { openDesktopPrivateFilesystemSync } from "../src/secrets/desktop-private-files.js";
import { NativePersonalDeploymentCredentials } from "../src/secrets/personal-deployment-credentials.js";
import { NativePersonalDeploymentFilesystem } from "../src/secrets/personal-deployment-store.js";
import { CloudflaredConnectorSupervisor } from "../src/supervisor/cloudflared-connector-supervisor.js";
import { startLocalBrowserRuntime } from "../src/supervisor/local-browser-runtime.js";
import {
  electronUtilityProcessFork,
  LocalRunnerService,
} from "../src/supervisor/local-runner-service.js";
import { PersonalDeploymentSupervisor } from "../src/supervisor/personal-deployment-supervisor.js";
import {
  PersonalHostConnectOrchestrator,
  PersonalHostConnectTeardownCoordinator,
} from "../src/supervisor/personal-host-connect-orchestrator.js";
import {
  NativePersonalHostControl,
  NativePersonalRemoteHostControl,
} from "../src/supervisor/personal-host-control.js";
import {
  NodePersonalProcessPort,
  readPersonalProcessSupervisorRelease,
} from "../src/supervisor/personal-process-port.js";
import { runTabRestoreTrial } from "./electron-tab-restore-trial.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";

const smokeDownloads = smokeDesktopDownloads();

const root = path.resolve(z.string().parse(process.env.OPENSTEER_QUIT_E2E_DATA));
const resources = path.resolve(z.string().parse(process.env.OPENSTEER_PERSONAL_E2E_RESOURCES));
const trial = z
  .string()
  .regex(/^[a-z-]+$/u)
  .parse(process.env.OPENSTEER_QUIT_E2E_TRIAL);
configureDesktopApplicationPaths(app, root);
app.on("window-all-closed", () => undefined);
// The worker has no UI or keychain dependency and never captures a frame.
app.setActivationPolicy("prohibited");
const logPath = path.join(root, `${trial}.jsonl`);
const log = (event: string, fields: Readonly<Record<string, string | number | boolean>> = {}) =>
  appendFileSync(logPath, `${JSON.stringify({ event, ...fields, time: Date.now() })}\n`);
dialog.showErrorBox = (title, content) => {
  log("test.modal", { title, content });
};
const shutdown = new DesktopShutdown({ application: app, power: powerMonitor, log });
const watchdog = setTimeout(() => {
  log("test.watchdog");
  shutdown.request("test-timeout");
}, 120_000);
void run().catch((error: unknown) => {
  log("test.failed", { error: String(error) });
  shutdown.request("test-failed");
});

async function run(): Promise<void> {
  await app.whenReady();
  const shell = new BrowserWindow({ show: false });
  await shell.loadURL("data:text/html,<script>window.onbeforeunload=()=>false</script>");
  shutdown.add({
    component: "window",
    step: "destroy",
    order: 90,
    timeoutMs: 1_000,
    stop: () => shell.destroy(),
  });
  const keyPath = path.join(root, "test-key");
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
  const encryptionKey = readFileSync(keyPath);
  const temporary = path.join(root, "temporary-runtime");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const network = new ElectronHostNetwork();
  let restoreWindow: BrowserWindow | null = null;
  let restoreLoad: Promise<void> | null = null;
  const files = new NativePersonalDeploymentFilesystem({ dataDirectory: root });
  const processes = new NodePersonalProcessPort({
    logsDirectory: path.join(root, "logs"),
    supervisorExecutable: readPersonalProcessSupervisorRelease(resources),
  });
  let periodicCommits = 0;
  let capturedLargeHash: string | null = null;
  let capturedNormal = false;
  const supervisor = new PersonalDeploymentSupervisor({
    log,
    catalog: {
      upsertAndSelect: async (value) => {
        if (trial.startsWith("restore-")) {
          // Open at deployment selection, before the supervisor waits for placement.
          const origin = value.endpoints[0].origin;
          const deploymentId = value.authority.document.deploymentId;
          const snapshot = await network.partitionFetch(
            deploymentId,
            `${origin}/v1/rpc/bootstrap.get?input=%7B%7D`,
            { headers: { [hostApiVersionHeader]: String(hostApiVersion) } },
          );
          writeFileSync(
            path.join(root, `${trial}.before-window.json`),
            JSON.stringify(await snapshot.json(), null, 2),
          );
          restoreWindow = new BrowserWindow({
            show: false,
            width: 1280,
            height: 800,
            webPreferences: { partition: `persist:opensteer-host-${deploymentId}` },
          });
          shutdown.add({
            component: "restore-window",
            step: "destroy",
            order: 90,
            timeoutMs: 1000,
            stop: () => restoreWindow?.destroy(),
          });
          restoreLoad = restoreWindow.loadURL(origin);
        }
        return {
          deployments: [
            DeploymentConnectionSchema.parse({
              ...value,
              lastUsedAt: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          ],
          selectedDeploymentId: value.authority.document.deploymentId,
          revision: 1,
          schemaVersion: 4,
          updatedAt: new Date().toISOString(),
        };
      },
    },
    credentials: new NativePersonalDeploymentCredentials({
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "e2e-aes-gcm",
      encryptStringAsync: async (plainText) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
        const bytes = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
      },
      decryptStringAsync: async (encrypted) => {
        const cipher = createDecipheriv("aes-256-gcm", encryptionKey, encrypted.subarray(0, 12));
        cipher.setAuthTag(encrypted.subarray(12, 28));
        return {
          result: Buffer.concat([cipher.update(encrypted.subarray(28)), cipher.final()]).toString(
            "utf8",
          ),
          shouldReEncrypt: false,
        };
      },
    }),
    files,
    host: new NativePersonalHostControl({
      fetch: (id, url, init) => network.partitionFetch(id, url, init),
    }),
    localRuntimes: {
      startBrowser: async (input) => {
        const browser = await startLocalBrowserRuntime({
          downloads: smokeDownloads,
          profileRoot: input.paths.browserProfileRoot,
          runtimeId: input.runtimeId,
          logPath: path.join(root, "logs", "personal-browser.log"),
          pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
        });
        return {
          ...browser,
          stop: async (signal) => {
            await browser.stop(signal);
          },
        };
      },
    },
    processes: {
      run: (spec, options) => processes.run(spec, options),
      spawn: (spec) => {
        const child = processes.spawn(spec);
        log("test.child", { component: spec.component, pid: child.pid ?? 0 });
        return child;
      },
    },
    baseEnvironment: { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: temporary },
    userEnvironment: {
      resolve: async () => ({ HOME: root, PATH: "/usr/bin:/bin", TMPDIR: temporary }),
    },
    releaseDirectory: path.join(resources, "personal-runtime"),
    workspaceRoot: path.join(root, "workspaces"),
  });
  shutdown.signal.addEventListener("abort", () => supervisor.quiesce(), { once: true });
  shutdown.add({
    component: "personal",
    step: "stop",
    order: 40,
    timeoutMs: 24_000,
    stop: (signal) => supervisor.stop(signal),
  });
  await supervisor.start();
  const manifest = await files.load();
  assert(manifest);
  const origin = `http://127.0.0.1:${manifest.hostPort}`;
  const rpc = async (method: string, body?: object) => {
    const read = Object.entries(hostApi).some(
      ([name, declaration]) => name === method && declaration.method === "GET",
    );
    const response = await network.partitionFetch(
      manifest.deploymentId,
      `${origin}/v1/rpc/${method}${read ? `?input=${encodeURIComponent(JSON.stringify(body ?? {}))}` : ""}`,
      {
        method: read ? "GET" : "POST",
        headers: {
          [hostApiVersionHeader]: String(hostApiVersion),
          origin,
          "content-type": "application/json",
        },
        ...(!read && body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return z.object({ ok: z.literal(true), data: z.unknown() }).parse(result).data;
  };
  if (trial.startsWith("restore-")) {
    await restoreLoad;
    assert(restoreWindow);
    await runTabRestoreTrial({
      root,
      trial,
      window: restoreWindow,
      rpc,
      checkpointed: () => periodicCommits > 0,
    });
    clearTimeout(watchdog);
    log("test.ready", { restore: true });
    return;
  }
  const runtime = await supervisor.current();
  assert(runtime);
  const remoteHost = new NativePersonalRemoteHostControl({
    fetch: (id, url, init) => network.partitionFetch(id, url, init),
  });
  const remoteStatus = await remoteHost.configure(runtime, {
    mode: "private",
    routeOrigin: "https://quit-smoke.invalid",
    schemaVersion: 1,
  });
  assert.equal(remoteStatus.mode, "private");
  log("test.remote-access-enabled");
  const connector = new CloudflaredConnectorSupervisor({
    privateFiles: openDesktopPrivateFilesystemSync({
      binary: path.join(resources, "personal-runtime/bin/opensteer-native-fs"),
      root,
    }),
    resourcesDirectory: z.string().parse(process.env.OPENSTEER_QUIT_E2E_CONNECTOR_RESOURCES),
    runtime: supervisor,
  });
  await connector.start({
    schemaVersion: 1,
    discovery: runtime.discovery,
    hostKeyFingerprint: hostKeyFingerprint(runtime.discoveryEnvelope.publicKey.spki),
    localOrigin: runtime.localOrigin,
    generation: 1,
    tunnelToken: "offline-e2e-connector-token-0000000000000000",
  });
  const unexpectedRemoteWork = async (): Promise<never> => {
    log("test.unexpected-remote-access");
    throw new Error("Quit must not request remote access");
  };
  const store = {
    clear: unexpectedRemoteWork,
    load: unexpectedRemoteWork,
    save: unexpectedRemoteWork,
  };
  const projection = { publish: unexpectedRemoteWork };
  const teardown = new PersonalHostConnectTeardownCoordinator({
    deploymentId: manifest.deploymentId,
    projection,
    revocation: { revokeConnectResource: unexpectedRemoteWork },
    runtime: supervisor,
    store,
    supervisor: connector,
  });
  const connect = new PersonalHostConnectOrchestrator({
    controlPlane: { provision: unexpectedRemoteWork, rotate: unexpectedRemoteWork },
    deploymentId: manifest.deploymentId,
    projection,
    routes: { configureConnect: unexpectedRemoteWork, disableConnect: unexpectedRemoteWork },
    runtime: supervisor,
    store,
    supervisor: connector,
    teardown,
  });
  shutdown.add({
    component: "remote-access",
    step: "stop",
    order: 20,
    timeoutMs: 5_000,
    stop: async (signal) => {
      await connect.shutdown(signal);
    },
  });
  const config = readDesktopConfiguration({
    appDataDirectory: root,
    defaultMode: "development",
    packaged: false,
    resourcesDirectory: resources,
    environment: {
      OPENSTEER_DESKTOP_DATA_DIR: root,
      OPENSTEER_DESKTOP_PERSONAL_RELEASE_DIR: path.join(resources, "personal-runtime"),
      OPENSTEER_DESKTOP_RUNNER_WORKER: path.join(import.meta.dirname, "quit-runner-worker.js"),
      OPENSTEER_DESKTOP_NATIVE_FS_HELPER: path.join(
        resources,
        "personal-runtime/bin/opensteer-native-fs",
      ),
    },
  }).config;
  const target = {
    deploymentId: manifest.deploymentId,
    deploymentShape: {
      kind: "personal" as const,
      defaultWorkspaceBacking: "local-directory" as const,
    },
    hostUrl: DesktopAccessOriginSchema.parse(origin),
    key: "isolated-quit-proof",
    mayRunAgents: false,
  };
  const localRunners = new LocalRunnerService(config, {
    log,
    fork: (modulePath, args, options) => {
      const child = electronUtilityProcessFork(utilityProcess.fork)(modulePath, args, {
        ...options,
        env: {
          ...options.env,
          [processSupervisorExecutableVariable]: readPersonalProcessSupervisorRelease(resources),
        },
      });
      child.on("message", (message) => {
        const parsed = z.object({ type: z.string() }).safeParse(message);
        if (parsed.success) log("test.local-worker", { type: parsed.data.type });
      });
      child.on("exit", () => log("test.local-worker-exited"));
      return child;
    },
    homeDirectory: root,
    computerName: async () => "Quit smoke Mac",
    targets: {
      resolve: async () => target,
      isCurrent: async () => true,
      subscribe: () => () => undefined,
    },
    userEnvironment: {
      resolve: async () => ({ HOME: root, PATH: "/usr/bin:/bin", TMPDIR: temporary }),
    },
  });
  shutdown.add({
    component: "local-runners",
    step: "stop",
    order: 30,
    timeoutMs: 8_000,
    stop: async (signal) => {
      await localRunners.shutdown(signal);
      localRunners.dispose();
    },
  });
  const enrollment = z.object({ token: z.string() }).parse(
    await rpc("commands.dispatch", {
      type: "runner.enrollment.createLocal",
      idempotencyKey: randomUUID(),
      name: "Quit smoke local runner",
      allowedModules: ["integrations", "shell"],
    }),
  );
  await localRunners.start({
    deploymentId: manifest.deploymentId,
    enrollmentToken: enrollment.token,
    runAgents: false,
    runnerName: "Quit smoke local runner",
  });
  assert.equal((await localRunners.status(manifest.deploymentId)).runner.state, "running");
  log("test.local-runner-running");
  const savedPath = path.join(root, "durable.json");
  const Saved = z.object({ profileId: z.string(), pagePort: z.number(), normalPort: z.number() });
  const saved = existsSync(savedPath)
    ? Saved.parse(JSON.parse(readFileSync(savedPath, "utf8")))
    : null;
  const pageServer = createServer((_request, response) =>
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>Quit proof</title>"),
  );
  await new Promise<void>((resolve) =>
    pageServer.listen(saved?.pagePort ?? 0, "127.0.0.1", resolve),
  );
  const normalServer = createServer((_request, response) =>
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<!doctype html><title>Normal origin proof</title>"),
  );
  await new Promise<void>((resolve) =>
    normalServer.listen(saved?.normalPort ?? 0, "127.0.0.1", resolve),
  );
  const normalAddress = normalServer.address();
  assert(normalAddress && typeof normalAddress !== "string");
  const address = pageServer.address();
  assert(address && typeof address !== "string");
  shutdown.add({
    component: "test-page",
    step: "close",
    order: 85,
    timeoutMs: 1_000,
    stop: () => {
      pageServer.closeAllConnections();
      pageServer.close();
      normalServer.closeAllConnections();
      normalServer.close();
    },
  });
  const profileId =
    saved?.profileId ??
    z.object({ profile: z.object({ id: z.string() }) }).parse(
      await rpc("commands.dispatch", {
        type: "browser.profile.create",
        idempotencyKey: randomUUID(),
        input: { name: "Durable quit proof" },
      }),
    ).profile.id;
  const bootstrap = z
    .object({ homeWorkspace: z.object({ id: z.string() }) })
    .parse(await rpc("bootstrap.get"));
  const pageUrl = `http://127.0.0.1:${address.port}/proof`;
  const opened = z.object({ session: z.object({ id: z.string() }) }).parse(
    await rpc("commands.dispatch", {
      type: "browser.session.start",
      idempotencyKey: randomUUID(),
      workspaceId: bootstrap.homeWorkspace.id,
      input: { profileId, initialUrl: pageUrl, reuseExisting: false },
    }),
  );
  const normalUrl = `http://127.0.0.1:${normalAddress.port}/normal`;
  await rpc("commands.dispatch", {
    type: "browser.session.start",
    idempotencyKey: randomUUID(),
    workspaceId: bootstrap.homeWorkspace.id,
    input: { profileId, initialUrl: normalUrl, reuseExisting: false },
  });
  const normalPage = webContents
    .getAllWebContents()
    .find((contents) => contents.getURL() === normalUrl);
  assert(normalPage);
  const largeValue = "Q".repeat(3 * 1_024 * 1_024);
  const expectedHash = createHash("sha256").update(largeValue).digest("hex");
  const page = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl);
  assert(page);
  const hashLargeValue = async () =>
    createHash("sha256")
      .update(z.string().parse(await page.executeJavaScript("localStorage.getItem('large-proof')")))
      .digest("hex");

  const profileSession = session.fromPartition(electronBrowserPartition(`profile:${profileId}`));
  if (saved) {
    assert.equal(await page.executeJavaScript("localStorage.getItem('quit-proof')"), "durable");
    assert(
      (await profileSession.cookies.get({ url: pageUrl })).some(
        ({ name, value }) => name === "quit-proof" && value === "durable",
      ),
    );
    assert.equal(await hashLargeValue(), expectedHash);
    assert.equal(
      await normalPage.executeJavaScript("localStorage.getItem('normal-proof')"),
      "normal-durable",
    );
    log("test.data-intact", {
      profileId,
      largeCharacters: largeValue.length,
      largeUtf8Bytes: Buffer.byteLength(largeValue),
      largeSha256: expectedHash,
      normal: true,
    });
  }
  await page.executeJavaScript("localStorage.setItem('quit-proof','durable')");
  await profileSession.cookies.set({
    url: pageUrl,
    name: "quit-proof",
    value: "durable",
    expirationDate: Date.now() / 1_000 + 86_400,
  });

  await page.executeJavaScript(
    `localStorage.setItem('large-proof', ${JSON.stringify(largeValue)})`,
  );
  await normalPage.executeJavaScript("localStorage.setItem('normal-proof','normal-durable')");
  writeFileSync(
    savedPath,
    JSON.stringify({ profileId, pagePort: address.port, normalPort: normalAddress.port }),
  );
  if (trial === "partial") {
    const badUrl = `http://localhost:${address.port}/unsupported-storage`;
    await rpc("commands.dispatch", {
      type: "browser.session.start",
      idempotencyKey: randomUUID(),
      workspaceId: bootstrap.homeWorkspace.id,
      input: { profileId, initialUrl: badUrl, reuseExisting: false },
    });
    const badPage = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === badUrl);
    assert(badPage);
    await badPage.executeJavaScript(
      `new Promise((resolve,reject)=>{const request=indexedDB.open('x'.repeat(17000),1);request.onsuccess=()=>{request.result.close();resolve(true)};request.onerror=()=>reject(request.error)})`,
    );
    const deadline = Date.now() + 15_000;
    const diagnostics = path.join(root, "logs", "personal-browser.log");
    while (
      !existsSync(diagnostics) ||
      !readFileSync(diagnostics, "utf8").includes("profile-checkpoint.origins-incomplete")
    ) {
      assert(Date.now() < deadline, "Partial periodic checkpoint was not reported");
      await delay(25);
    }
    log("test.partial-checkpoint-reported");
  }
  const checkpointDeadline = Date.now() + 15_000;
  while (capturedLargeHash !== expectedHash || !capturedNormal) {
    assert(Date.now() < checkpointDeadline, "Automatic checkpoint did not commit");
    await delay(25);
  }
  assert.equal(await hashLargeValue(), expectedHash);
  log("test.automatic-checkpoint", { commits: periodicCommits, largeSha256: expectedHash });
  await new Promise<void>((resolve, reject) => {
    network.openWebSocket(
      {
        canonicalOrigin: origin,
        deploymentId: manifest.deploymentId,
        url: `ws://127.0.0.1:${manifest.hostPort}/v1/browser-sessions/${opened.session.id}/connect`,
        authorization: null,
        requestOrigin: origin,
      },
      {
        open: () => undefined,
        message: (message) => {
          if (typeof message === "string" && JSON.parse(message).type === "browser.snapshot")
            resolve();
        },
        error: reject,
        close: () => undefined,
      },
    );
  });
  await rpc("commands.dispatch", {
    type: "browser.session.start",
    idempotencyKey: randomUUID(),
    workspaceId: bootstrap.homeWorkspace.id,
    input: { fresh: true, initialUrl: pageUrl, reuseExisting: false },
  });
  // No stream.subscribe: the owner connection is live without requesting capture.
  clearTimeout(watchdog);
  log("test.ready", {
    pid: process.pid,
    ownerView: true,
    liveBrowsers: 3,
    localRunner: true,
    connectedRunner: manifest.runnerId,
    profileId,
  });
  if (trial === "logout") process.once("SIGUSR2", () => powerMonitor.emit("shutdown"));
}
