import { existsSync as guestMarkerExists } from "node:fs";
import {
  browserViewerEditingVersion,
  browserViewerMessage,
} from "../../host/src/browser/browser-viewer-protocol.js";
/** VM-only baseline Personal browser: real renderer, runtime, Electron engine and native clipboard. */
import {
  BrowserRuntime,
  encodeBrowserFrame,
  type BrowserAttachment,
  type LaunchedBrowser,
} from "@opensteer/browser-runtime-core";
import { FakeTicketVerifier, validClaims } from "@opensteer/browser-runtime-core/test-support";
import { MockHostClient } from "@opensteer/client/mock";
import {
  BrowserClientMessageSchema,
  BrowserSessionIdSchema,
  hostApi,
  hostApiVersionHeader,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import {
  DesktopHostWebSocketEventSchema,
  DesktopOpenHostWebSocketResultSchema,
  DisplayClientDiagnosticSchema,
  type DesktopCloseHostWebSocketInput,
  type DesktopHostHttpRequest,
  type DesktopHostWebSocketCommand,
  type DesktopHostWebSocketEvent,
  type DesktopOpenHostWebSocketInput,
} from "@opensteer/protocol/desktop";
import { app, BrowserWindow, clipboard, ipcMain, Menu, protocol } from "electron";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { registerDesktopAppScheme } from "../src/app/app-protocol.js";
import { assertAuthorizedRenderer, type DesktopBridgeContext } from "../src/bridge/context.js";
import { desktopBridgeChannels } from "../src/bridge/desktop-bridge-channels.js";
import {
  handleCloseHostWebSocket,
  handleHostRequest,
  handleOpenHostWebSocket,
  handleSendHostWebSocket,
} from "../src/bridge/methods/host.js";
import { viewerClipboardHandlers } from "../src/bridge/methods/viewer-clipboard.js";
import { ElectronBrowserLauncher } from "../src/browser/electron-browser-launcher.js";

if (
  !guestMarkerExists(path.join(process.env.HOME!, ".opensteer-test-guest")) &&
  !process.cwd().endsWith("/opensteer-job/src/apps/desktop")
)
  throw new Error("Run through pnpm test:vm.");
const rawBaseline = process.argv.includes("--raw-baseline");
const pcViewer = process.argv.includes("--pc-viewer");
const editingV2 = process.argv.includes("--editing-v2") || pcViewer;
const expectedRecords = pcViewer ? 2 : editingV2 ? 11 : 6;
const output = path.join(
  process.env.OPENSTEER_JOURNEY_OUT ?? path.join(process.env.HOME!, "opensteer-job/artifacts"),
  `${rawBaseline ? "baseline-raw-viewer" : pcViewer ? "editing-v2-pc-viewer" : editingV2 ? "editing-v2-viewer" : "baseline-viewer"}`,
);
let viewerVersion: 1 | 2 | undefined;
let requestedVersion: 1 | 2 | undefined;
const consumerToken = randomUUID();
function project(message: BrowserServerMessage): BrowserServerMessage | undefined {
  if (
    !viewerVersion &&
    [
      "browser.editing",
      "browser.contextmenu",
      "clipboard.result",
      "clipboard.part",
      "clipboard.written",
    ].includes(message.type)
  )
    return;
  return browserViewerMessage(message, viewerVersion);
}
const bundle = process.env.OPENSTEER_VIEWER_SMOKE_BUNDLE;
if (!bundle) throw new Error("Missing viewer fixture bundle.");
registerDesktopAppScheme(protocol);
const run = promisify(execFile);
const scratch = mkdtempSync(path.join(tmpdir(), "opensteer-baseline-viewer-"));
app.setPath("userData", path.join(scratch, "user-data"));
const records: string[] = [];
const runtimeMessages: BrowserServerMessage[] = [];
const rendererErrors: string[] = [];
let failure: string | undefined;
let window: BrowserWindow | undefined;
let browser: LaunchedBrowser | undefined;
let runtime: BrowserRuntime | undefined;
let attachment: BrowserAttachment | undefined;
let nativeWrites = 0;
let inspectTarget: (() => Promise<unknown>) | undefined;
let peer: WebSocket | undefined;
let snapshot: Extract<BrowserServerMessage, { type: "browser.snapshot" }> | undefined;
const mock = new MockHostClient({ latencyMs: 0 });
const launcher = new ElectronBrowserLauncher({
  downloads: {
    accept: () => undefined,
  },
  pagePolicyPreloadPath: path.resolve("dist/browser-page-preload.cjs"),
});
const token = "baseline-viewer-smoke-capability-0000000000000000";
let fixtureOrigin = "";
const hostSockets = new Map<string, { owner: number; socket: WebSocket }>();
const closeHostSockets = (owner: number) => {
  for (const [id, held] of hostSockets)
    if (held.owner === owner) {
      hostSockets.delete(id);
      held.socket.terminate();
    }
};
const bridge = {
  trackedHostSenders: new Set<number>(),
  options: {
    bridgeToken: token,
    hostTransport: {
      request: async (input: DesktopHostHttpRequest) => {
        const response = await fetch(new URL(input.path, fixtureOrigin), {
          method: input.method,
          ...(input.body === undefined ? {} : { body: input.body }),
          headers: {
            ...(input.headers.accept ? { accept: input.headers.accept } : {}),
            ...(input.headers.contentType ? { "content-type": input.headers.contentType } : {}),
            ...(input.headers.apiVersion
              ? { [hostApiVersionHeader]: input.headers.apiVersion }
              : {}),
          },
        });
        return {
          status: response.status,
          headers: { contentType: response.headers.get("content-type") },
          body: await response.text(),
        };
      },
      openWebSocket: async (
        owner: number,
        input: DesktopOpenHostWebSocketInput,
        publish: (event: DesktopHostWebSocketEvent) => void,
      ) => {
        const opened = DesktopOpenHostWebSocketResultSchema.parse({
          connectionId: `desktop_host_socket_${randomUUID()}`,
        });
        const { connectionId } = opened;
        const publishEvent = (event: DesktopHostWebSocketEvent) =>
          publish(DesktopHostWebSocketEventSchema.parse(event));
        const url = new URL(input.path, fixtureOrigin);
        url.protocol = "ws:";
        const socket = new WebSocket(url);
        hostSockets.set(connectionId, { owner, socket });
        socket.on("open", () => publishEvent({ connectionId, type: "open" }));
        socket.on("message", (raw, binary) => {
          const data = Buffer.isBuffer(raw)
            ? raw
            : Array.isArray(raw)
              ? Buffer.concat(raw)
              : Buffer.from(raw);
          publishEvent(
            binary
              ? { connectionId, type: "binary", data: new Uint8Array(data) }
              : { connectionId, type: "text", data: data.toString() },
          );
        });
        socket.on("error", (error) =>
          publishEvent({ connectionId, type: "error", message: error.message }),
        );
        socket.on("close", (code, reason) => {
          hostSockets.delete(connectionId);
          publishEvent({ connectionId, type: "close", code, reason: reason.toString() });
        });
        return opened;
      },
      sendWebSocket: (owner: number, input: DesktopHostWebSocketCommand) => {
        const held = hostSockets.get(input.connectionId);
        assert(held && held.owner === owner);
        held.socket.send(input.data);
      },
      closeWebSocket: (owner: number, input: DesktopCloseHostWebSocketInput) => {
        const held = hostSockets.get(input.connectionId);
        if (held?.owner === owner) held.socket.close(input.code, input.reason);
      },
      closeSocketsForOwner: closeHostSockets,
      closeBinaryForOwner: async () => {},
    },
  },
} as unknown as DesktopBridgeContext;
const hostHandlers = [
  [desktopBridgeChannels.hostRequest, handleHostRequest(bridge)],
  [desktopBridgeChannels.openHostWebSocket, handleOpenHostWebSocket(bridge)],
  [desktopBridgeChannels.sendHostWebSocket, handleSendHostWebSocket(bridge)],
  [desktopBridgeChannels.closeHostWebSocket, handleCloseHostWebSocket(bridge)],
] as const;
const wss = new WebSocketServer({ noServer: true });
const server = createServer((request, response) => {
  void (async () => {
    response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "app://opensteer");
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      request.headers["access-control-request-headers"] ?? "content-type",
    );
    if (request.method === "OPTIONS") {
      response.end();
      return;
    }
    const url = new URL(request.url!, "http://fixture");
    if (url.pathname.startsWith("/v1/rpc/")) {
      const name = url.pathname.slice("/v1/rpc/".length) as keyof typeof hostApi;
      if (!(name in hostApi)) throw new Error(`Unexpected RPC ${name}`);
      let raw = url.searchParams.get("input") ?? "";
      if (request.method !== "GET") {
        for await (const chunk of request) raw += String(chunk);
      }
      const rpc = mock.rpc[name] as (input: never) => Promise<unknown>;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(await rpc(JSON.parse(raw || "{}") as never)));
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<textarea id="editing-fixture" style="width:500px;height:200px"></textarea><script>window.keydowns=0;const t=document.querySelector("textarea");t.addEventListener("keydown",e=>{if(e.key.length===1&&!e.metaKey&&!e.ctrlKey){e.preventDefault();window.keydowns++;document.execCommand("insertText",false,e.key)}});window.nativeEvents=[];for(const type of ["keydown","beforeinput","input","copy","cut"])t.addEventListener(type,e=>nativeEvents.push({type,key:e.key,meta:e.metaKey,control:e.ctrlKey,inputType:e.inputType,value:t.value}));t.focus()</script>',
    );
  })().catch((error) => {
    response.statusCode = 500;
    response.end(String(error));
  });
});
server.on("upgrade", (request, socket, head) => {
  if (!request.url?.includes("/browser-sessions/")) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    peer = ws;
    assert(snapshot);
    requestedVersion =
      new URL(request.url!, "http://fixture").searchParams.get("editing") === "2" ? 2 : 1;
    viewerVersion = browserViewerEditingVersion(snapshot, requestedVersion);
    for (const message of runtimeMessages) {
      const projected = project(message);
      if (projected) ws.send(JSON.stringify(projected));
    }
    ws.on("message", (data) => {
      const message = BrowserClientMessageSchema.parse(JSON.parse(data.toString()));
      const input = [
        "input.key",
        "input.pointer",
        "input.command",
        "clipboard.copy",
        "clipboard.cut",
        "clipboard.paste-data",
      ].includes(message.type)
        ? { ...message, consumerToken, producerId: consumerToken }
        : { ...message, producerId: consumerToken };
      void attachment!.handle(JSON.stringify(input)).catch((error) => {
        failure = String(error);
      });
    });
  });
});
async function wait(predicate: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function main() {
  await mkdir(output, { recursive: true });
  const timeout = setTimeout(() => {
    failure = "Baseline viewer exceeded 120 seconds";
    void writeFile(path.join(output, "timeout.json"), JSON.stringify({ failure, records })).finally(
      () => app.exit(1),
    );
  }, 120000);
  try {
    await app.whenReady();
    await mock.load();
    const session = mock.getSnapshot().browserSessions[0];
    assert(session);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    fixtureOrigin = origin;
    const claims = validClaims({
      sessionId: BrowserSessionIdSchema.parse(session.id),
      identity: { kind: "fresh" },
      ...(!rawBaseline ? { editingVersion: 2, clipboard: false } : {}),
      viewport: { width: 900, height: 600 },
    });
    const verifier = new FakeTicketVerifier();
    verifier.setClaims("baseline", claims);
    runtime = new BrowserRuntime({
      runtimeId: claims.runtimeId,
      launcher: {
        launch: async (request) => {
          browser = await launcher.launch(request);
          return browser;
        },
      },
      ticketVerifier: verifier,
      sessionFilesRoot: path.join(scratch, "files"),
    });
    attachment = await runtime.attach("baseline", {
      sendServer: async (message) => {
        runtimeMessages.push(message);
        if (message.type === "browser.snapshot") snapshot = message;
        if (peer?.readyState === WebSocket.OPEN) {
          const projected = project(message);
          if (projected) peer.send(JSON.stringify(projected));
        }
      },
      sendFrame: async (frame) => {
        if (peer?.readyState === WebSocket.OPEN) peer.send(encodeBrowserFrame(frame));
      },
    });
    assert(snapshot);
    assert.equal(snapshot.editingVersion, rawBaseline ? undefined : 2);
    assert.equal(snapshot.clipboard, rawBaseline ? undefined : false);
    assert.equal(browser?.clipboard, undefined);
    const surfaceId = snapshot.surfaces[0]!.id;
    await attachment.handle(JSON.stringify({ type: "navigation.go", url: origin, surfaceId }));
    const page = browser!.context.pages()[0]!;
    const cdp = await page.cdp();
    const read = async <T>(expression: string): Promise<T> =>
      (
        await cdp.send<{ result: { value: T } }>("Runtime.evaluate", {
          expression,
          returnByValue: true,
        })
      ).result.value;
    inspectTarget = () =>
      read("({value:t.value,selection:[t.selectionStart,t.selectionEnd],events:nativeEvents})");
    await wait(
      () => read<boolean>("!!document.querySelector('#editing-fixture')"),
      "remote editor",
    );
    protocol.handle("app", async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/viewer.js" || url.pathname === "/viewer.css")
        return new Response(
          await readFile(path.join(path.dirname(bundle!), url.pathname.slice(1))),
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
    for (const [channel, handler] of viewerClipboardHandlers(bridge))
      ipcMain.handle(channel, async (event, envelope) => {
        const writing = channel === desktopBridgeChannels.writeViewerClipboard;
        if (writing) await clipboard.writeText("awaiting native viewer port");
        const result = await handler(event, envelope);
        if (writing) nativeWrites++;
        return result;
      });
    ipcMain.handle(desktopBridgeChannels.getLocalVisibility, (event, envelope) => {
      assertAuthorizedRenderer(bridge, event, envelope);
      return window?.isVisible() ?? false;
    });
    ipcMain.handle(desktopBridgeChannels.reportDisplayDiagnostic, (event, envelope) => {
      assertAuthorizedRenderer(bridge, event, envelope);
      DisplayClientDiagnosticSchema.parse(envelope.input);
    });
    for (const [channel, handler] of hostHandlers)
      ipcMain.handle(channel, (event, envelope) => handler(event, envelope));
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }]));
    window = new BrowserWindow({
      show: true,
      width: 1000,
      height: 760,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.resolve("dist/preload.cjs"),
        additionalArguments: [`--opensteer-desktop-bridge-token=${token}`],
      },
    });
    const view = window;
    view.webContents.on("console-message", (_event, _level, message) => {
      rendererErrors.push(message);
    });
    await view.loadURL(
      `app://opensteer/?mode=host&baseline=1&viewer=${editingV2 ? 2 : 1}&platform=${pcViewer ? "windows" : "mac"}&host=${encodeURIComponent(origin)}&session=${session.id}&surface=${surfaceId}`,
    );
    await wait(
      () =>
        view.webContents.executeJavaScript(
          "!!window.remoteEditingJourney?.ready() && !document.querySelector('textarea[aria-label=\"Browser keyboard input\"]')?.disabled",
        ),
      "baseline renderer proxy",
    );
    await view.webContents.executeJavaScript(
      "document.querySelector('textarea[aria-label=\"Browser keyboard input\"]').focus()",
    );
    app.focus({ steal: true });
    view.focus();
    const key = async (script: string) => {
      await run("osascript", ["-e", `tell application "System Events" to ${script}`], {
        timeout: 10000,
      });
    };
    const openMenu = async () => {
      const point = await read<{ x: number; y: number; width: number; height: number }>(
        '(()=>{const r=document.querySelector("textarea").getBoundingClientRect();return {x:r.x+5,y:r.y+5,width:innerWidth,height:innerHeight}})()',
      );
      const canvas = await view.webContents.executeJavaScript(
        '(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()',
      );
      const x = Math.round(canvas.x + (point.x / point.width) * canvas.width),
        y = Math.round(canvas.y + (point.y / point.height) * canvas.height);
      view.webContents.sendInputEvent({
        type: "mouseDown",
        x,
        y,
        button: "right",
        clickCount: 1,
      });
      view.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "right", clickCount: 1 });
    };
    const action = async (label: string) => {
      await openMenu();
      await wait(
        () =>
          view.webContents.executeJavaScript(
            "!!remoteEditingJourney.editingState().menu?.editable",
          ),
        "context menu editable facts",
      );
      await view.webContents.executeJavaScript(
        `(()=>{const button=[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent===${JSON.stringify(label)});if(!button||button.disabled)throw new Error('Unavailable menu action');button.click()})()`,
      );
    };
    if (pcViewer) {
      assert.equal(
        await view.webContents.executeJavaScript("remoteEditingJourney.platform"),
        "windows",
      );
      const state = await view.webContents.executeJavaScript("remoteEditingJourney.editingState()");
      assert.equal(state.negotiated, true);
      assert.equal(state.abilities.clipboard, "text");
      await read(`window.cutEvents=0;window.cutDeletes=0;window.cutKeys=[];
        t.addEventListener('cut',()=>cutEvents++);
        t.addEventListener('input',e=>{if(e.inputType==='deleteByCut')cutDeletes++});
        t.addEventListener('keydown',e=>{if(e.key==='x')cutKeys.push({meta:e.metaKey,control:e.ctrlKey})});
        t.value='left-middle-right';t.setSelectionRange(5,11)`);
      await key('keystroke "x" using {control down}');
      await wait(
        async () => nativeWrites === 1 && (await read("t.value")) === "left--right",
        "PC keyboard Cut",
      );
      assert.equal(await clipboard.readText(), "middle");
      assert.equal(await read("cutEvents"), 1);
      assert.equal(await read("cutDeletes"), 1);
      records.push("PC Ctrl+X resolves to native Mac Cut and deletes exactly once");
      await read("t.value='second-cut';t.select()");
      await action("Cut");
      await wait(async () => nativeWrites === 2 && (await read("t.value")) === "", "PC menu Cut");
      assert.equal(await clipboard.readText(), "second-cut");
      assert.equal(await read("cutEvents"), 2);
      assert.equal(await read("cutDeletes"), 2);
      assert.deepEqual(await read("cutKeys"), [
        { meta: true, control: false },
        { meta: true, control: false },
      ]);
      const wire = await view.webContents.executeJavaScript("remoteEditingJourney.commands()");
      const cutKeys = wire.filter(
        (command: { type: string; key?: string }) =>
          command.type === "input.key" && command.key === "x",
      );
      assert.equal(cutKeys.length, 4);
      for (const command of cutKeys) assert.deepEqual(command.modifiers, ["primary"]);
      await writeFile(
        path.join(output, "pc-cut.json"),
        JSON.stringify(
          {
            cutEvents: await read("cutEvents"),
            deletions: await read("cutDeletes"),
            keyModifiers: await read("cutKeys"),
            nativeWrites,
            wire: cutKeys,
          },
          null,
          2,
        ),
      );
      records.push("PC context-menu Cut resolves to native Mac Cut and deletes exactly once");
    } else {
      await key('keystroke "abc"');
      await wait(
        () => read<boolean>('document.querySelector("textarea").value==="abc"'),
        "one producer typing",
      );
      assert.equal(await read("window.keydowns"), 3);
      records.push("keydown-owned editor: abc exactly once per character");
      await key('keystroke "a" using {command down}');
      await wait(
        () =>
          read<boolean>(
            'document.querySelector("textarea").selectionEnd-document.querySelector("textarea").selectionStart===3',
          ),
        "Cmd+A native selection",
      );
      records.push("Cmd+A selects all through the negotiated viewer path");
      await key('keystroke "c" using {command down}');
      await wait(
        async () => nativeWrites === 1 && (await clipboard.readText()) === "abc",
        "copy native viewer port",
      );
      records.push("Cmd+C streamed selection reaches real preload and native clipboard port once");
      await key('keystroke "z" using {command down}');
      await wait(
        () => read<boolean>('document.querySelector("textarea").value===""'),
        "Cmd+Z undo",
      );
      records.push("Cmd+Z applies native undo");
      await key('keystroke "abc"');
      await wait(
        () => read<boolean>('document.querySelector("textarea").value==="abc"'),
        "type after undo",
      );
      await key("key code 123 using {command down}");
      await wait(
        () =>
          read<boolean>(
            'document.querySelector("textarea").selectionStart===0&&document.querySelector("textarea").selectionEnd===0',
          ),
        "Cmd+Left",
      );
      records.push("Cmd+Left moves to beginning");
      await key("key code 124 using {command down}");
      await wait(
        () => read<boolean>('document.querySelector("textarea").selectionStart===3'),
        "Cmd+Right",
      );
      await key("key code 51 using {command down}");
      await wait(
        () => read<boolean>('document.querySelector("textarea").value===""'),
        "Cmd+Backspace",
      );
      records.push("Cmd+Backspace deletes to beginning");
      assert.equal(requestedVersion, editingV2 ? 2 : 1);
      assert.equal(viewerVersion, editingV2 ? 2 : undefined);
      const projectedState = await view.webContents.executeJavaScript(
        "remoteEditingJourney.editingState()",
      );
      assert.equal(projectedState.negotiated, editingV2);
      assert.equal(projectedState.abilities.rangeEdits, editingV2);
      assert.equal(projectedState.abilities.clipboard, "text");
      if (editingV2) {
        const state = await view.webContents.executeJavaScript(
          "remoteEditingJourney.editingState()",
        );
        assert.equal(state.negotiated, true);
        assert.deepEqual(state.abilities, {
          composition: true,
          rangeEdits: true,
          commands: true,
          clipboard: "text",
        });
        assert(
          state.context?.caret &&
            state.context.caret.height > 0 &&
            state.context.caret.x >= 0 &&
            state.context.caret.x <= 1,
        );
        view.webContents.debugger.attach("1.3");
        await view.webContents.debugger.sendCommand("Input.imeSetComposition", {
          text: "한",
          selectionStart: 1,
          selectionEnd: 1,
        });
        await wait(
          () => read<boolean>('document.querySelector("textarea").value==="한"'),
          "live remote preedit",
        );
        await view.webContents.debugger.sendCommand("Input.insertText", { text: "한국" });
        await wait(
          () => read<boolean>('document.querySelector("textarea").value==="한국"'),
          "live composition commit",
        );
        view.webContents.debugger.detach();
        records.push(
          "desktop renderer v2: native viewer composition reaches live engine preedit and one commit",
        );
        await key('keystroke "a" using {command down}');
        await key("key code 51");
        await wait(
          () => read<boolean>('document.querySelector("textarea").value===""'),
          "clear composition",
        );
        const nativeKeys = process.env.OPENSTEER_NATIVE_KEYS;
        assert(nativeKeys, "The v2 journey requires the native key helper");
        const inputSource = await run(nativeKeys, ["source", "com.apple.keylayout.US"], {
          timeout: 10000,
        });
        const accentKeys = await run(nativeKeys, ["keys", String(process.pid), "14:hold", "19"], {
          timeout: 10000,
        });
        await writeFile(
          path.join(output, "accent-native-input.json"),
          JSON.stringify({ source: inputSource.stdout, input: accentKeys.stdout }, null, 2),
        );
        await wait(
          () => read<boolean>('document.querySelector("textarea").value==="é"'),
          "native accent-picker verified replacement",
        );
        const accentWire = await view.webContents.executeJavaScript(
          "remoteEditingJourney.commands()",
        );
        assert.equal(
          accentWire.filter(
            (command: { type: string; text?: string }) =>
              command.type === "input.key" && command.text === "e",
          ).length,
          1,
        );
        assert(
          accentWire.some(
            (command: { type: string; edit?: { text: string; before: string; after: string } }) =>
              command.type === "input.text" &&
              command.edit?.text === "é" &&
              command.edit.before === "e" &&
              command.edit.after === "",
          ),
        );
        records.push(
          "desktop renderer v2: native accent picker emits e once and verified e→é replacement",
        );
        const before = await view.webContents.executeJavaScript(
          "remoteEditingJourney.editingState().context.contextId",
        );
        await view.webContents.executeJavaScript(
          `remoteEditingJourney.edit({contextId:${JSON.stringify(before)},before:'wrong',after:'',text:'bad'})`,
        );
        await wait(
          async () =>
            (await view.webContents.executeJavaScript(
              "remoteEditingJourney.editingState().context.contextId",
            )) !== before,
          "stale context rotation",
        );
        assert.equal(await read('document.querySelector("textarea").value'), "é");
        records.push(
          "desktop renderer v2: stale verified replacement refuses without mutation and rotates context",
        );
        await key('keystroke "a" using {command down}');
        await wait(
          () =>
            read<boolean>(
              'document.querySelector("textarea").selectionEnd-document.querySelector("textarea").selectionStart===1',
            ),
          "menu selection",
        );
        await action("Copy");
        await wait(
          async () => nativeWrites === 2 && (await clipboard.readText()) === "é",
          "menu baseline copy",
        );
        await action("Cut");
        await wait(
          () => read<boolean>('document.querySelector("textarea").value===""'),
          "menu baseline cut",
        );
        await wait(
          async () => nativeWrites === 3 && (await clipboard.readText()) === "é",
          "menu cut result",
        );
        await clipboard.writeText("menu-paste");
        await action("Paste");
        await wait(
          () => read<boolean>('document.querySelector("textarea").value==="menu-paste"'),
          "menu baseline paste insertion",
        );
        await cdp.send("Runtime.evaluate", {
          expression:
            'window.canceledMenus=0;document.querySelector("textarea").oncontextmenu=e=>{e.preventDefault();canceledMenus++}',
        });
        await openMenu();
        await wait(() => read<boolean>("canceledMenus===1"), "page context menu cancellation");
        await cdp.send("Runtime.evaluate", {
          expression: "new Promise(resolve=>setTimeout(resolve,0))",
          awaitPromise: true,
        });
        assert.equal(
          await view.webContents.executeJavaScript("remoteEditingJourney.editingState().menu"),
          null,
        );
        records.push(
          "desktop renderer v2: context menu facts, baseline Cut/Copy/Paste, and page cancellation",
        );
        const wire = await view.webContents.executeJavaScript("remoteEditingJourney.commands()");
        assert(wire.some((command: { type: string }) => command.type === "input.compose"));
        assert(wire.some((command: { type: string }) => command.type === "input.text"));
        assert(wire.some((command: { type: string }) => command.type === "input.command"));
        assert(
          !wire.some((command: { type: string }) =>
            ["clipboard.copy", "clipboard.cut", "clipboard.paste-data", "clipboard.part"].includes(
              command.type,
            ),
          ),
        );
        records.push(
          "desktop renderer v2: editing operations coexist with exclusively baseline clipboard transport",
        );
      }
    }
    await writeFile(
      path.join(output, "viewer.png"),
      (await view.webContents.capturePage()).toPNG(),
    );
    await writeFile(
      path.join(output, "wire.json"),
      JSON.stringify(
        await view.webContents.executeJavaScript("remoteEditingJourney.commands()"),
        null,
        2,
      ),
    );
    await view.webContents.executeJavaScript("remoteEditingJourney.close()");
  } catch (error) {
    failure = String(error);
    console.error(error);
    if (inspectTarget)
      await inspectTarget()
        .then((target) =>
          writeFile(path.join(output, "target.json"), JSON.stringify(target, null, 2)),
        )
        .catch(() => undefined);
    if (window && !window.isDestroyed()) {
      const view = window;
      await Promise.allSettled([
        view.webContents
          .executeJavaScript("remoteEditingJourney.commands()")
          .then((wire) => writeFile(path.join(output, "wire.json"), JSON.stringify(wire, null, 2))),
        view.webContents
          .capturePage()
          .then((shot) => writeFile(path.join(output, "failure.png"), shot.toPNG())),
        view.webContents
          .executeJavaScript(
            "({url:location.href,visibility:document.visibilityState,ready:!!window.remoteEditingJourney?.ready(),text:document.body.innerText,inputs:[...document.querySelectorAll('textarea')].map(({disabled,value})=>({disabled,value}))})",
          )
          .then((state: unknown) =>
            writeFile(path.join(output, "renderer.json"), JSON.stringify(state, null, 2)),
          ),
      ]);
    }
  } finally {
    for (const [channel] of viewerClipboardHandlers(bridge)) ipcMain.removeHandler(channel);
    for (const [channel] of hostHandlers) ipcMain.removeHandler(channel);
    ipcMain.removeHandler(desktopBridgeChannels.getLocalVisibility);
    ipcMain.removeHandler(desktopBridgeChannels.reportDisplayDiagnostic);
    for (const ws of wss.clients) ws.terminate();
    for (const held of hostSockets.values()) held.socket.terminate();
    await attachment?.close();
    await runtime?.shutdown();
    launcher.close();
    mock.dispose();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await writeFile(
      path.join(output, "runtime-wire.json"),
      JSON.stringify(runtimeMessages, null, 2),
    );
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify(
        {
          passed: !failure && records.length === expectedRecords,
          failure,
          records,
          nativeWrites,
          rendererErrors,
          editingVersion: snapshot?.editingVersion ?? null,
          clipboard: snapshot?.clipboard,
          requestedVersion,
          viewerVersion,
          fixture:
            "real HttpHostClient + BrowserViewport + Electron engine/runtime; RPC inventory fixture",
          cleanup: true,
        },
        null,
        2,
      ),
    );
    clearTimeout(timeout);
    const exitCode = failure || records.length !== expectedRecords ? 1 : 0;
    process.exitCode = exitCode;
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(exitCode);
  }
}
void main();
