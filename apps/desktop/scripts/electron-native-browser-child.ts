import { DesktopPasskeyRequests } from "../src/passkeys/passkey-requests.js";
import { createNativePasskeyJourney } from "./test-support/native-passkey-journey.js";
import { passkeyProviderCertificate } from "@opensteer/browser-runtime-core/test-support/passkey-provider";
import { serveDownloadFixture } from "./electron-native-browser-download-fixture.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { withTimeout } from "@opensteer/shared/withTimeout";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  X509Certificate,
} from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import {
  app,
  BaseWindow,
  ipcMain,
  Menu,
  protocol,
  dialog,
  powerMonitor,
  screen,
  session,
  webContents,
  type WebContentsView,
} from "electron";
import { z } from "zod";
import { HostSession, HostSessionExchange } from "@opensteer/client/auth";
import {
  DeploymentCatalogStore,
  verifyAccessEndpoint,
  type HostNetwork,
  type HostNetworkSocketEvents,
} from "@opensteer/client/connections";
import { createHttpHostApiClient } from "@opensteer/client/host";
import {
  BrowserClientMessageSchema,
  BrowserSessionIdSchema,
  BrowserServerMessageSchema,
} from "@opensteer/protocol";
import { BrowserController, type NativePresentationSource } from "@opensteer/browser-runtime-core";
import { DesktopShutdown } from "../src/app/desktop-shutdown.js";
import { configureDesktopApplicationPaths } from "../src/app/application-paths.js";
import { installDesktopAppProtocol, registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { createDesktopApplicationMenu } from "../src/app/application-menu.js";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import {
  configureDesktopSession,
  ElectronWindowFactory,
  desktopWindowForContents,
} from "../src/app/electron-window.js";
import { DesktopAppOriginPolicy } from "../src/app/navigation-policy.js";
import { readDesktopConfiguration } from "../src/config.js";
import { registerDesktopBridge } from "../src/bridge/registration.js";
import { DesktopAccessProjection } from "../src/connections/access-projection.js";
import { DeploymentAccessService } from "../src/connections/deployment-access-service.js";
import { DesktopHostTransport } from "../src/connections/host-transport.js";
import { DesktopBrowserPresentationManager } from "../src/browser/browser-presentation.js";
import { electronPagePresentation } from "../src/browser/electron-browser-launcher.js";
import { openDesktopPrivateFilesystemSync } from "../src/secrets/desktop-private-files.js";
import { NativePersonalDeploymentCredentials } from "../src/secrets/personal-deployment-credentials.js";
import { NativePersonalDeploymentFilesystem } from "../src/secrets/personal-deployment-store.js";
import { PersonalDeploymentSupervisor } from "../src/supervisor/personal-deployment-supervisor.js";
import { NativePersonalHostControl } from "../src/supervisor/personal-host-control.js";
import { startLocalBrowserRuntime } from "../src/supervisor/local-browser-runtime.js";
import {
  NodePersonalProcessPort,
  readPersonalProcessSupervisorRelease,
} from "../src/supervisor/personal-process-port.js";
import { NativeSmokeArtifacts } from "./electron-native-browser-artifacts.js";

import { createNativeBrowserE2EKit } from "./electron-native-browser-kit.js";
import { runJourney } from "./native-browser-journey-steps.js";
import { journeySteps } from "./native-browser-journey-contract.js";

const runFile = promisify(execFile);
const run = path.resolve(z.string().min(1).parse(process.env.OPENSTEER_NATIVE_SMOKE_RUN));
const downloadsRoot = path.join(run, "downloads");
const smokeDownloads = smokeDesktopDownloads(downloadsRoot);
const inputHelper = z.string().min(1).parse(process.env.OPENSTEER_NATIVE_SMOKE_INPUT);
const resources = path.resolve(
  z.string().min(1).parse(process.env.OPENSTEER_PERSONAL_E2E_RESOURCES),
);
const passkeyJourney = process.argv.includes("--passkeys");
const passkeyNoticeOnly = process.argv.includes("--passkeys-notice");
if (passkeyJourney)
  app.commandLine.appendSwitch("host-resolver-rules", "MAP *.example.test 127.0.0.1");
const selection = {
  ids: new Set(
    passkeyJourney
      ? [passkeyNoticeOnly ? "passkeys-notice" : "passkeys"]
      : Object.keys(journeySteps),
  ),
  noSerial: false,
};
let passkeyRequests: DesktopPasskeyRequests | undefined;
const artifacts = new NativeSmokeArtifacts(run, selection.ids, true);
const kit = createNativeBrowserE2EKit({ run, inputHelper, artifacts });
const observedBoundsViews = new WeakSet<WebContentsView>();
let completedInitialPresentation = false;
const {
  cleanup,
  runtimeSources,
  pages,
  rawOutstanding,
  dialogPages,
  authorityEvents,
  geometry,
  ownedChildren,
  ownedPids,
  consoleErrors,
  presentationEvents,
  incomingMessages,
  outgoing,
  evaluateApp,
  body,
  windowInventory,
  snapshot,
  until,
  errorText,
  fixtureHtml,
} = kit;
cleanup.push(() => smokeDownloads.close());
const desktop = path.resolve(import.meta.dirname, "..");
const root = path.join(run, "stack");
mkdirSync(root, { mode: 0o700 });
configureDesktopApplicationPaths(app, root);
registerDesktopAppScheme(protocol);
app.on("window-all-closed", () => undefined);
const liveness = setInterval(() => undefined, 1_000);
let shutdownPrepared = false;
const fatalErrors: string[] = [];
app.on("before-quit", () => prepareShutdown());
const shutdown = new DesktopShutdown({
  application: {
    on: app.on.bind(app),
    exit: (code) => {
      const exitCode = code || (fatalErrors.length ? 1 : 0);
      artifacts.json("shutdown.json", { code: exitCode, fatalErrors });
      artifacts.finalizeCaseResults();
      app.exit(exitCode);
    },
  },
  power: powerMonitor,
  log: (event, fields) => artifacts.event(event, fields),
});
function fatal(kind: string, error: unknown): void {
  const reason = errorText(error);
  fatalErrors.push(reason);
  artifacts.event("fatal", { kind, error: reason, currentCase: kit.currentCase });
  artifacts.json("fatal.json", { kind, errors: fatalErrors, currentCase: kit.currentCase });
  artifacts.remaining(`Fatal ${kind}: ${reason}`);
  prepareShutdown();
  shutdown.request(kind);
}
process.prependListener("SIGTERM", prepareShutdown);
process.prependListener("SIGINT", prepareShutdown);
process.on("uncaughtException", (error) => fatal("uncaughtException", error));
process.on("unhandledRejection", (error) => fatal("unhandledRejection", error));
dialog.showErrorBox = (title, content) => fatal("errorBox", new Error(`${title}: ${content}`));
const started = Date.now();
const handleBrowserMessage = BrowserController.prototype.handle;
const handleRawBrowserMessage = BrowserController.prototype.handleRaw;
function observeRuntimeMessage(
  value: unknown,
  result: Promise<void>,
  boundary: "structured" | "raw",
): void {
  try {
    const parsed = BrowserClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      artifacts.event("compat.runtimeInvalid", { boundary, error: parsed.error.message });
      return;
    }
    const message = parsed.data;
    const metadata = {
      operation: randomUUID(),
      boundary,
      type: message.type,
      ...(message.type === "stream.subscribe"
        ? {
            captureRegion: message.captureRegion,
            frames: message.frames,
            surfaceId: message.surfaceId,
          }
        : {}),
      ...(message.type === "input.pointer" || message.type === "input.wheel"
        ? {
            captureRevision: message.captureRevision,
            geometryRevision: message.geometryRevision,
            surfaceId: message.surfaceId,
          }
        : {}),
    };
    artifacts.event("compat.runtimeIncoming", metadata);
    void result.then(
      () => artifacts.event("compat.runtimeReturn", { ...metadata, ok: true }),
      () => artifacts.event("compat.runtimeReturn", { ...metadata, ok: false }),
    );
  } catch (error) {
    artifacts.event("transport.observerFailure", {
      label: "runtime boundary",
      boundary,
      error: errorText(error),
    });
  }
}
BrowserController.prototype.handle = function (message) {
  const result = handleBrowserMessage.call(this, message);
  observeRuntimeMessage(message, result, "structured");
  return result;
};
BrowserController.prototype.handleRaw = function (frame) {
  const result = handleRawBrowserMessage.call(this, frame);
  let value: unknown;
  try {
    value = JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8"));
  } catch (error) {
    artifacts.event("compat.runtimeInvalid", { boundary: "raw", error: errorText(error) });
    return result;
  }
  observeRuntimeMessage(value, result, "raw");
  return result;
};
cleanup.push(function restoreRuntimeMessageObserver() {
  BrowserController.prototype.handle = handleBrowserMessage;
  BrowserController.prototype.handleRaw = handleRawBrowserMessage;
});
const rawFrameSamples = new Map<string, number>();
app.on("web-contents-created", (_event, contents) => {
  const contentsId = contents.id;
  const debuggerSession = contents.debugger;
  const observeMessage = (_event: Electron.Event, method: string, parameters: unknown) => {
    if (method === "Page.screencastFrame") {
      const frame = z
        .object({ data: z.string(), sessionId: z.number(), metadata: z.unknown() })
        .safeParse(parameters);
      if (frame.success) {
        const surface = [...pages.values()].find(
          (surface) =>
            !surface.page.isClosed() &&
            electronPagePresentation(surface.page)?.view.webContents === contents,
        );
        const key = `${contentsId}/${surface?.page.capture?.read()?.revision}`;
        const count = rawFrameSamples.get(key) ?? 0;
        const file = `engine-frames/${contentsId}-${randomUUID()}.jpg`;
        if (count < 2) {
          rawFrameSamples.set(key, count + 1);
          mkdirSync(path.join(run, "engine-frames"), { recursive: true });
          writeFileSync(path.join(run, file), Buffer.from(frame.data.data, "base64"));
        }
        artifacts.event("capture.engineFrame", {
          contents: contentsId,
          file: count < 2 ? file : null,
          sessionId: frame.data.sessionId,
          metadata: frame.data.metadata,
          capture: surface?.page.capture?.read(),
        });
      }
    }
    if (method === "Page.javascriptDialogOpening") dialogPages.add(contentsId);
    if (method === "Page.javascriptDialogClosed") dialogPages.delete(contentsId);
    // Ordering evidence only: a dialog's own text is the page's and stays out.
    if (method === "Page.javascriptDialogOpening" || method === "Page.javascriptDialogClosed")
      artifacts.event("debugger.dialog", { contents: contentsId, method });
  };
  debuggerSession.on("message", observeMessage);
  // Lifetime evidence: a release acknowledged after its document is gone proves nothing.
  contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) artifacts.event("page.navigation", { contents: contentsId });
  });
  contents.on("render-process-gone", () =>
    artifacts.event("page.navigation", { contents: contentsId, gone: true }),
  );
  contents.once("destroyed", () => {
    debuggerSession.removeListener("message", observeMessage);
    rawOutstanding.delete(contentsId);
    dialogPages.delete(contentsId);
  });
  const send = debuggerSession.sendCommand.bind(debuggerSession);
  let commandId = 0;
  const pending = new Set<number>();
  rawOutstanding.set(contentsId, pending);
  debuggerSession.sendCommand = (method: string, parameters?: unknown, sessionId?: string) => {
    const id = ++commandId;
    if (method.startsWith("Input.")) pending.add(id);
    const safeParams =
      method.startsWith("Emulation.") ||
      method === "Page.captureScreenshot" ||
      method === "Input.dispatchMouseEvent" ||
      method === "Page.screencastFrameAck" ||
      method === "Runtime.releaseObjectGroup"
        ? parameters
        : undefined;
    artifacts.event("debugger.invoke", {
      contents: contentsId,
      id,
      method,
      parameters: safeParams,
      outstanding: pending.size,
    });
    const result = send(method, parameters, sessionId);
    void result.then(
      () => {
        pending.delete(id);
        artifacts.event("debugger.settle", {
          contents: contentsId,
          id,
          method,
          ok: true,
          outstanding: pending.size,
        });
      },
      () => {
        pending.delete(id);
        artifacts.event("debugger.settle", {
          contents: contentsId,
          id,
          method,
          ok: false,
          outstanding: pending.size,
        });
      },
    );
    return result;
  };
  contents.on("before-input-event", (_event, input) =>
    artifacts.event("input.keyHook", {
      contents: contentsId,
      type: input.type,
      outstanding: pending.size,
    }),
  );
  contents.on("before-mouse-event", (_event, input) =>
    artifacts.event("input.mouseHook", {
      contents: contentsId,
      type: input.type,
      outstanding: pending.size,
    }),
  );
  contents.on("render-process-gone", (_event, details) =>
    artifacts.event("renderer.gone", { contents: contentsId, reason: details.reason }),
  );
});

