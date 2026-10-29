import { createRoot } from "react-dom/client";
import {
  BrowserEditingStore,
  type BrowserCommand,
  type BrowserFrameStore,
  type HostClient,
  type WebSocketClient,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { createBrowserHostClient } from "../../src/host/browser-host-client.js";
import { verifyAccessEndpoint } from "@opensteer/client/connections";
import {
  BrowserClientMessageSchema,
  BrowserServerMessageSchema,
  BrowserSurfaceIdSchema,
} from "@opensteer/protocol";
import { editingClipboardPartCount } from "@opensteer/protocol/editing";
import { BrowserViewport } from "../../src/components/browser/browser-viewport.js";
import { viewerEditingPlatform } from "../../src/components/remote-editing/remote-editing-proxy.js";
import { desktopBridge } from "../../src/desktop/desktop-bridge.js";
import {
  createDesktopHostFetch,
  createDesktopHostWebSocketFactory,
} from "../../src/desktop/desktop-host-transport.js";

export interface RemoteEditingJourneyApi {
  readonly mode: "mock" | "host";
  readonly platform: string;
  commands(): readonly BrowserCommand[];
  editingState(): ReturnType<ReturnType<BrowserEditingStore["target"]>["get"]>;
  edit(input: import("@opensteer/protocol/editing").EditingTextEdit): Promise<unknown>;
  openedLinks(): readonly string[];
  reset(): Promise<void>;
  value(): Promise<string | null>;
  sensitive(value: boolean): Promise<void>;
  customMenu(value: boolean): Promise<void>;
  pageWriteOnClick(): Promise<void>;
  emptyCopy(): void;
  clipboardOutcomes(): Readonly<Record<string, number>>;
  binaryPaste(size: number): Promise<unknown>;
  ready(): boolean;
  close(): void;
}
const query = new URLSearchParams(location.search);
if (query.get("platform") === "windows")
  Object.defineProperty(navigator, "platform", { value: "Win32" });
const mode = query.get("mode") === "host" ? "host" : "mock";
const commands: BrowserCommand[] = [];
const openedLinks: string[] = [];
let socket: WebSocketClient | null = null;
const requests = new Map<
  string,
  {
    resolve: (value: Record<string, unknown>) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let client: HostClient;
if (mode === "host") {
  const baseUrl = query.get("host") ?? location.origin;
  const bridge = query.has("baseline") ? desktopBridge() : null;
  const openSocket: (url: string) => WebSocketClient = bridge
    ? createDesktopHostWebSocketFactory(bridge, baseUrl)
    : (url: string) => new WebSocket(url);
  const host = createBrowserHostClient({
    baseUrl,
    ...(bridge ? { fetch: createDesktopHostFetch(bridge, baseUrl) } : {}),
    capabilities: query.has("baseline")
      ? []
      : async () =>
          (await verifyAccessEndpoint({ kind: "direct", origin: location.origin })).capabilities,
    webSocketFactory: (url) => {
      const requested = query.get("viewer");
      if (requested) {
        const parsed = new URL(url);
        parsed.searchParams.set("editing", requested);
        url = parsed.toString();
      }
      const ws = openSocket(url);
      if (new URL(url).pathname.includes("/browser-sessions/")) {
        socket = ws;
        const send = ws.send.bind(ws);
        ws.send = (data) => {
          if (typeof data === "string") {
            const parsed = BrowserClientMessageSchema.safeParse(JSON.parse(data));
            if (parsed.success) {
              const command = parsed.data;
              commands.push(
                command.type === "input.pointer" || command.type === "input.wheel"
                  ? { ...command, modifiers: command.modifiers ?? [] }
                  : command,
              );
            }
          }
          send(data);
        };
        ws.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const message = BrowserServerMessageSchema.parse(JSON.parse(event.data));
          if (message.type !== "cdp.result" && message.type !== "cdp.error") return;
          const pending = requests.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          requests.delete(message.requestId);
          if (message.type === "cdp.result") pending.resolve(message.result);
          else pending.reject(new Error(message.error.message));
        });
      }
      return ws;
    },
  });
  await host.load();
  client = host;
} else client = new MockHostClient({ latencyMs: 0 });
const session = client
  .getSnapshot()
  .browserSessions.find(
    (session) =>
      session.id === (query.get("session") ?? client.getSnapshot().browserSessions[0]?.id),
  );
