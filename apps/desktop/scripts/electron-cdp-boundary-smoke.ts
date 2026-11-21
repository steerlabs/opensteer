import { app, BrowserWindow } from "electron";
import {
  SessionCdpRouter,
  ExecutionContextInventory,
  type CdpParameters,
} from "@opensteer/browser-core";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";
import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";

// Run only in a disposable VM. This fixture deliberately creates a privileged product target.
const root = await mkdtemp(path.join(tmpdir(), "opensteer-cdp-boundary-"));
app.setPath("userData", root);
app.commandLine.appendSwitch("headless");
app.on("window-all-closed", () => undefined);
const artifactDirectory =
  process.argv.find((value) => value.startsWith("--artifact-dir="))?.slice(15) ??
  process.env.OPENSTEER_CDP_BOUNDARY_E2E_ARTIFACT_DIR ??
  path.join(tmpdir(), "opensteer-cdp-boundary-e2e");
const report: { engine: string; passed: boolean; checks: string[]; error?: string } = {
  engine: "electron",
  passed: false,
  checks: [],
};
void run().then(
  () => finish(),
  (error: unknown) => finish(error),
);
async function run() {
  await app.whenReady();
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "session=fixture; HttpOnly; Path=/",
    });
    response.end("<!doctype html><title>Browser boundary</title><body>Page</body>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind");
  const url = `http://127.0.0.1:${address.port}`;
  const launcher = new ElectronBrowserLauncher({
    downloads: smokeDesktopDownloads(),
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000301");
  const browser = await launcher.launch({
    initialViewport: { devicePixelRatio: 1, width: 800, height: 600 },
    partitionKey: `session:${sessionId}`,
    sessionId,
    storage: { kind: "guest" },
  });
  const product = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const router = new SessionCdpRouter(browser.cdp);
  try {
    const page = browser.context.pages()[0]!;
    const targetId = await page.targetId();
    const platform = await page.cdp();
    await platform.send("Page.enable");
    const loaded = Promise.withResolvers<void>();
    platform.on("Page.loadEventFired", () => loaded.resolve());
    await platform.send("Page.navigate", { url });
    await withTimeout(loaded.promise, 5000, {
      timeoutError: () => new Error("Fixture page did not load"),
    });
    const contexts = new ExecutionContextInventory();
    platform.onEvent((method, parameters) => contexts.observe(method, parameters));
    await platform.send("Runtime.enable");
    router.registerSession(
      sessionId,
      targetId,
      async (id) => id === targetId,
      path.join(root, "files"),
    );
    const attached = (await router.send(sessionId, {
      method: "Target.attachToTarget",
      parameters: { targetId },
    })) as { sessionId: string };
    const send = (method: string, parameters: CdpParameters = {}) =>
      router.send(sessionId, { method, parameters, sessionId: attached.sessionId });
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Log.enable");
    const cookies = await send("Network.getAllCookies");
    assert(
      JSON.stringify(cookies).includes("fixture"),
      "HttpOnly cookies did not reach the admitted page",
    );
    report.checks.push("Network, Log and cookies are available");
    const tree = (await send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    const world = (await send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "agent-world",
    })) as { executionContextId: number };
    const result = await send("Runtime.evaluate", {
      contextId: world.executionContextId,
      expression: "42",
      returnByValue: true,
    });
    assert(
      JSON.stringify(result).includes("42"),
      "The agent could not evaluate in its isolated world",
    );
    report.checks.push("Page isolated worlds work");
    for (const context of contexts
      .entries()
      .filter(
        (entry) =>
          String(entry.description.name).startsWith("opensteer-") ||
          String(entry.description.name).includes("Electron"),
      ))
      await refuse(() =>
        send("Runtime.evaluate", {
          contextId: context.id,
          expression: "globalThis",
          returnByValue: true,
        }),
      );
    await refuse(() =>
      send("Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: "opensteer-frame",
      }),
    );
    await refuse(() => send("HeapProfiler.takeHeapSnapshot"));
    await refuse(() => send("Target.attachToBrowserTarget"));
    await refuse(() => send("Browser.close"));
    await refuse(() => send("Storage.getCookies", { browserContextId: "foreign-profile" }));
    report.checks.push("Preload, platform worlds, shared heap and runtime control are isolated");
    product.webContents.debugger.attach("1.3");
    const info = (await product.webContents.debugger.sendCommand("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    };
    await refuse(() =>
      router.send(sessionId, {
        method: "Target.attachToTarget",
        parameters: { targetId: info.targetInfo.targetId },
      }),
    );
    const inventory = await router.send(sessionId, { method: "Target.getTargets" });
    assert(
      !JSON.stringify(inventory).includes(info.targetInfo.targetId),
      "Opensteer's app target appeared in browser inventory",
    );
    report.checks.push("Opensteer app targets are unreachable");
    await router.unregisterSession(sessionId);
    await refuse(() => send("Network.enable"));
    report.checks.push("Stop retires page channels");
    report.passed = true;
  } finally {
    product.destroy();
    await router.close();
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function refuse(work: () => Promise<unknown>) {
  let refused = false;
  try {
    await work();
  } catch {
    refused = true;
  }
  assert(refused, "An Opensteer internal target/world or foreign context was reachable");
}
async function finish(error?: unknown) {
  if (error) report.error = error instanceof Error ? error.message : String(error);
  await mkdir(artifactDirectory, { recursive: true });
  const artifact = path.join(artifactDirectory, "electron.json");
  await writeFile(artifact, `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify({ artifact, event: report.passed ? "electron-cdp-boundary-smoke.passed" : "electron-cdp-boundary-smoke.failed" })}\n`,
  );
  app.exit(error ? 1 : 0);
}
