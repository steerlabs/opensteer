import { smokeDesktopDownloads } from "./test-support/smoke-downloads.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { SessionCdpRouter } from "@opensteer/browser-core";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserSessionIdSchema,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import {
  BrowserController,
  HostSignIns,
  SessionFiles,
  SurfaceLedger,
  type BrowserFrame,
  type BrowserLaunchRequest,
} from "@opensteer/browser-runtime-core";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";

const smokeDownloads = smokeDesktopDownloads();

const runFile = promisify(execFile);
const liveness = setInterval(() => undefined, 1_000);
let finished = false;
app.on("before-quit", (event) => {
  if (!finished) event.preventDefault();
});

void run().then(
  () => finish(0, { event: "electron-browser-focus-smoke.passed" }),
  (error: unknown) =>
    finish(1, {
      event: "electron-browser-focus-smoke.failed",
      message: error instanceof Error ? error.stack : String(error),
    }),
);

function finish(code: number, record: Record<string, unknown>): void {
  finished = true;
  clearInterval(liveness);
  const output = `${JSON.stringify(record)}\n`;
  (code === 0 ? process.stdout : process.stderr).write(output);
  if (code === 0) app.quit();
  else app.exit(code);
}

async function run(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The native focus smoke requires macOS WindowServer.");
  }
  await app.whenReady();

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-focus-smoke-"));
  let sentinel: ChildProcess | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  const cleanup: Array<() => Promise<void>> = [];
  try {
    const helper = await buildFocusSentinel(temporaryDirectory);
    const activationLossFile = path.join(temporaryDirectory, "activation-loss-count");
    sentinel = spawn(
      helper,
      ["--loss-file", activationLossFile, "--forbidden-pid", String(process.pid)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const sentinelPid = await readSentinelPid(sentinel);

    server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        request.url === "/dialog"
          ? "<!doctype html><title>Focus dialog</title><script>setTimeout(() => globalThis.dialogResult = confirm('Focus smoke dialog'), 0)</script>"
          : request.url === "/popup"
            ? "<!doctype html><title>Focus popup</title><input id=target autofocus>"
            : "<!doctype html><title>Focus root</title><input id=target autofocus>",
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Focus server address missing.");
    const origin = `http://127.0.0.1:${address.port}`;

    const launcher = new ElectronBrowserLauncher({
      downloads: smokeDownloads,
      pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
    });
    await waitForFrontmost(activationLossFile, sentinelPid);
    const forbiddenActivationBaseline = (await activationState(activationLossFile)).forbiddenCount;
    const focusFailures: Error[] = [];
    const assertBackground = async (stage: string) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const state = await activationState(activationLossFile);
      const systemActual = await systemFrontmostPid();
      // The user may switch between other apps during the test. Only activation
      // of this Electron process violates background browser ownership.
      if (
        state.forbiddenCount !== forbiddenActivationBaseline ||
        state.frontmostPid === process.pid ||
        systemActual === process.pid
      ) {
        const error = new Error(
          `Background browser operation activated Electron at ${stage}: forbidden activation count changed from ${forbiddenActivationBaseline} to ${state.forbiddenCount}.`,
        );
        focusFailures.push(error);
        process.stderr.write(
          `${JSON.stringify({ event: "electron-browser-focus-smoke.focus-failure", message: error.message })}\n`,
        );
      }
      process.stdout.write(
        `${JSON.stringify({ event: "electron-browser-focus-smoke.stage", stage, focusPreserved: focusFailures.length === 0 })}\n`,
      );
    };

    const request: BrowserLaunchRequest = {
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000071",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000072"),
      storage: { kind: "legacy", snapshot: { cookies: [], origins: [] } },
    };
    let browser = await launcher.launch(request);
    cleanup.push(() => browser.close());
    await assertBackground("profile import and launch");
    let page = browser.context.pages()[0];
    if (!page) throw new Error("Electron focus smoke root page missing.");
    // Production wiring: the session's router owns its root page and every
    // page the ledger registers for it.
    const router = new SessionCdpRouter(browser.cdp);
    cleanup.push(() => router.close());
    const sessionFiles = new SessionFiles(path.join(temporaryDirectory, request.sessionId));
    const sessionLedger = new SurfaceLedger(browser.context, {
      claimTarget: (targetId) => router.claimTarget(request.sessionId, targetId),
      initialViewport: request.initialViewport,
    });
    let ledger = sessionLedger;
    cleanup.push(() => sessionLedger.close());
    router.registerSession(
      request.sessionId,
      await page.targetId(),
      (targetId) => sessionLedger.resolveTarget(targetId),
      sessionFiles.root,
    );
    await ledger.start();
    await assertBackground("initial surface selection");
    let pageCdp = await page.cdp();
    await pageCdp.send("Page.navigate", { url: origin });
    await waitFor(() => page.url() === `${origin}/`);

    const messages: BrowserServerMessage[] = [];
    const frames: BrowserFrame[] = [];
    const controller = new BrowserController({
      cdpRouter: router,
      claims: BrowserAttachTicketClaimsSchema.parse({
        access: "full-control",
        audience: "opensteer-browser-runtime",
        expiresAt: "2099-01-01T00:05:00.000Z",
        identity: { kind: "fresh" },
        issuedAt: "2099-01-01T00:00:00.000Z",
        nonce: "focus-smoke-nonce-0123456789",
        runtimeId: "electron-focus-smoke",
        sessionId: request.sessionId,
        subject: "electron-focus-smoke",
      }),
      exportSnapshot: () => browser.exportSnapshot(),
      files: sessionFiles,
      replaceSiteCookies: (site, cookies, deadline) =>
        browser.replaceSiteCookies(site, cookies, deadline),
      signIns: new HostSignIns({
        state: { run: (work) => work() },
        writeCookies: () => Promise.resolve(),
        deliveryTimeoutMs: 1_000,
        executor: undefined,
        fresh: true,
        runtimeId: "electron-smoke",
      }),
      ledger,
      sink: {
        sendFrame: async (frame) => {
          frames.push(frame);
        },
        sendServer: async (message) => {
          messages.push(message);
        },
      },
    });
    cleanup.push(() => controller.close());
    await controller.start();

    await controller.handle({ type: "stream.subscribe" });
    await waitFor(() => frames.length > 0);
    const firstFrameId = frames.at(-1)?.header.frameId ?? 0;

    const active = ledger.active();
    if (!active) throw new Error("Electron focus smoke active surface missing.");
    await active.cdp.send("Runtime.evaluate", {
      expression:
        'document.cookie="focus=preserved; SameSite=Lax"; localStorage.setItem("focus", "preserved"); document.querySelector("#target").focus(); document.body.style.background="rgb(12, 34, 56)"',
    });
    await waitFor(() => frames.some((frame) => frame.header.frameId > firstFrameId));
    await assertBackground("live stream frame advancement");
    await controller.handle({
      surfaceId: active.surface.id,
      text: "agent-input",
      type: "clipboard.paste",
    });
    await controller.handle({
      action: "down",
      code: "KeyA",
      key: "a",
      modifiers: [],
      surfaceId: active.surface.id,
      text: "a",
      type: "input.key",
    });
    const inputValue = await active.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: 'document.querySelector("#target").value',
      returnByValue: true,
    });
    if (inputValue.result?.value !== "agent-inputa") {
      throw new Error(`Electron focus smoke input mismatch: ${JSON.stringify(inputValue)}`);
    }
    await assertBackground("agent keyboard input");

    await active.cdp.send("Runtime.evaluate", {
      expression:
        'globalThis.clickCount=0; document.addEventListener("click", () => globalThis.clickCount += 1)',
    });
    await controller.handle({
      action: "down",
      button: "left",
      clickCount: 1,
      surfaceId: active.surface.id,
      type: "input.pointer",
      viewportHeight: 600,
      viewportWidth: 800,
      x: 0.5,
      y: 0.5,
    });
    await controller.handle({
      action: "up",
      button: "left",
      clickCount: 1,
      surfaceId: active.surface.id,
      type: "input.pointer",
      viewportHeight: 600,
      viewportWidth: 800,
      x: 0.5,
      y: 0.5,
    });
    const clickCount = await active.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: "globalThis.clickCount",
      returnByValue: true,
    });
    if (clickCount.result?.value !== 1) {
      throw new Error(`Electron focus smoke click mismatch: ${JSON.stringify(clickCount)}`);
    }
    await assertBackground("agent pointer input");

    const screenshot = await active.cdp.send<{ data?: unknown }>("Page.captureScreenshot", {
      format: "png",
    });
    if (typeof screenshot.data !== "string" || screenshot.data.length === 0) {
      throw new Error("Electron focus smoke did not capture a screenshot.");
    }
    await assertBackground("screenshot capture");

    const attachRequestId = "00000000-0000-4000-8000-000000000073";
    await controller.handle({
      command: {
        method: "Target.attachToTarget",
        parameters: { targetId: active.targetId },
      },
      requestId: attachRequestId,
      type: "cdp.command",
    });
    const attached = messages.find(
      (message) => message.type === "cdp.result" && message.requestId === attachRequestId,
    );
    const agentSessionId =
      attached?.type === "cdp.result" &&
      attached.result &&
      typeof attached.result === "object" &&
      typeof (attached.result as { sessionId?: unknown }).sessionId === "string"
        ? (attached.result as { sessionId: string }).sessionId
        : null;
    if (!agentSessionId) throw new Error("Electron focus smoke did not attach agent CDP.");
    await active.cdp.send("Runtime.evaluate", {
      expression: "window.focus()",
    });
    await assertBackground("website window.focus");
    await active.cdp.send("Runtime.evaluate", {
      expression: `window.open(${JSON.stringify(`${origin}/popup`)}, "_blank")`,
    });
    await waitFor(() => ledger.snapshot().some((surface) => surface.openerId != null));
    await assertBackground("popup creation");

    await controller.handle({ type: "surface.open", url: `${origin}/popup` });
    await waitFor(() => ledger.snapshot().length === 3);
    await assertBackground("tab creation");
    const root = ledger.snapshot().find((surface) => surface.openerId == null);
    if (!root) throw new Error("Electron focus smoke root surface disappeared.");
    await controller.handle({ surfaceId: root.id, type: "surface.activate" });
    await assertBackground("tab selection");
    await controller.handle({ surfaceId: root.id, type: "surface.activate" });
    await assertBackground("repeated active tab selection");

    const beforeBringToFront = ledger.snapshot().find((surface) => surface.id !== root.id);
    if (!beforeBringToFront) throw new Error("Electron focus smoke selection target missing.");
    // The agent's activation names its own target; the person's view stays.
    await controller.handle({ surfaceId: beforeBringToFront.id, type: "surface.activate" });
    await controller.handle({
      command: { method: "Page.bringToFront", sessionId: agentSessionId },
      requestId: "00000000-0000-4000-8000-000000000074",
      type: "cdp.command",
    });
    if (ledger.active()?.surface.id !== beforeBringToFront.id) {
      throw new Error("Page.bringToFront changed the person's tab.");
    }
    await assertBackground("Page.bringToFront");

    await controller.handle({
      command: {
        method: "Target.activateTarget",
        parameters: { targetId: active.targetId },
      },
      requestId: "00000000-0000-4000-8000-000000000075",
      type: "cdp.command",
    });
    if (ledger.active()?.surface.id !== beforeBringToFront.id) {
      throw new Error("Target.activateTarget changed the person's tab.");
    }
    await assertBackground("Target.activateTarget");

    const createTargetRequestId = "00000000-0000-4000-8000-000000000076";
    await controller.handle({
      command: { method: "Target.createTarget", parameters: { url: `${origin}/popup` } },
      requestId: createTargetRequestId,
      type: "cdp.command",
    });
    const created = messages.find(
      (message) => message.type === "cdp.result" && message.requestId === createTargetRequestId,
    );
    const createdTargetId =
      created?.type === "cdp.result" &&
      created.result &&
      typeof created.result === "object" &&
      typeof (created.result as { targetId?: unknown }).targetId === "string"
        ? (created.result as { targetId: string }).targetId
        : null;
    if (!createdTargetId) throw new Error("Target.createTarget did not return a target ID.");
    await waitFor(() => ledger.snapshot().length === 4);
    await assertBackground("Target.createTarget");

    const closing = ledger.snapshot().find((surface) => surface.id !== root.id);
    if (!closing) throw new Error("Electron focus smoke close target missing.");
    await controller.handle({ surfaceId: closing.id, type: "surface.close" });
    await assertBackground("inactive tab closure");
    const current = ledger.active();
    if (!current) throw new Error("Electron focus smoke active close target missing.");
    const replacement = ledger
      .snapshot()
      .find((surface) => surface.id !== current.surface.id && surface.id !== root.id);
    if (!replacement) throw new Error("Electron focus smoke replacement tab missing.");
    await controller.handle({ surfaceId: replacement.id, type: "surface.activate" });
    await controller.handle({ surfaceId: replacement.id, type: "surface.close" });
    await assertBackground("active tab closure and fallback selection");

    await controller.handle({ surfaceId: root.id, type: "surface.activate" });
    const presented = ledger.active();
    if (!presented) throw new Error("Electron focus smoke viewed page missing.");
    await presented.cdp.send("Runtime.evaluate", { expression: "window.focus()" });
    await assertBackground("viewed website window.focus");
    const surfacesBeforeViewedPopup = new Set(ledger.snapshot().map((surface) => surface.id));
    await presented.cdp.send("Runtime.evaluate", {
      expression: `window.open(${JSON.stringify(`${origin}/popup`)}, "_blank")`,
    });
    await waitFor(() => ledger.snapshot().length === surfacesBeforeViewedPopup.size + 1);
    await assertBackground("popup from viewed page");
    const viewedPopup = ledger
      .snapshot()
      .find((surface) => !surfacesBeforeViewedPopup.has(surface.id));
    // The agent commanded this page after the person last acted there.
    if (!viewedPopup || viewedPopup.active) {
      throw new Error("A popup the person did not open took their view.");
    }
    await controller.handle({ surfaceId: viewedPopup.id, type: "surface.close" });
    await assertBackground("viewed popup closure");
    await controller.handle({ surfaceId: presented.surface.id, type: "surface.activate" });

    // The person's own click in the page they watch opens a popup: it comes
    // forward in the viewer, and native focus stays where it was.
    await presented.cdp.send("Runtime.evaluate", {
      expression: `document.addEventListener("click", () => window.open(${JSON.stringify(`${origin}/popup`)}, "_blank"), { once: true })`,
    });
    const surfacesBeforePersonPopup = new Set(ledger.snapshot().map((surface) => surface.id));
    for (const action of ["down", "up"] as const) {
      await controller.handle({
        action,
        button: "left",
        clickCount: 1,
        surfaceId: presented.surface.id,
        type: "input.pointer",
        viewportHeight: 600,
        viewportWidth: 800,
        x: 0.5,
        y: 0.5,
      });
    }
    await waitFor(() =>
      ledger.snapshot().some((surface) => !surfacesBeforePersonPopup.has(surface.id)),
    );
    await assertBackground("popup the person opened");
    const personPopup = ledger.active();
    if (!personPopup || personPopup.surface.openerId == null) {
      throw new Error("The popup the person opened did not come forward.");
    }
    await controller.handle({ surfaceId: personPopup.surface.id, type: "surface.close" });
    await assertBackground("person popup closure");
    await controller.handle({ surfaceId: presented.surface.id, type: "surface.activate" });
    for (const scenario of [
      {
        accept: true,
        expected: true,
        expression: "confirm('Accept focus smoke')",
        name: "confirm accept",
      },
      {
        accept: false,
        expected: false,
        expression: "confirm('Dismiss focus smoke')",
        name: "confirm dismiss",
      },
      {
        accept: true,
        expected: "alert returned",
        expression: "(alert('Focus smoke alert'), 'alert returned')",
        name: "alert",
      },
    ]) {
      const dialogStart = messages.length;
      await presented.cdp.send("Runtime.evaluate", {
        expression: `setTimeout(() => { globalThis.dialogResult = ${scenario.expression}; }, 0)`,
      });
      await waitFor(() =>
        messages
          .slice(dialogStart)
          .some((message) => message.type === "browser.dialog.changed" && message.dialog !== null),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await assertBackground(`viewed ${scenario.name} awaiting response`);
      } finally {
        await controller.handle({
          accept: scenario.accept,
          dialogId: shownDialogId(messages),
          type: "dialog.respond",
        });
      }
      const result = await presented.cdp.send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: "globalThis.dialogResult",
          returnByValue: true,
        },
      );
      if (result.result?.value !== scenario.expected) {
        throw new Error(
          `${scenario.name} returned ${JSON.stringify(result.result?.value)}, expected ${JSON.stringify(scenario.expected)}.`,
        );
      }
      await assertBackground(`viewed ${scenario.name} response`);
    }
    // Electron 43 rejects prompt() in the renderer. Pin that platform
    // limitation without pretending the CDP response path can supply an answer.
    const promptResult = await presented.cdp.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      {
        expression:
          "(() => { try { prompt('Focus smoke prompt', 'default'); return null; } catch (error) { return error.message; } })()",
        returnByValue: true,
      },
    );
    if (promptResult.result?.value !== "prompt() is not supported.") {
      throw new Error(`Electron prompt behavior changed: ${JSON.stringify(promptResult)}`);
    }
    await assertBackground("native prompt rejection (Electron limitation)");
    await presented.cdp.send("Runtime.evaluate", {
      expression:
        "window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = ''; }",
      userGesture: true,
    });
    const beforeUnloadUrl = presented.page.url();
    const preventedNavigation = await presented.cdp.send<{ errorText?: string }>("Page.navigate", {
      url: `${origin}/popup?beforeunload`,
    });
    if (presented.page.url() !== beforeUnloadUrl || !preventedNavigation.errorText) {
      throw new Error(
        `Electron beforeunload did not retain its default prevent behavior: ${JSON.stringify(preventedNavigation)}`,
      );
    }
    await presented.cdp.send("Runtime.evaluate", { expression: "window.onbeforeunload = null" });
    await assertBackground("native beforeunload prevention");

    await controller.handle({ surfaceId: root.id, type: "surface.activate" });
    const parkedDialogStart = messages.length;
    await active.cdp.send("Page.navigate", { url: `${origin}/dialog` });
    await waitFor(() =>
      messages
        .slice(parkedDialogStart)
        .some((message) => message.type === "browser.dialog.changed" && message.dialog !== null),
    );
    await controller.handle({
      accept: true,
      dialogId: shownDialogId(messages),
      type: "dialog.respond",
    });
    await assertBackground("website focus and dialog handling");

    await controller.handle({ type: "state.export" });
    if (!messages.some((message) => message.type === "state.exported")) {
      throw new Error("Electron focus smoke did not export browser state.");
    }
    const snapshot = await browser.exportSnapshot();
    await assertBackground("profile export");
    await controller.handle({ type: "stream.unsubscribe" });
    await controller.close();
    await router.close();
    await ledger.close();
    await browser.close();

    browser = await launcher.launch({ ...request, storage: { kind: "legacy", snapshot } });
    cleanup.push(() => browser.close());
    const restoredLedger = new SurfaceLedger(browser.context, {
      initialViewport: request.initialViewport,
    });
    ledger = restoredLedger;
    cleanup.push(() => restoredLedger.close());
    await ledger.start();
    page = browser.context.pages()[0];
    if (!page) throw new Error("Electron restored focus smoke page missing.");
    pageCdp = await page.cdp();
    await pageCdp.send("Page.navigate", { url: origin });
    await waitFor(() => page.url() === `${origin}/`);
    const restored = await pageCdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
      expression: '({ cookie: document.cookie, localStorage: localStorage.getItem("focus") })',
      returnByValue: true,
    });
    if (
      JSON.stringify(restored.result?.value) !==
      JSON.stringify({ cookie: "focus=preserved", localStorage: "preserved" })
    ) {
      throw new Error(`Electron focus smoke profile restore mismatch: ${JSON.stringify(restored)}`);
    }
    await assertBackground("profile restore and relaunch");
    await ledger.close();
    await browser.close();
    if (focusFailures.length > 0) {
      throw new AggregateError(
        focusFailures,
        focusFailures.map((error) => error.message).join("\n"),
      );
    }
  } finally {
    for (const operation of cleanup.reverse()) {
      await Promise.race([
        operation().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    if (server) {
      server.closeAllConnections();
      server.close();
    }
    if (sentinel && sentinel.exitCode === null) {
      sentinel.kill("SIGTERM");
      await once(sentinel, "exit").catch(() => undefined);
    }
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function buildFocusSentinel(directory: string): Promise<string> {
  const source = path.join(directory, "FocusSentinel.swift");
  const executable = path.join(directory, "focus-sentinel");
  await writeFile(
    source,
    `import AppKit

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let lossFileIndex = CommandLine.arguments.firstIndex(of: "--loss-file")
let lossFile = lossFileIndex.flatMap { index in
  CommandLine.arguments.indices.contains(index + 1) ? CommandLine.arguments[index + 1] : nil
}
let forbiddenPidIndex = CommandLine.arguments.firstIndex(of: "--forbidden-pid")
let forbiddenPid = forbiddenPidIndex.flatMap { index in
  CommandLine.arguments.indices.contains(index + 1) ? Int32(CommandLine.arguments[index + 1]) : nil
}
var activationLossCount = 0
var forbiddenActivationCount = 0
var frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
func writeActivationState() {
  guard let lossFile else { return }
  try? "\\(activationLossCount),\\(frontmostPid),\\(forbiddenActivationCount)".write(toFile: lossFile, atomically: true, encoding: .utf8)
}
writeActivationState()
let workspaceNotifications = NSWorkspace.shared.notificationCenter
let activationObserver = workspaceNotifications.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification,
  object: nil,
  queue: .main
) { notification in
  guard let activated = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
  frontmostPid = activated.processIdentifier
  if frontmostPid != ProcessInfo.processInfo.processIdentifier { activationLossCount += 1 }
  if frontmostPid == forbiddenPid { forbiddenActivationCount += 1 }
  writeActivationState()
}
let window = NSWindow(
  contentRect: NSRect(x: 120, y: 120, width: 480, height: 240),
  styleMask: [.titled, .closable],
  backing: .buffered,
  defer: false
)
window.title = "Opensteer Focus Sentinel"
let input = NSTextField(frame: NSRect(x: 40, y: 100, width: 400, height: 28))
input.stringValue = "sentinel-input"
window.contentView?.addSubview(input)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(input)
application.activate(ignoringOtherApps: true)
print(ProcessInfo.processInfo.processIdentifier)
fflush(stdout)
application.run()
workspaceNotifications.removeObserver(activationObserver)
`,
  );
  await runFile("xcrun", ["swiftc", source, "-o", executable]);
  return executable;
}

async function readSentinelPid(child: ChildProcess): Promise<number> {
  if (!child.stdout) throw new Error("Focus sentinel stdout missing.");
  child.stdout.setEncoding("utf8");
  return await new Promise<number>((resolve, reject) => {
    let output = "";
    const onData = (chunk: string) => {
      output += chunk;
      const line = output.split("\n")[0];
      if (!line) return;
      cleanup();
      const pid = Number(line);
      if (Number.isInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error(`Focus sentinel returned an invalid PID: ${line}`));
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Focus sentinel exited before becoming ready."));
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function systemFrontmostPid(): Promise<number> {
  const { stdout: front } = await runFile("lsappinfo", ["front"]);
  const { stdout: info } = await runFile("lsappinfo", ["info", "-only", "pid", front.trim()]);
  const match = /\b"?pid"?\s*=\s*(\d+)/u.exec(info);
  const pid = Number(match?.[1]);
  if (!Number.isInteger(pid) || pid < 1) throw new Error(`Invalid lsappinfo PID: ${info}`);
  return pid;
}

async function activationState(
  file: string,
): Promise<{ count: number; forbiddenCount: number; frontmostPid: number }> {
  const [rawCount, rawPid, rawForbiddenCount] = (await readFile(file, "utf8")).trim().split(",");
  const count = Number(rawCount);
  const frontmostPid = Number(rawPid);
  const forbiddenCount = Number(rawForbiddenCount);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid sentinel activation loss count: ${count}`);
  }
  if (!Number.isInteger(frontmostPid) || frontmostPid < 1) {
    throw new Error(`Invalid sentinel frontmost PID: ${frontmostPid}`);
  }
  if (!Number.isInteger(forbiddenCount) || forbiddenCount < 0) {
    throw new Error(`Invalid forbidden activation count: ${forbiddenCount}`);
  }
  return { count, forbiddenCount, frontmostPid };
}

async function waitForFrontmost(file: string, expectedPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await activationState(file)).frontmostPid !== expectedPid) {
    if (Date.now() >= deadline) throw new Error("Focus sentinel did not become frontmost.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The dialog the person sees now, as the latest `browser.dialog.changed` named it. */
function shownDialogId(messages: readonly BrowserServerMessage[]): string {
  const latest = messages.findLast((message) => message.type === "browser.dialog.changed");
  if (latest?.type !== "browser.dialog.changed" || !latest.dialog) {
    throw new Error("No browser dialog is shown.");
  }
  return latest.dialog.id;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Electron focus smoke condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