if (!session)
  throw new Error("Provide a ready, disposable browser session for the viewer journey.");
const surfaceId = BrowserSurfaceIdSchema.parse(
  query.get("surface") ?? session.tabs.find((tab) => tab.active)?.id,
);
let customMenu = false,
  pageWrite = false;
let emptyCopy = false;
const encoder = new TextEncoder();
const stages = new Map<string, { count: number; parts: number }>();
const clipboardResult = (operationId: string, outcome: "copied" | "cut", text: string) => {
  const bytes = encoder.encode(text);
  editing.receive(session.id, {
    type: "clipboard.result",
    surfaceId,
    operationId,
    outcome,
    items: [{ type: "text/plain", size: bytes.length }],
  });
  editing.receive(session.id, {
    type: "clipboard.part",
    part: { operationId, index: 0, data: btoa(text) },
  });
};
const editing =
  mode === "mock"
    ? new BrowserEditingStore(
        (_session, _surface, command) => {
          commands.push(command);
          if (command.type === "clipboard.copy" || command.type === "clipboard.cut")
            queueMicrotask(() => {
              if (emptyCopy) {
                emptyCopy = false;
                editing.receive(session.id, {
                  type: "clipboard.result",
                  surfaceId,
                  operationId: command.operationId,
                  outcome: "empty",
                });
              } else
                clipboardResult(
                  command.operationId,
                  command.type === "clipboard.copy" ? "copied" : "cut",
                  "remote clipboard fixture",
                );
            });
          else if (command.type === "clipboard.paste-data")
            stages.set(command.operationId, {
              count: 0,
              parts: editingClipboardPartCount(command.items),
            });
          else if (command.type === "clipboard.part") {
            const stage = stages.get(command.part.operationId);
            if (stage && ++stage.count === stage.parts) {
              stages.delete(command.part.operationId);
              queueMicrotask(() =>
                editing.receive(session.id, {
                  type: "clipboard.result",
                  surfaceId,
                  operationId: command.part.operationId,
                  outcome: "pasted",
                }),
              );
            }
          }
        },
        () => "pc",
      )
    : client.browserFrames.editing!;
if (!editing) throw new Error("The real Host client has no editing transport.");
if (mode === "mock") editing.negotiate(session.id, 1);
const frames: BrowserFrameStore =
  mode === "mock" ? { ...client.browserFrames, editing } : client.browserFrames;
const target = editing.target(session.id, surfaceId);
const field = (sensitive = false) =>
  editing.receive(session.id, {
    type: "browser.editing",
    surfaceId,
    context: {
      contextId: crypto.randomUUID(),
      field: {
        kind: "text",
        multiline: !sensitive,
        sensitive,
        inputMode: "text",
        enterKeyHint: "enter",
      },
      caret: { x: 0.2, y: 0.2, height: 0.03 },
    },
  });
if (mode === "mock") field();
const targeted = mode === "mock" || (await client.browserTargetControlAvailable?.()) === true;
const release = client.retainBrowserViewer(session.id, targeted ? surfaceId : undefined);
const root = createRoot(document.getElementById("root")!);
const render = () =>
  root.render(
    <BrowserViewport
      activeSurfaceId={surfaceId}
      canInput
      frames={frames}
      live={
        !query.has("baseline") ||
        client.getSnapshot().browserSessions.find((item) => item.id === session.id)?.viewerState ===
          "synchronized"
      }
      occluded={false}
      onOpenLink={(url) => {
        void client.openBrowserTab(session.id, { url }).then(() => openedLinks.push(url));
      }}
      onCommand={(command) => {
        if (mode === "mock") {
          commands.push(command);
          if (command.type === "input.pointer" && command.action === "up") {
            if (command.button === "right" && !customMenu)
              editing.receive(session.id, {
                type: "browser.contextmenu",
                surfaceId,
                x: command.x,
                y: command.y,
                editable: true,
                selection: true,
                linkUrl: "https://example.test/from-menu",
              });
            if (command.button === "left" && pageWrite) {
              pageWrite = false;
              const operationId = crypto.randomUUID();
              editing.receive(session.id, {
                type: "clipboard.written",
                surfaceId,
                operationId,
                items: [{ type: "text/plain", size: 12 }],
              });
              editing.receive(session.id, {
                type: "clipboard.part",
                part: { operationId, index: 0, data: btoa("page fixture") },
              });
            }
          }
        }
        client.sendBrowserCommand(session.id, command);
      }}
      sessionId={session.id}
      targeted={targeted}
      visible
    />,
  );
