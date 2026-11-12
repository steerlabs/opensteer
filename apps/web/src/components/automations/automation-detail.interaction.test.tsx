// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { createId, ModelSelectionSchema } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import {
  HttpHostClient,
  unwrapRpcResult,
  type HostClient,
  type WebSocketClient,
} from "@opensteer/client/host";
import { AutomationDetailPage } from "./automation-detail.js";
import { AutomationEditorPage } from "./automation-editor.js";

const harness = vi.hoisted(() => ({ client: null as unknown as HostClient }));
vi.mock("../app-shell.js", () => ({
  useShell: () => ({
    hostClient: harness.client,
    snapshot: useSyncExternalStore(harness.client.subscribe, harness.client.getSnapshot),
    openMobileNavigation: () => {},
  }),
}));
vi.mock("../toast.js", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let client: MockHostClient;
let http: HttpHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  http?.dispose();
  http = undefined;
  client?.dispose();
  document.body.replaceChildren();
});
async function mount(memoryPasses?: "active" | "waiting-for-model", edit = false) {
  client = new MockHostClient({ latencyMs: 0, ...(memoryPasses ? { memoryPasses } : {}) });
  await client.load();
  harness.client = client;
  const triggers = unwrapRpcResult(await client.rpc["triggers.list"]({})).triggers;
  const trigger = memoryPasses
    ? triggers.find((t) => t.systemRole === "memory-light")!
    : triggers.find((t) => t.source.kind === "schedule" && t.source.schedule.kind === "cron")!;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[`/automations/${trigger.id}${edit ? "/edit" : ""}`]}>
        <Routes>
          <Route path="/automations/:triggerId" element={<AutomationDetailPage />} />
          <Route path="/automations/:triggerId/edit" element={<AutomationEditorPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(
    () =>
      expect(node.textContent).toContain(
        edit ? "Opensteer manages" : trigger.systemRole ? "Light memory pass" : trigger.name,
      ),
    { timeout: 2000 },
  );
  return { node, trigger };
}
function button(node: HTMLElement, name: string) {
  return [...node.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!;
}
it("inspects managed passes, links the worker, and retains Pause/Resume without destructive controls", async () => {
  const { node, trigger } = await mount("waiting-for-model");
  expect(node.textContent).toContain("Waiting for an AI account it can use");
  expect(node.textContent).toContain("findings reach you through Chat");
  expect(node.querySelector(`a[href="/tasks/${trigger.anchorThreadId}"]`)).not.toBeNull();
  for (const label of ["Delete", "Run now", "Edit code"])
    expect(node.textContent).not.toContain(label);
  await act(async () => button(node, "Pause").click());
  await vi.waitFor(() => expect(button(node, "Resume")).toBeDefined(), { timeout: 2000 });
  // Paused by the person, it no longer says it is waiting.
  expect(node.textContent).not.toContain("Waiting for an AI account it can use");
  await act(async () => button(node, "Resume").click());
  await vi.waitFor(() => expect(button(node, "Pause")).toBeDefined(), { timeout: 2000 });
});
it("refuses the direct managed editor route", async () => {
  const { node } = await mount("active", true);
  expect(node.querySelector("form")).toBeNull();
});
it("keeps ordinary automation controls", async () => {
  const { node } = await mount();
  for (const label of ["Delete", "Run now", "Edit code"]) expect(node.textContent).toContain(label);
});
it("reads current worker recovery state after other-device lifecycle changes", async () => {
  const { node, trigger } = await mount("active");
  await act(async () => {
    await client.setTaskDone(trigger.anchorThreadId, true);
  });
  await vi.waitFor(() => expect(button(node, "Reopen worker")).toBeDefined(), { timeout: 2000 });
  await act(async () => button(node, "Reopen worker").click());
  await vi.waitFor(() => expect(button(node, "Reopen worker")).toBeUndefined(), { timeout: 2000 });
  expect(button(node, "Resume")).toBeDefined();
});

it("offers Resume worker for a stopped managed worker", async () => {
  const { node, trigger } = await mount("active");
  const read = client.rpc["triggers.get"];
  let stopped = true;
  Object.defineProperty(client, "rpc", {
    value: new Proxy(client.rpc, {
      get(target, key) {
        if (key !== "triggers.get") return Reflect.get(target, key);
        return async (input: { triggerId: string }) => {
          const detail = unwrapRpcResult(await read(input));
          return {
            ok: true,
            data: {
              ...detail,
              anchorThread: detail.anchorThread
                ? { ...detail.anchorThread, inputQueuePaused: stopped }
                : null,
            },
          };
        };
      },
    }),
  });
  const resume = vi.spyOn(client, "resumeThreadInputQueue").mockImplementation(async () => {
    stopped = false;
  });
  await act(async () =>
    client.dispatch({
      type: "trigger.status.set",
      triggerId: trigger.id,
      status: "paused",
      idempotencyKey: "cross-device-stop",
    }),
  );
  await vi.waitFor(() => expect(button(node, "Resume worker")).toBeDefined(), { timeout: 2000 });
  await act(async () => button(node, "Resume worker").click());
  expect(resume).toHaveBeenCalledWith(trigger.anchorThreadId);
  await vi.waitFor(() => expect(button(node, "Resume worker")).toBeUndefined(), { timeout: 2000 });
});

it("uses authorized hidden-worker events on the real page and HTTP client, ignoring unrelated tasks and refreshing on reconnect", async () => {
  client = new MockHostClient({ latencyMs: 0, memoryPasses: "active" });
  const trigger = unwrapRpcResult(await client.rpc["triggers.list"]({})).triggers.find(
    (t) => t.systemRole === "memory-light",
  )!;
  const seed = unwrapRpcResult(await client.rpc["triggers.get"]({ triggerId: trigger.id }));
  let worker: NonNullable<typeof seed.anchorThread> = {
    ...seed.anchorThread!,
    listed: false,
    doneAt: "2026-11-03T10:00:00Z",
    inputQueuePaused: false,
  };
  const sockets: TestSocket[] = [];
  const read = vi.fn(() => ({ ...seed, anchorThread: worker }));
  http = new HttpHostClient({
    baseUrl: "http://127.0.0.1",
    refreshIntervalMs: 0,
    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      const data = path.endsWith("triggers.get")
        ? read()
        : path.endsWith("bootstrap.get")
          ? unwrapRpcResult(await client.rpc["bootstrap.get"]({}))
          : {};
      return new Response(JSON.stringify({ ok: true, data }), {
        headers: { "content-type": "application/json" },
      });
    },
    webSocketFactory: () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await http.load();
  const workspace = unwrapRpcResult(await client.rpc["bootstrap.get"]({})).workspaces.find(
    (w) => w.id === trigger.workspaceId,
  )!;
  const window = { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 };
  const connect = (socket: TestSocket) => {
    socket.emit("open", {});
    socket.receive({
      type: "host.snapshot",
      snapshot: {
        workspace,
        sequence: "0",
        serializedBytes: 256,
        notificationPreferences: [],
        readStates: [],
        messages: [],
        messageWindows: [],
        pendingRequests: [],
        pendingRequestWindow: window,
        runQueue: [],
        threads: [],
        threadWindow: window,
      },
    });
    socket.receive({ type: "host.synchronized", workspaceId: workspace.id, sequence: "0" });
  };
  connect(sockets[0]!);
  harness.client = http;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[`/automations/${trigger.id}`]}>
        <Routes>
          <Route path="/automations/:triggerId" element={<AutomationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(button(node, "Reopen worker")).toBeDefined(), { timeout: 2000 });
  expect(http.getSnapshot().threads.some((t) => t.id === worker.id)).toBe(false);
  let sequence = 0;
  const event = (type: string, data: object, threadId: string = worker.id) =>
    sockets[0]!.receive({
      type: "host.events",
      events: [
        {
          type,
          data,
          threadId,
          workspaceId: workspace.id,
          runId: null,
          environmentId: worker.environmentId,
          createdAt: worker.createdAt,
          eventId: createId("event"),
          sequence: String(++sequence),
        },
      ],
    });
  await act(async () => {
    worker = { ...worker, doneAt: null };
    event("thread.state-changed", {
      status: worker.status,
      doneAt: null,
      inputQueuePaused: false,
      pendingRequests: 0,
    });
  });
  await vi.waitFor(() => expect(button(node, "Reopen worker")).toBeUndefined(), { timeout: 2000 });
  await act(async () => {
    worker = { ...worker, inputQueuePaused: true };
    event("thread.input-queue-updated", { paused: true });
  });
  await vi.waitFor(() => expect(button(node, "Resume worker")).toBeDefined(), { timeout: 2000 });
  await act(async () => {
    worker = {
      ...worker,
      modelSelection: ModelSelectionSchema.parse({
        ...worker.modelSelection!,
        modelId: "changed-model",
      }),
    };
    event("thread.execution-updated", { thread: worker });
  });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4), { timeout: 2000 });
  await act(async () =>
    event(
      "thread.state-changed",
      { status: "running", doneAt: null, inputQueuePaused: false, pendingRequests: 0 },
      client.getSnapshot().homeThreadId!,
    ),
  );
  expect(read).toHaveBeenCalledTimes(4);
  await act(async () => sockets[0]!.emit("close", { code: 1006, reason: "Disconnected" }));
  await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 2000 });
  await act(async () => {
    worker = { ...worker, inputQueuePaused: false };
    connect(sockets[1]!);
  });
  await vi.waitFor(() => expect(button(node, "Resume worker")).toBeUndefined(), { timeout: 2000 });
  expect(read).toHaveBeenCalledTimes(5);
});

class TestSocket implements WebSocketClient {
  binaryType: BinaryType = "blob";
  readyState = 0;
  listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener(type: string, listener: (event: never) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  receive(message: unknown) {
    this.emit("message", { data: JSON.stringify(message) });
  }
  emit(type: string, event: unknown) {
    if (type === "open") this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}
