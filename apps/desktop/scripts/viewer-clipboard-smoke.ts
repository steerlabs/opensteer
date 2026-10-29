import { mkdirSync, existsSync as guestMarkerExists } from "node:fs";
/** VM-only smoke: real preload/IPC/clipboard and physical macOS menu shortcuts. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem as NativeClipboardItem,
  ipcMain,
  Menu,
  protocol,
} from "electron";
import { viewerClipboardHandlers } from "../src/bridge/methods/viewer-clipboard.js";
import { desktopBridgeChannels } from "../src/bridge/desktop-bridge-channels.js";
import type { DesktopBridgeContext } from "../src/bridge/context.js";
import type { BrowserCommand } from "@opensteer/client/host";

if (
  !guestMarkerExists(path.join(process.env.HOME!, ".opensteer-test-guest")) &&
  !process.cwd().endsWith("/opensteer-job/src/apps/desktop")
)
  throw new Error("Run this native smoke only through pnpm test:vm.");
const output =
  process.env.OPENSTEER_VIEWER_SMOKE_EVIDENCE_DIR ??
  path.join(
    process.env.OPENSTEER_JOURNEY_OUT ?? path.join(process.env.HOME!, "opensteer-job/artifacts"),
    "viewer-clipboard",
  );
mkdirSync(path.join(output, "user-data"), { recursive: true });
app.setPath("userData", path.join(output, "user-data"));
app.setPath("sessionData", path.join(output, "user-data"));
const bundle = process.env.OPENSTEER_VIEWER_SMOKE_BUNDLE;
if (!bundle)
  throw new Error("Set OPENSTEER_VIEWER_SMOKE_BUNDLE to the compiled viewer journey fixture.");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const token = "viewer-clipboard-smoke-capability-0000000000000000";
const records: { name: string; status: "passed" | "failed"; error?: string }[] = [];
const run = promisify(execFile);
let window: BrowserWindow | null = null;
let active = false;
let nativeWrites = 0;
const wait = async (predicate: () => Promise<boolean>, name: string) => {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${name}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const key = async (value: string) => {
  await run(
    "osascript",
    [
      "-e",
      `tell application "System Events" to keystroke ${JSON.stringify(value)} using {command down}`,
    ],
    { timeout: 10000 },
  );
};
void app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const timeout = setTimeout(() => {
    records.push({
      name: "suite",
      status: "failed",
      error: "Native viewer smoke exceeded 90 seconds.",
    });
    void writeFile(path.join(output, "result.json"), JSON.stringify(records, null, 2)).finally(() =>
      app.exit(1),
    );
  }, 90000);
  try {
    protocol.handle("app", async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/viewer.js" || url.pathname === "/viewer.css")
        return new Response(
          await readFile(path.join(path.dirname(bundle), url.pathname.slice(1))),
          {
            headers: {
              "Content-Type": url.pathname.endsWith("js") ? "text/javascript" : "text/css",
            },
          },
        );
      return new Response(
        '<div id="root"></div><link rel="stylesheet" href="/viewer.css"><style>.browser-canvas{position:relative;width:900px;height:600px}.browser-canvas canvas{width:100%;height:100%}</style><script type="module" src="/viewer.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    });
    const context = { options: { bridgeToken: token } } as unknown as DesktopBridgeContext;
    for (const [channel, handler] of viewerClipboardHandlers(context))
      ipcMain.handle(channel, (event, envelope) => {
        if (channel === desktopBridgeChannels.setViewerKeyboardActive)
          active = envelope.input === true;
        if (channel === desktopBridgeChannels.writeViewerClipboard) nativeWrites++;
        return handler(event, envelope);
      });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }]));
    await clipboard.writeText("VM clipboard sentinel");
    window = new BrowserWindow({
      show: true,
      width: 1000,
      height: 740,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.resolve("dist/preload.cjs"),
        additionalArguments: [`--opensteer-desktop-bridge-token=${token}`],
      },
    });
    await window.loadURL("app://opensteer/");
    const view = window;
    await wait(
      () =>
        view.webContents.executeJavaScript(
          `!!window.remoteEditingJourney?.ready() && !document.querySelector('textarea[aria-label="Browser keyboard input"]')?.disabled`,
        ),
      "presented proxy",
    );
    await view.webContents.executeJavaScript(
      `document.querySelector('textarea[aria-label="Browser keyboard input"]').focus()`,
    );
    app.focus({ steal: true });
    view.focus();
    await wait(async () => active, "native menu suppression");
    await key("a");
    await wait(
      () =>
        view.webContents.executeJavaScript(
          'remoteEditingJourney.commands().some(c=>c.type==="input.command"&&c.command==="selectAll")',
        ),
      "Cmd+A reaching the viewer",
    );
    records.push({
      name: "Cmd+A reaches the viewer with an Edit menu installed",
      status: "passed",
    });
    await key("c");
    await wait(
      async () => (await clipboard.readText()) === "remote clipboard fixture",
      "native clipboard IPC result",
    );
    assert.equal(nativeWrites, 1);
    records.push({
      name: "Cmd+C writes through the real preload and authorized main clipboard port once",
      status: "passed",
    });
    await clipboard.write([
      new NativeClipboardItem({
        "text/plain": "native paste fixture",
        "text/html": "<b>native paste fixture</b>",
      }),
    ]);
    await key("v");
    await wait(
      () =>
        view.webContents.executeJavaScript(
          'remoteEditingJourney.commands().some(c=>c.type==="clipboard.paste-data")',
        ),
      "trusted native paste",
    );
    const commands: BrowserCommand[] = await view.webContents.executeJavaScript(
      "remoteEditingJourney.commands()",
    );
    const paste = commands.find((command) => command.type === "clipboard.paste-data");
    assert(paste?.type === "clipboard.paste-data");
    assert(paste.items.some((item) => item.type === "text/plain"));
    assert(paste.items.some((item) => item.type === "text/html"));
    records.push({
      name: "Cmd+V reaches the trusted proxy paste event with text and HTML",
      status: "passed",
    });
    await view.webContents.executeJavaScript("remoteEditingJourney.emptyCopy()");
    await key("c");
    await wait(
      () =>
        view.webContents.executeJavaScript("(remoteEditingJourney.clipboardOutcomes().empty??0)>0"),
      "empty copy outcome",
    );
    assert.equal(nativeWrites, 1);
    assert.equal(await clipboard.readText(), "native paste fixture");
    records.push({ name: "Empty copy leaves the native clipboard untouched", status: "passed" });
    await writeFile(
      path.join(output, "viewer.png"),
      (await view.webContents.capturePage()).toPNG(),
    );
    await view.webContents.executeJavaScript("remoteEditingJourney.close()");
  } catch (error) {
    records.push({
      name: "suite",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    if (window && !window.isDestroyed())
      await writeFile(
        path.join(output, "failure.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
  } finally {
    clearTimeout(timeout);
    for (const [channel] of viewerClipboardHandlers({
      options: { bridgeToken: token },
    } as unknown as DesktopBridgeContext))
      ipcMain.removeHandler(channel);
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify(
        {
          records,
          nativeWrites,
          keyboardActive: active,
          passed: records.length === 4 && records.every((record) => record.status === "passed"),
        },
        null,
        2,
      ),
    );
    process.exitCode =
      records.length === 4 && records.every((record) => record.status === "passed") ? 0 : 1;
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(process.exitCode);
  }
});