const releaseSnapshot = query.has("baseline") ? client.subscribe(render) : () => {};
render();
let cdpSession: string | null = null;
async function cdp(
  method: string,
  parameters: Record<string, unknown> = {},
  sessionId?: string,
): Promise<Record<string, unknown>> {
  if (!socket || socket.readyState !== 1) throw new Error("The Host browser socket is not ready.");
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(requestId);
      reject(new Error("The Host CDP observation timed out."));
    }, 10000);
    requests.set(requestId, { resolve, reject, timer });
    socket!.send(
      JSON.stringify({
        type: "cdp.command",
        requestId,
        command: { method, parameters, ...(sessionId ? { sessionId } : {}) },
      }),
    );
  });
}
async function evaluate(expression: string): Promise<unknown> {
  if (!cdpSession) {
    const targets = await cdp("Target.getTargets");
    const pages = Array.isArray(targets.targetInfos)
      ? targets.targetInfos.filter(
          (info): info is Record<string, unknown> =>
            typeof info === "object" && info !== null && Reflect.get(info, "type") === "page",
        )
      : [];
    if (pages.length !== 1)
      throw new Error("The real journey requires a disposable session with exactly one page.");
    const attached = await cdp("Target.attachToTarget", {
      targetId: pages[0]!.targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== "string") throw new Error("No CDP page session.");
    cdpSession = attached.sessionId;
  }
  const result = await cdp(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    cdpSession,
  );
  if (result.exceptionDetails) throw new Error("The remote fixture evaluation failed.");
  return typeof result.result === "object" && result.result !== null
    ? Reflect.get(result.result, "value")
    : undefined;
}
const api: RemoteEditingJourneyApi = {
  mode,
  platform: viewerEditingPlatform(),
  commands: () => commands,
  editingState: () => target.get(),
  edit: (edit) => target.send({ kind: "edit", edit }),
  openedLinks: () => openedLinks,
  ready: () =>
    !!frames.get(session.id, targeted ? surfaceId : undefined) &&
    (query.has("baseline") && query.get("viewer") !== "2"
      ? !target.get().negotiated
      : target.get().negotiated),
  async reset() {
    commands.length = 0;
    if (mode === "mock") field();
    else
      await evaluate(
        `document.body.innerHTML='<textarea id="editing-fixture" style="position:absolute;left:40px;top:40px;width:500px;height:200px"></textarea><a href="https://example.test/from-menu" style="position:absolute;left:40px;top:300px">fixture link</a>';document.querySelector('textarea').focus();document.oncontextmenu=null;`,
      );
  },
  async value() {
    return mode === "mock"
      ? null
      : String(await evaluate("document.querySelector('#editing-fixture').value"));
  },
  async sensitive(value) {
    if (mode === "mock") field(value);
    else
      await evaluate(
        `document.body.innerHTML='<input id="editing-fixture" type="${value ? "password" : "text"}" style="position:absolute;left:40px;top:40px;width:500px">';document.querySelector('input').focus();`,
      );
  },
  async customMenu(value) {
    customMenu = value;
    if (mode === "host")
      await evaluate(`document.oncontextmenu=${value ? "event=>event.preventDefault()" : "null"}`);
  },
  async pageWriteOnClick() {
    if (mode === "mock") pageWrite = true;
    else
      await evaluate(
        `const button=document.createElement('button');button.style='position:absolute;left:40px;top:300px;width:220px;height:50px';button.textContent='Copy fixture';button.onclick=()=>navigator.clipboard.writeText('page fixture');document.body.append(button);`,
      );
  },
  emptyCopy() {
    emptyCopy = true;
  },
  clipboardOutcomes: () => editing.diagnostics.clipboard,
  binaryPaste: (size) =>
    target.send({
      kind: "paste",
      items: [
        {
          type: "application/octet-stream",
          name: "viewer-fixture.bin",
          bytes: new Uint8Array(size).fill(71),
        },
      ],
    }),
  close() {
    releaseSnapshot();
    release();
    client.dispose();
    if (mode === "mock") editing.dispose();
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Journey closed."));
    }
    requests.clear();
    root.unmount();
  },
};
Reflect.set(window, "remoteEditingJourney", api);
