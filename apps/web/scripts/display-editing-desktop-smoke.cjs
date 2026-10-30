/** Run only inside pnpm test:vm; uses the shipping preload/main clipboard handlers. */
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  ipcMain,
  Menu,
  protocol,
} = require("electron");
const { viewerClipboardHandlers } = require("../../desktop/src/bridge/methods/viewer-clipboard.ts");
const { desktopBridgeChannels } = require("../../desktop/src/bridge/desktop-bridge-channels.ts");
if (
  !require("node:fs").existsSync(path.join(process.env.HOME, ".opensteer-test-guest")) &&
  !process.cwd().endsWith("/opensteer-job/src/apps/desktop")
)
  throw new Error("Use pnpm test:vm.");
const output = path.join(
  process.env.OPENSTEER_JOURNEY_OUT ?? path.join(process.env.HOME, "opensteer-job/artifacts"),
  "display-editing",
);
require("node:fs").mkdirSync(path.join(output, "user-data"), { recursive: true });
app.setPath("userData", path.join(output, "user-data"));
app.setPath("sessionData", path.join(output, "user-data"));
const bundle = process.env.OPENSTEER_DISPLAY_SMOKE_BUNDLE;
if (!bundle) throw new Error("Missing display fixture bundle");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const token = "display-editing-smoke-capability-0000000000000000";
const run = promisify(execFile);
const records = [];
let window;
let nativeWrites = 0;
let keyboardActive = false;
const wait = async (predicate, name) => {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const key = (value, primary = false) =>
  run(
    "osascript",
    [
      "-e",
      `tell application "System Events" to keystroke ${JSON.stringify(value)}${primary ? " using {command down}" : ""}`,
    ],
    { timeout: 10000 },
  );
void app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const timeout = setTimeout(() => {
    records.push({ name: "suite", passed: false, error: "Exceeded 90 seconds" });
    void writeFile(
      path.join(output, "result.json"),
      JSON.stringify({ passed: false, records }, null, 2),
    ).finally(() => app.exit(1));
  }, 90000);
  const handlers = viewerClipboardHandlers({ options: { bridgeToken: token } });
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
        '<div id="root"></div><link rel="stylesheet" href="/viewer.css"><style>body{margin:20px;font:16px sans-serif}.computer-watch__picture{height:600px;position:relative}.phone-display__canvas{width:720px;height:600px;object-fit:contain}</style><script type="module" src="/viewer.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    });
    for (const [channel, handler] of handlers)
      ipcMain.handle(channel, (event, envelope) => {
        if (channel === desktopBridgeChannels.writeViewerClipboard) nativeWrites++;
        if (channel === desktopBridgeChannels.setViewerKeyboardActive)
          keyboardActive = envelope.input === true;
        return handler(event, envelope);
      });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }]));
    await clipboard.writeText("display VM sentinel");
    window = new BrowserWindow({
      show: true,
      width: 1000,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.resolve("dist/preload.cjs"),
        additionalArguments: [`--opensteer-desktop-bridge-token=${token}`],
      },
    });
    await window.loadURL("app://opensteer/");
    const js = (source) => window.webContents.executeJavaScript(source);
    await wait(
      () => js('!!document.querySelector("textarea.remote-keyboard-input:not(:disabled)")'),
      "shared input",
    );
    await js('document.querySelector("textarea.remote-keyboard-input").focus()');
    app.focus({ steal: true });
    window.focus();
    await wait(async () => keyboardActive, "keyboard port");
    await key("e");
    await wait(
      () => js('displayEditingSmoke.events().some(e=>e.kind === "key" && e.text === "e")'),
      "native typing",
    );
    assert.equal(
      await js('displayEditingSmoke.events().filter(e=>e.kind === "key" && e.text === "e").length'),
      1,
    );
    await key("a", true);
    await wait(
      () =>
        js(
          'displayEditingSmoke.events().some(e=>e.kind === "command" && e.command === "selectAll")',
        ),
      "native command",
    );
    records.push({
      name: "Phone native typing once and Cmd+A through real display proxy",
      passed: true,
    });
    await key("c", true);
    await wait(
      async () => (await clipboard.readText()) === "remote clipboard fixture",
      "viewer clipboard",
    );
    assert.equal(nativeWrites, 1);
    records.push({ name: "Phone Cmd+C through shipping preload and clipboard IPC", passed: true });
    await window.webContents.executeJavaScript("displayEditingSmoke.emptyCopy()");
    await key("c", true);
    await wait(
      () => js('displayEditingSmoke.events().filter(e=>e.kind === "copy").length === 2'),
      "empty copy",
    );
    assert.equal(nativeWrites, 1);
    assert.equal(await clipboard.readText(), "remote clipboard fixture");
    await clipboard.writeText("plain paste fixture\nsecond line 🦊");
    await key("v", true);
    await wait(
      () =>
        js(
          'displayEditingSmoke.events().some(e=>e.kind === "paste" && e.text === "plain paste fixture\\nsecond line 🦊")',
        ),
      "plain paste",
    );
    await clipboard.write([
      new ClipboardItem({ "text/plain": "rich fixture", "text/html": "<b>rich fixture</b>" }),
    ]);
    await key("v", true);
    await wait(
      () =>
        js(
          'displayEditingSmoke.events().some(e=>e.kind === "paste" && e.items?.some(i=>i.type === "text/html"))',
        ),
      "rich paste metadata",
    );
    await wait(
      () =>
        js(
          'document.querySelector(".phone-display__control").textContent.includes("support this edit")',
        ),
      "visible refusal",
    );
    records.push({ name: "Native rich paste is metadata with a visible refusal", passed: true });
    await js("displayEditingSmoke.mac(true)");
    await js('document.querySelector("textarea.remote-keyboard-input").focus()');
    await key("z", true);
    await wait(
      () =>
        js('displayEditingSmoke.events().some(e=>e.kind === "command" && e.command === "undo")'),
      "Mac command",
    );
    window.webContents.sendInputEvent({ type: "mouseMove", x: 380, y: 330 });
    window.webContents.sendInputEvent({
      type: "mouseDown",
      x: 380,
      y: 330,
      button: "right",
      clickCount: 2,
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      x: 380,
      y: 330,
      button: "right",
      clickCount: 2,
    });
    await wait(
      () =>
        js(
          'displayEditingSmoke.events().some(e=>e.kind === "mouse" && e.phase === "down" && e.button === "right" && e.clickCount === 2)',
        ),
      "native mouse click count",
    );
    records.push({ name: "Mac display mode Cmd+Z and native right double-click", passed: true });
    await writeFile(
      path.join(output, "viewer.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await writeFile(
      path.join(output, "wire.json"),
      JSON.stringify(await js("displayEditingSmoke.events()"), null, 2),
    );
    const resetsBefore = await js("displayEditingSmoke.resets()");
    await js(
      'document.querySelector("textarea.remote-keyboard-input").dispatchEvent(new KeyboardEvent("keydown", {key: "F6", bubbles: true}))',
    );
    await wait(() => js(`displayEditingSmoke.resets() > ${resetsBefore}`), "input reset");
    records.push({ name: "F6 resets remote input", passed: true });
    await js("displayEditingSmoke.close()");
  } catch (error) {
    records.push({ name: "suite", passed: false, error: String(error) });
    if (window && !window.isDestroyed())
      await writeFile(
        path.join(output, "failure.png"),
        (await window.webContents.capturePage()).toPNG(),
      );
  } finally {
    clearTimeout(timeout);
    for (const [channel] of handlers) ipcMain.removeHandler(channel);
    const passed = records.length === 5 && records.every((record) => record.passed);
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify({ passed, records, nativeWrites, keyboardActive }, null, 2),
    );
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(passed ? 0 : 1);
  }
});