void main().then(
  () => {
    prepareShutdown();
    app.quit();
  },
  (error: unknown) => fatal("execution", error),
);

async function main(): Promise<void> {
  await app.whenReady();
  const passkeyFixture = passkeyJourney
    ? await createNativePasskeyJourney({ nativeAvailable: !passkeyNoticeOnly })
    : undefined;
  if (passkeyFixture) {
    cleanup.push(() => passkeyFixture.close());
    const pin = new X509Certificate(passkeyProviderCertificate).fingerprint256;
    const configure = (_event: unknown, contents: Electron.WebContents) => {
      contents.session.setCertificateVerifyProc((request, callback) => {
        const trusted =
          ["rp.example.test", "other.example.test"].includes(request.hostname) &&
          new X509Certificate(request.certificate.data).fingerprint256 === pin;
        callback(trusted ? 0 : -3);
      });
    };
    app.on("web-contents-created", configure);
    cleanup.push(() => {
      app.off("web-contents-created", configure);
    });
  }
  artifacts.json("preflight.json", {
    input: JSON.parse((await runFile(inputHelper, ["status"])).stdout) as unknown,
    displays: screen.getAllDisplays(),
    versions: process.versions,
  });
  const fixture = fixtureHtml();
  artifacts.json("fixtures.json", {
    sha256: createHash("sha256").update(fixture).digest("hex"),
    paths: ["/p", "/q", "/no-meta", "/tall", "/redirect", "/image.svg"],
  });
  const server = createServer((request, response) => {
    if (serveDownloadFixture(request, response)) return;
    if (request.url?.startsWith("/conversation-engine/")) {
      const metadataOnly =
        request.method === "GET" && request.url === "/conversation-engine/v1/models";
      artifacts.event("fixture.conversationEngine", {
        method: request.method,
        path: request.url,
        metadataOnly,
      });
      response.writeHead(metadataOnly ? 200 : 503, { "content-type": "application/json" }).end(
        JSON.stringify(
          metadataOnly
            ? {
                object: "list",
                data: [
                  {
                    id: "native-browser-idle-fixture",
                    object: "model",
                    served_context_window: 8192,
                    served_max_output_tokens: 1024,
                  },
                ],
              }
            : {
                error: {
                  message:
                    "Idle conversation fixture serves catalog metadata only; inference is forbidden",
                },
              },
        ),
      );
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/q" }).end();
      return;
    }
    if (request.url === "/image.svg") {
      response
        .writeHead(200, { "content-type": "image/svg+xml" })
        .end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path fill="#ff00ff" d="M0 0h40v40H0z"/></svg>',
        );
      return;
    }
    const html =
      request.url === "/no-meta"
        ? fixture.replace('<meta name="viewport" content="width=device-width,initial-scale=1">', "")
        : fixture;
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      .end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(function closeFixtureServer() {
    return new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const network = new ElectronHostNetwork();
  const descriptorFailures = z.coerce
    .number()
    .int()
    .min(0)
    .max(5)
    .parse(process.env.OPENSTEER_NATIVE_SMOKE_DESCRIPTOR_FAILURES ?? 0);
  let descriptorAttempts = 0;
  function descriptorAttempt(route: string) {
    descriptorAttempts++;
    if (descriptorAttempts <= descriptorFailures + 1)
      assert(!outgoing.some((message) => message.type === "stream.subscribe"));
    artifacts.event("descriptor.attempt", {
      attempt: descriptorAttempts,
      descriptorFailures,
      route,
    });
    if (descriptorAttempts <= descriptorFailures)
      throw new Error("Injected descriptor network failure");
  }
  const partitionFetch = network.partitionFetch.bind(network);
  network.partitionFetch = async (id, input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).pathname === "/.well-known/opensteer")
      descriptorAttempt("verified attachment owner");
    return partitionFetch(id, input, init);
  };

  const files = new NativePersonalDeploymentFilesystem({ dataDirectory: root });
  const privateFiles = openDesktopPrivateFilesystemSync({
    binary: path.join(resources, "personal-runtime/bin/opensteer-native-fs"),
    root,
  });
  const catalog = new DeploymentCatalogStore({
    filePath: path.join(root, "catalog.json"),
    localPersonalManifest: files,
    privateFiles,
  });
  const processes = new NodePersonalProcessPort({
    logsDirectory: path.join(run, "logs"),
    supervisorExecutable: readPersonalProcessSupervisorRelease(resources),
  });
  const legacyProducer = process.env.OPENSTEER_NATIVE_LEGACY_CAPTURE_PRODUCER === "1";
  const runnerHook = path.join(root, "legacy-capture-producer.mjs");
  if (legacyProducer) {
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        runnerHook,
        `import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/runner.mjs'))return result;const source=String(result.source);const pattern=/sharedControl: 1,\\s*targetControl: 1,\\s*captureRegion: 1,/g;const matches=[...source.matchAll(pattern)];if(matches.length!==1)throw Error('Legacy producer fixture requires exactly one unsigned descriptor block');console.info(JSON.stringify({nativeHarnessLegacyCaptureProducer:true,descriptorTransformedBeforeSignature:true}));return {...result,source:source.replace(pattern,'sharedControl: 1, targetControl: 1,')};}});
`,
      ),
    );
    artifacts.event("compat.legacyProducerFixture", {
      descriptorTransformedBeforeSignature: true,
      module: "browser.captureRegion",
      fixtureOnly: true,
    });
  }
  const encryptionKey = randomBytes(32);
  let manager: DesktopBrowserPresentationManager;
  const runtimeHandles: Awaited<ReturnType<typeof startLocalBrowserRuntime>>[] = [];
  const supervisor = new PersonalDeploymentSupervisor({
    passkeys: passkeyJourney,
    catalog,
    files,
    credentials: new NativePersonalDeploymentCredentials({
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "e2e-aes-gcm",
      encryptStringAsync: async (plain) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
        const bytes = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
      },
      decryptStringAsync: async (bytes) => {
        const cipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return {
          result: Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(
            "utf8",
          ),
          shouldReEncrypt: false,
        };
      },
    }),
    host: new NativePersonalHostControl({
      fetch: (id, url, init) => network.partitionFetch(id, url, init),
    }),
    localRuntimes: {
      startBrowser: async (input) => {
        const handle = await startLocalBrowserRuntime({
          downloads: smokeDownloads,
          pagePolicyPreloadPath: path.join(desktop, "dist/browser-page-preload.cjs"),
          profileRoot: input.paths.browserProfileRoot,
          runtimeId: input.runtimeId,
          logPath: path.join(run, "logs/browser-runtime.log"),
          registerPresentationSource: (source) => registerSource(manager, source),
        });
        runtimeHandles.push(handle);
        return handle;
      },
    },
    processes: {
      run: (...args: Parameters<NodePersonalProcessPort["run"]>) => processes.run(...args),
      spawn: (spec) => {
        const child = processes.spawn(
          legacyProducer && spec.component === "runner"
            ? {
                ...spec,
                environment: {
                  ...spec.environment,
                  NODE_OPTIONS:
                    `${spec.environment.NODE_OPTIONS ?? ""} --import=${new URL(`file://${runnerHook}`).href}`.trim(),
                },
              }
            : spec,
        );
        if (child.pid) {
          const record = { component: spec.component, pid: child.pid, exited: false };
          ownedChildren.push(record);
          ownedPids.add(child.pid);
          child.once("exit", () => {
            record.exited = true;
          });
        }
        return child;
      },
    },
    baseEnvironment: { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: path.join(root, "tmp") },
    userEnvironment: {
      resolve: async () => ({ HOME: root, PATH: "/usr/bin:/bin", TMPDIR: path.join(root, "tmp") }),
    },
    releaseDirectory: path.join(resources, "personal-runtime"),
    workspaceRoot: path.join(root, "workspaces"),
    restartBackoffMs: 100,
    restartResetAfterMs: 600_000,
    onStatus: (status) =>
      artifacts.event("personal.status", {
        state: status.state,
        step: status.step,
        issue: status.issue,
      }),
  });
  await mkdir(path.join(root, "tmp"), { mode: 0o700 });
  cleanup.push(async function stopPersonalSupervisor(signal?: AbortSignal) {
    const visit = async (pid: number): Promise<void> => {
      const children = (
        await runFile("/usr/bin/pgrep", ["-P", String(pid)]).catch(() => ({ stdout: "" }))
      ).stdout
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map(Number);
      for (const child of children)
        if (!ownedPids.has(child)) {
          ownedPids.add(child);
          await visit(child);
        }
    };
    for (const child of ownedChildren) if (!child.exited) await visit(child.pid);
    await supervisor.stop(signal);
  });
  const projection = new DesktopAccessProjection({
    catalog,
    localRuntime: supervisor,
    supervisedDeploymentId: async () => (await files.load())?.deploymentId ?? null,
  });
  let transport: DesktopHostTransport;
  const unavailable = (): never => {
    throw new Error("External Account services are unavailable in this local smoke.");
  };
  const oauth = {
    abandonHostSignIn: () => undefined,
    beginHostSignIn: unavailable,
    hostCredentialState: unavailable,
    recoverHostAuthorization: unavailable,
    signOutHost: unavailable,
    subscribeHostCredentials: () => () => undefined,
  };
  const exchange = new HostSessionExchange({
    account: { issuePersonalHostSessionGrant: unavailable },
    application: "desktop",
    fetch: (id, url, init) => network.partitionFetch(id, url, init),
  });
  const hostSessions = new HostSession({
    attachment: { current: () => transport.current(), currentKey: () => transport.currentKey() },
    clearDeploymentSession: (id) => network.clearDeploymentSession(id),
    exchange,
    localOwner: supervisor,
    oauth,
  });
  cleanup.push(function disposeHostSessions() {
    hostSessions.dispose();
  });
  let holdSnapshots = false;
  let refuseNextControl: 4002 | 4003 | null = null;
  const heldSnapshots: (() => void)[] = [];
  const realtimeSockets: {
    id: string;
    path: string;
    state: string;
    messages: number;
    lastType?: string;
    lastMessageAt?: number;
    closeCode?: number;
  }[] = [];
  const viewerSockets: { id: string; path: string; state: string; surfaceId?: string }[] = [];
  const realtimeHandles = new Set<{ close(code: number, reason: string): void }>();
  const observedNetwork: HostNetwork = {
    request: (input) => {
      if (input.request.path === "/.well-known/opensteer") {
        try {
          descriptorAttempt("renderer transport");
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return network.request(input);
    },
    openWebSocket: (input, events) => {
      const socketUrl = new URL(input.url);
      const socketPath = socketUrl.pathname;
      if (
        refuseNextControl &&
        socketPath.endsWith("/connect") &&
        !socketUrl.searchParams.has("mode")
      ) {
        const code = refuseNextControl;
        refuseNextControl = null;
        queueMicrotask(() => events.close(code, "Forced terminal admission refusal"));
        artifacts.event("viewer.forcedTerminal", { code, path: socketPath });
        return { close: () => undefined, send: () => undefined };
      }
      const realtime: (typeof realtimeSockets)[number] | null =
        socketPath === "/v1/realtime"
          ? {
              id: randomUUID(),
              path: socketPath,
              state: "opening",
              messages: 0,
            }
          : null;
      if (realtime) realtimeSockets.push(realtime);
      const viewer: (typeof viewerSockets)[number] | null =
        socketPath.startsWith("/v1/browser-sessions/") && socketPath.endsWith("/connect")
          ? { id: randomUUID(), path: socketUrl.pathname + socketUrl.search, state: "opening" }
          : null;
      if (viewer) viewerSockets.push(viewer);
      const wrapped: HostNetworkSocketEvents = {
        ...events,
        open: () => {
          if (realtime) realtime.state = "open";
          if (viewer) viewer.state = "open";
          events.open();
        },
        close: (code, reason) => {
          if (realtime) {
            realtime.state = "closed";
            realtime.closeCode = code;
            realtimeHandles.delete(socket);
          }
          if (viewer) viewer.state = "closed";
          events.close(code, reason);
        },
        error: (message) => {
          if (realtime) realtime.state = "error";
          events.error(message);
        },
        message: (data) => {
          if (typeof data === "string") {
            const parsed: unknown = JSON.parse(data);
            const message = BrowserServerMessageSchema.safeParse(parsed);
            if (message.success) incomingMessages.push(message.data);
            const kind = z.object({ type: z.string() }).safeParse(parsed);
            if (realtime) {
              realtime.messages++;
              realtime.lastType = kind.success ? kind.data.type : "unknown";
              realtime.lastMessageAt = Date.now();
            }
            artifacts.event("host.incoming", {
              type: kind.success ? kind.data.type : "unknown",
              ...(kind.success &&
              ["browser.snapshot", "browser.surfaces.changed", "browser.dialog.changed"].includes(
                kind.data.type,
              )
                ? { message: parsed }
                : {}),
              path: new URL(input.url).pathname,
            });
            if (holdSnapshots && kind.success && kind.data.type === "browser.snapshot") {
              heldSnapshots.push(() => events.message(data));
              return;
            }
          } else
            artifacts.event("host.binary", {
              bytes: data.byteLength,
              path: new URL(input.url).pathname,
            });
          events.message(data);
        },
      };
      const socket = network.openWebSocket(input, wrapped);
      if (realtime) realtimeHandles.add(socket);
      return {
        close: (code, reason) => {
          if (viewer) viewer.state = "closing";
          socket.close(code, reason);
        },
        send: (data) => {
          if (typeof data === "string") {
            const value = z
              .object({
                type: z.string(),
                surfaceId: z.string().optional(),
                frames: z.boolean().optional(),
                captureRegion: z.literal(true).optional(),
              })
              .safeParse(JSON.parse(data) as unknown);
            if (value.success) {
              if (viewer && value.data.type === "stream.subscribe" && value.data.surfaceId)
                viewer.surfaceId = value.data.surfaceId;
              outgoing.push({ owner: kit.shell?.webContents.id ?? -1, ...value.data });
              artifacts.event("host.outgoing", value.data);
            }
          }
          socket.send(data);
        },
      };
    },
  };
  transport = new DesktopHostTransport({
    catalog,
    projection,
    localRuntime: supervisor,
    network: observedNetwork,
    sessions: hostSessions,
  });
  cleanup.push(function closeHostSockets() {
    transport.closeAllSockets();
  });
  manager = new DesktopBrowserPresentationManager({
    glassPreload: path.join(desktop, "dist/glass-preload.cjs"),
    onError: (error) => artifacts.event("presentation.error", { error: errorText(error) }),
    quit: () => app.quit(),
    transport: {
      closeSocketsForOwner: (id) => transport.closeSocketsForOwner(id),
      openBrowserSurface: (id, connection, url) =>
        transport.openBrowserSurface(id, connection, url),
      passkeyConsumerToken: (ownerId, connectionId, surfaceId) =>
        transport.passkeyConsumerToken(ownerId, connectionId, surfaceId),
      observeBrowserSockets: (listener) =>
        transport.observeBrowserSockets((event) => {
          const before = windowInventory();
          authorityEvents.push(event);
          artifacts.event("authority.entry", { event, before });
          listener(event);
          artifacts.event("authority.return", { event, after: windowInventory() });
        }),
    },
  });
  shutdown.add({
    component: "desktop",
    step: "stop-admission",
    order: 0,
    timeoutMs: 1_000,
    stop: () => manager.endAll(),
  });
  shutdown.signal.addEventListener("abort", () => supervisor.quiesce(), { once: true });
  cleanup.push(function disposePresentationManager() {
    manager.dispose();
  });
  if (passkeyFixture) {
    passkeyRequests = new DesktopPasskeyRequests({
      native: passkeyFixture.native,
      presentations: manager,
      transport,
      ownOrigins: () => [],
      windowForContents: desktopWindowForContents,
    });
    cleanup.push(() => passkeyRequests?.dispose());
  }
  const status = await supervisor.start();
  assert.equal(status.state, "ready", JSON.stringify(status));
  const manifest = await files.load();
  assert(manifest);
  const hostOrigin = `http://127.0.0.1:${manifest.hostPort}`;
  const api = createHttpHostApiClient({
    baseUrl: new URL(hostOrigin),
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", hostOrigin);
      return network.partitionFetch(manifest.deploymentId, url, { ...init, headers });
    },
    onAuthenticationRequired: () => {
      throw new Error("Personal owner authentication rejected");
    },
  });
  const bootstrap = await api["bootstrap.get"]({});
  assert(bootstrap.ok, JSON.stringify(bootstrap));
  assert(bootstrap.data.homeWorkspace);
  const opened = await api["commands.dispatch"]({
    type: "browser.session.start",
    idempotencyKey: randomUUID(),
    workspaceId: bootstrap.data.homeWorkspace.id,
    input: { fresh: true, initialUrl: `${origin}/p`, reuseExisting: false },
  });
  assert(opened.ok && opened.data.type === "browser.session.start", JSON.stringify(opened));
  const sessionId = opened.data.session.id;
  artifacts.json("stack.json", {
    deploymentId: manifest.deploymentId,
    sessionId,
    fixtureOrigin: origin,
  });
  const account = {
    account: { available: false, detail: null, identity: null, status: "signed-out" as const },
    schemaVersion: 2 as const,
  };
  const personalAccount = {
    account: null,
    deploymentId: null,
    displayName: null,
    status: "unavailable" as const,
    unlinkStep: null,
  };
  const access = new DeploymentAccessService({
    account: {
      available: false,
      currentState: async () => account,
      beginReauthorization: async () => account,
      beginSignIn: async () => account,
      signOut: async () => account,
      subscribe: () => () => undefined,
    },
    catalog: {
      read: () => projection.read(),
      select: async (id) => {
        await catalog.select(id);
        await transport.selection();
        return projection.read();
      },
      subscribe: (listener) => catalog.subscribe(listener),
    },
    direct: { addRoute: unavailable, connect: unavailable },
    directory: {
      removeFromAccount: unavailable,
      syncAccountDeployments: async () => ({ changed: false, unavailable: [] }),
    },
    hostSession: {
      abandonAuthorization: (id) => hostSessions.abandonAuthorization(id),
      closeCurrent: async () => transport.closeAllSockets(),
      establish: (id) => hostSessions.establish(id),
      subscribe: (listener) => hostSessions.subscribe(listener),
    },
    personal: supervisor,
    personalAccount: {
      link: unavailable,
      resetJournal: unavailable,
      status: async () => personalAccount,
      subscribe: () => () => undefined,
      unlink: unavailable,
    },
    places: { online: () => true, probe: async () => "reachable" },
  });
  await access.initialize();
  cleanup.push(function disposeDeploymentAccess() {
    access.dispose();
  });
  const bridgeToken = randomBytes(32).toString("base64url");
  const uninstallProtocol = installDesktopAppProtocol(protocol, path.join(desktop, "dist/web"));
  cleanup.push(function uninstallDesktopProtocol() {
    uninstallProtocol();
  });
  configureDesktopSession(
    session.defaultSession,
    new DesktopAppOriginPolicy(),
    null,
    smokeDownloads,
  );
  const unregisterBridge = registerDesktopBridge(
    bridgeOptions(access, bridgeToken, transport, manager),
  );
  cleanup.push(function unregisterDesktopBridge() {
    unregisterBridge();
  });
  const config = readDesktopConfiguration({
    appDataDirectory: root,
    defaultMode: "test",
    environment: {},
    packaged: false,
  }).config;
  const factory = new ElectronWindowFactory(
    { ...config, mode: "production" },
    {
      bridgeToken,
      preloadPath: path.join(desktop, "dist/preload.cjs"),
      quit: () => app.quit(),
      onCreated: (window) => {
        kit.shell = window;
        manager.attachWindow(window);
        passkeyRequests?.attachWindow(window);
        window.webContents.on("console-message", (event) => {
          if (event.level === "error") consoleErrors.push(event.message);
        });
        window.webContents.on("preload-error", (_event, _file, error) =>
          consoleErrors.push(error.message),
        );
        const send = window.webContents.send.bind(window.webContents);
        window.webContents.send = (channel: string, ...args: unknown[]) => {
          if (channel.endsWith("workspaceTabCommand")) {
            kit.workspaceCommands.push(args[0]);
            artifacts.event("workspace.command", args[0]);
          }
          if (channel.endsWith("browserPresentationEvent")) {
            presentationEvents.push(args[0]);
            artifacts.event("presentation.event", args[0]);
            const target = z
              .object({ presentationId: z.string(), revision: z.number() })
              .safeParse(args[0]);
            if (target.success) kit.latestTarget = target.data;
          }
          if (channel === "opensteer.desktop.host.websocket.event") {
            const delivery = z
              .object({ connectionId: z.string(), type: z.literal("text"), data: z.string() })
              .safeParse(args[0]);
            if (delivery.success) {
              const message = BrowserServerMessageSchema.safeParse(JSON.parse(delivery.data.data));
              if (message.success)
                artifacts.event("socket.message", {
                  connectionId: delivery.data.connectionId,
                  message: message.data.type,
                });
            }
          }
          send(channel, ...args);
        };
      },
    },
  );
  Menu.setApplicationMenu(
    createDesktopApplicationMenu({
      workspaceContents: (window) => (factory.owns(window) ? window.webContents : null),
      browserKey: (key) => {
        artifacts.event("menu.forward", { code: key.code });
        manager.menuKey(key);
      },
    }),
  );
  kit.shell = await factory.create(() => undefined, { show: !selection.noSerial });
  // This geometry matrix also exercises stages below the app's normal minimum.
  // Responsive pane changes are allowed; resizeStage converges on the real stage.
  kit.shell.setMinimumSize(0, 0);
  const workArea = screen.getDisplayMatching(kit.shell.getBounds()).workArea;
  const bounds = kit.shell.getBounds();
  kit.shell.setBounds({
    x: workArea.x,
    y: workArea.y,
    width: Math.min(bounds.width, workArea.width),
    height: Math.min(bounds.height, workArea.height),
  });
  cleanup.push(function destroyShell() {
    if (kit.shell && !kit.shell.isDestroyed()) kit.shell.destroy();
  });
  await access.select(manifest.deploymentId);
  if (selection.noSerial) kit.shell.showInactive();
  else {
    kit.shell.show();
    kit.shell.focus();
  }
  artifacts.json("startup-ui.json", {
    body: await body(),
    buttons: await evaluateApp(
      "Array.from(document.querySelectorAll('button')).map(b=>({text:b.textContent,label:b.getAttribute('aria-label')}))",
    ),
    access: access.snapshot(),
  });
  await kit.openSidebar();
  await until(
    async () =>
      (await evaluateApp(
        "!!document.querySelector('.side-tab[data-group=web] .side-tab__main')",
      )) === true,
    "production browser tab",
    30_000,
  );
  const context = {
    downloadsRoot,
    hostOrigin,
    deploymentId: manifest.deploymentId,
    network,
    supervisor,
    runtimeHandles,
    realtimeState: () => realtimeSockets.map((state) => ({ ...state })),
    viewerState: () => viewerSockets.map((state) => ({ ...state })),
    dropRealtime: () => {
      for (const socket of realtimeHandles) socket.close(4000, "Fixture realtime drop");
    },
    reverifyConnection: async () => {
      transport.closeAllSockets();
      const verified = await verifyAccessEndpoint({
        fetch: (url, init) => network.partitionFetch(manifest.deploymentId, url, init ?? {}),
        kind: "direct",
        origin: hostOrigin,
      });
      await catalog.recordVerifiedCapabilities(verified);
      await transport.selection();
      artifacts.event("connection.reverified", { capabilities: verified.capabilities });
    },
    manager,
    transport,
    api,
    sessionId,
    origin,
    nativeMountBlockReason: "",
    refuseNextControl: (code: 4002 | 4003) => {
      refuseNextControl = code;
    },
    setHold: (value: boolean) => {
      holdSnapshots = value;
    },
    releaseSnapshots: () => {
      for (const deliver of heldSnapshots.splice(0)) deliver();
    },
  };
  kit.setContext(context);
  const initialTabs = await api["browser.tabs.get"]({ sessionId });
  assert(initialTabs.ok && initialTabs.data.tabs[0]);
  const nativeMountReady = () =>
    Promise.resolve(
      pages.size > 0 &&
        (kit.shell?.contentView.children.length ?? 0) > 1 &&
        completedInitialPresentation &&
        kit.presentationEvents.some(
          (event) => z.object({ type: z.literal("placed") }).safeParse(event).success,
        ),
    );
  try {
    await kit.selectNativePage(sessionId, initialTabs.data.tabs[0].id);
    await until(nativeMountReady, "native page mounted", 10_000);
  } catch (error) {
    const descriptor = await network.partitionFetch(
      manifest.deploymentId,
      new URL("/.well-known/opensteer", hostOrigin),
      {},
    );
    const document: unknown = await descriptor.json();
    artifacts.json("capability-blocker.json", {
      descriptor: document,
      local: manager.isLocal(BrowserSessionIdSchema.parse(sessionId)),
      nativeMounted: false,
      subscription: outgoing.filter((item) => item.type === "stream.subscribe"),
      error: errorText(error),
    });
    let denial: unknown = null;
    try {
      await evaluateApp(
        "window.opensteerDesktop.hostRequest({method:'GET',path:'/.well-known/opensteer',headers:{accept:'application/json'}})",
      );
    } catch (error) {
      denial = errorText(error);
    }
    artifacts.json("capability-path-denial.json", { denial });
    const evidence = ["capability-blocker.json", "capability-path-denial.json", "trace.jsonl"];
    try {
      evidence.push(await snapshot("M01", "native-unavailable"));
    } catch (error) {
      artifacts.event("capture.failure", { error: errorText(error) });
    }
    const blockedReason = denial
      ? `Native mount setup failed; descriptor preload request rejected: ${String(denial)}`
      : `Native mount setup failed after descriptor access succeeded; ${authorityEvents.some((event) => event.type === "admitted") ? "Host snapshot admitted" : "no Host snapshot admission observed"}; ${presentationEvents.length} presentation events; ${
          outgoing
            .filter((item) => item.type === "stream.subscribe")
            .map((item) => `frames:${item.frames}`)
            .join(", ") || "no stream subscription"
        }. See capability-blocker.json and trace.jsonl.`;
    artifacts.json("native-mount-blocker.json", {
      reason: blockedReason,
      descriptorDenied: denial !== null,
      authorityEvents,
      presentationEvents,
      subscriptions: outgoing.filter((item) => item.type === "stream.subscribe"),
    });
    context.nativeMountBlockReason = blockedReason;
    for (const id of ["M01", "V01", "A07"] as const)
      artifacts.result(id, "FAIL", {
        reason: blockedReason,
        evidence,
      });
    artifacts.remaining(`${blockedReason} This case was not executed.`);
    return;
  }
  assert.equal(consoleErrors.length, 0, consoleErrors.join("\n"));
  assert(descriptorAttempts > descriptorFailures, "Descriptor lookup did not retry to success");
  artifacts.json("descriptor-retry.json", { descriptorAttempts, descriptorFailures });
  await kit.rememberInitialIdentity();
  cleanup.push(async function closeFixtureSession() {
    const result = await api["commands.dispatch"]({
      type: "browser.session.close",
      sessionId,
      idempotencyKey: randomUUID(),
    });
    assert(result.ok, "The owned fixture browser session must close before its transport stops");
  });
  if (passkeyFixture) await passkeyFixture.run(kit);
  else await runJourney(kit);
}

function registerSource(
  manager: DesktopBrowserPresentationManager,
  source: NativePresentationSource,
): () => void {
  runtimeSources.add(source);
  const observers = new Set<() => void>();
  const unregister = manager.registerSource({
    hasSession: (id) => {
      const local = source.hasSession(id);
      artifacts.event("locality.answer", { id, local });
      return local;
    },
    presentSurface: (sessionId, surfaceId) => {
      const surface = source.presentSurface(sessionId, surfaceId);
      if (!surface) return null;
      pages.set(surfaceId, surface);
      const unobserve = surface.page.observeHumanInput?.((observation) =>
        artifacts.event("surface.human", { surfaceId, ...observation }),
      );
      const native = electronPagePresentation(surface.page);
      if (native && !observedBoundsViews.has(native.view)) {
        const view = native.view;
        const contents = view.webContents;
        const contentsId = contents.id;
        observedBoundsViews.add(view);
        const originalBegin = contents.beginFrameSubscription;
        const originalEnd = contents.endFrameSubscription;
        const begin = originalBegin.bind(contents);
        const end = originalEnd.bind(contents);
        contents.beginFrameSubscription = (
          first: boolean | ((image: Electron.NativeImage, damage: Electron.Rectangle) => void),
          second?: (image: Electron.NativeImage, damage: Electron.Rectangle) => void,
        ) => {
          const callback = typeof first === "function" ? first : second;
          assert(callback);
          const capture = surface.page.capture?.read();
          artifacts.event("paint.subscribe", {
            contents: contentsId,
            capture,
            bounds: view.getBounds(),
          });
          if (!capture)
            artifacts.event("paint.observerFailure", {
              contents: contentsId,
              reason: "Paint subscription preceded geometry acknowledgement",
            });
          const observe: typeof callback = (image, damage) => {
            artifacts.event("paint.callback", {
              contents: contentsId,
              capture,
              current: surface.page.capture?.read(),
              raster: image.getSize(capture?.rasterScale),
              damage,
            });
            callback(image, damage);
          };
          if (typeof first === "boolean") begin(first, observe);
          else begin(observe);
        };
        contents.endFrameSubscription = () => {
          artifacts.event("paint.unsubscribe", {
            contents: contentsId,
            capture: surface.page.capture?.read(),
          });
          end();
        };
        const unsubscribeCapture = surface.page.capture?.subscribe(() =>
          artifacts.event("capture.applied", {
            surfaceId,
            contents: contentsId,
            capture: surface.page.capture?.read(),
            bounds: contents.isDestroyed() ? null : view.getBounds(),
            geometry: surface.geometry(),
          }),
        );
        const setBounds = view.setBounds;
        const dispose = () => {
          unsubscribeCapture?.();
          contents.beginFrameSubscription = originalBegin;
          contents.endFrameSubscription = originalEnd;
          view.setBounds = setBounds;
          contents.removeListener("destroyed", dispose);
          observedBoundsViews.delete(view);
          observers.delete(dispose);
        };
        observers.add(dispose);
        contents.once("destroyed", dispose);
        view.setBounds = (bounds) => {
          const observation = { contents: contentsId, bounds };
          artifacts.event("view.bounds", observation);
          setBounds.call(view, bounds);
          artifacts.event("view.bounds.return", observation);
        };
      }
      let released = false;
      return {
        ...surface,
        follow: (size) => surface.follow(size),
        geometry: () => surface.geometry(),
        onEvent: (listener) => {
          const unsubscribe = surface.onEvent((event) => {
            if (event.type === "geometry") geometry.push({ surfaceId, ...event });
            artifacts.event("surface.event", { surfaceId, event });
            listener(event);
          });
          return () => {
            artifacts.event("surface.unsubscribe", { surfaceId });
            unsubscribe();
          };
        },
        release: () => {
          artifacts.event("surface.release", { surfaceId, duplicate: released });
          released = true;
          unobserve?.();
          surface.release();
        },
      };
    },
  });
  return () => {
    runtimeSources.delete(source);
    unregister();
    for (const dispose of observers) dispose();
  };
}

function bridgeOptions(
  access: DeploymentAccessService,
  bridgeToken: string,
  hostTransport: DesktopHostTransport,
  browserPresentation: DesktopBrowserPresentationManager,
): Parameters<typeof registerDesktopBridge>[0] {
  const unavailable = (): never => {
    throw new Error("This peripheral service is outside the native-browser smoke.");
  };
  const subscribe = () => () => undefined;
  return {
    ...(passkeyRequests ? { passkeys: passkeyRequests } : {}),
    downloads: smokeDownloads,
    access,
    bridgeToken,
    browserPresentation,
    hostTransport,
    ipcMain: {
      removeHandler: (channel) => ipcMain.removeHandler(channel),
      handle: (channel, listener) =>
        ipcMain.handle(channel, async (event, ...args: unknown[]) => {
          artifacts.event("ipc.entry", { channel, owner: event.sender.id });
          const result: unknown = await listener(event, ...args);
          if (channel.endsWith("browserPresent") || channel.endsWith("browserPresentationUpdate")) {
            const parsed = z
              .object({
                ok: z.literal(true),
                value: z.object({ presentationId: z.string().optional(), revision: z.number() }),
              })
              .safeParse(result);
            if (parsed.success && parsed.data.value.presentationId) {
              kit.latestTarget = {
                presentationId: parsed.data.value.presentationId,
                revision: parsed.data.value.revision,
              };
              if (channel.endsWith("browserPresent")) completedInitialPresentation = true;
            }
          }
          artifacts.event("ipc.return", {
            channel,
            owner: event.sender.id,
            ...(channel.endsWith("browserIsLocal") ? { result } : {}),
          });
          return result;
        }),
    },
    localVisibility: { getSnapshot: () => true, subscribe },
    agentPhone: { readArtifact: async () => null, chooseUsbDevice: unavailable },
    computerApps: {
      approvalKey: unavailable,
      dragIcon: unavailable,
      review: unavailable,
      setup: {
        begin: unavailable,
        close: unavailable,
        dragItem: () => null,
        open: unavailable,
        showAgain: unavailable,
        status: unavailable,
      },
    },
    computerUse: {
      onActivationError: unavailable,
      approvalGet: unavailable,
      approvalRespond: unavailable,
      closePermissionsPanel: unavailable,
      openPermissionsPanel: unavailable,
      verifyBundledHelper: unavailable,
      openSystemSettings: unavailable,
      permissions: unavailable,
      requestPermissions: unavailable,
    },
    fullDiskAccess: { check: unavailable, closePanel: unavailable, request: unavailable },
    passwords: {
      open: unavailable,
      signIns: {
        approve: unavailable,
        get: unavailable,
        subscribe,
      },
      status: unavailable,
      subscribe,
    },
    personalRemote: {
      configure: unavailable,
      issuePairingCode: unavailable,
      get status() {
        return unavailable();
      },
      subscribe,
    },
    portal: { openExternal: unavailable, pickFolder: unavailable },
    runner: {
      portableFs: unavailable,
      remove: unavailable,
      start: unavailable,
      status: unavailable,
      subscribe,
    },
  };
}

function prepareShutdown(): void {
  if (shutdownPrepared) return;
  shutdownPrepared = true;
  artifacts.event("normal.quit.requested", {});
  for (const [index, operation] of cleanup.toReversed().entries()) {
    const name = operation.name || `cleanup[${index}]`;
    const personal = name === "stopPersonalSupervisor";
    const order = personal
      ? 40
      : name === "destroyShell"
        ? 70
        : name === "disposePresentationManager"
          ? 75
          : name === "closeHostSockets"
            ? 80
            : name === "closeFixtureServer"
              ? 85
              : 10;
    shutdown.add({
      component: personal ? "personal" : "fixture",
      step: name,
      order,
      timeoutMs: personal ? 22_000 : 10_000,
      stop: operation,
    });
  }
  shutdown.add({
    component: "fixture",
    step: "close-contents-and-verify",
    order: 90,
    timeoutMs: 10_000,
    stop: finish,
  });
}

async function finish(): Promise<void> {
  const failures: unknown[] = [];
  const removeDestroyedListeners: (() => void)[] = [];
  const closed = webContents
    .getAllWebContents()
    .filter((contents) => !contents.isDestroyed())
    .map(
      (contents) =>
        new Promise<void>((resolve) => {
          const destroyed = () => resolve();
          contents.once("destroyed", destroyed);
          removeDestroyedListeners.push(() => contents.removeListener("destroyed", destroyed));
          contents.close({ waitForBeforeUnload: false });
        }),
    );
  for (const window of BaseWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
  try {
    await withTimeout(Promise.all(closed), 10_000, {
      timeoutError: () => new Error("Owned WebContents did not finish closing"),
    });
  } catch (error) {
    failures.push(error);
    artifacts.event("cleanup.error", { error: errorText(error) });
  } finally {
    for (const remove of removeDestroyedListeners) remove();
  }
  for (const [index, witness] of kit.afterCleanup.entries()) {
    const callback = witness.name || `afterCleanup[${index}]`;
    artifacts.event("cleanup.operation.start", { callback, phase: "afterCleanup", index });
    let ok = false;
    try {
      await witness();
      ok = true;
    } catch (error) {
      failures.push(error);
      artifacts.event("cleanup.error", { callback, error: errorText(error) });
    } finally {
      artifacts.event("cleanup.operation.return", { callback, phase: "afterCleanup", index, ok });
    }
  }
  const disposed = {
    windows: windowInventory(),
    webContents: webContents
      .getAllWebContents()
      .map((contents) => ({ id: contents.id, destroyed: contents.isDestroyed() })),
    elapsedMs: Date.now() - started,
    captured: kit.captured,
    consoleErrors,
    ownedChildren,
    survivingOwnedPids: [...ownedPids].filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
  };
  artifacts.json("cleanup.json", disposed);
  if (
    z.array(z.unknown()).parse(disposed.windows).length ||
    disposed.webContents.length ||
    disposed.survivingOwnedPids.length
  )
    failures.push(
      new Error(
        "Owned windows, WebContents or child processes survived fixture shutdown; see cleanup.json.",
      ),
    );
  artifacts.remaining("Scenario dispatch did not produce a result; see trace.jsonl.");
  artifacts.json("geometry.json", geometry);
  clearInterval(liveness);
  const observerFailures = artifacts.trace.filter((row) => row.type.endsWith(".observerFailure"));
  if (observerFailures.length) failures.push(new Error(JSON.stringify(observerFailures)));
  if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
}
