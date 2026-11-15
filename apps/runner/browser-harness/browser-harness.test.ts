import { expect, it, vi, afterEach } from "vitest";
// @ts-expect-error Standalone JavaScript executable.
import { CdpClient, createBrowserHarness, networkIdle } from "./cdp.mjs";
// @ts-expect-error Standalone JavaScript executable.
import { createFacade } from "./browser-harness.mjs";

class Client {
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  listeners = new Set<(event: Record<string, unknown>) => void>();
  closers = new Set<(error: Error) => void>();
  closed = false;
  constructor(readonly target = "target") {}
  async command(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    this.calls.push({ method, params, sessionId });
    if (method === "Opensteer.resumeTab")
      return {
        surfaceId: params.surfaceId,
        targetId: this.target,
        documentId: "document",
        reloaded: false,
        dialog: null,
        userActivity: null,
        pageResize: null,
      };
    if (method === "Target.attachToTarget")
      return { sessionId: `cdp-${this.target}`, dialog: null };
    if (method === "Target.getTargetInfo")
      return {
        targetInfo: {
          targetId: this.target,
          title: this.target,
          url: `https://${this.target}.test/`,
        },
      };
    if (method === "Runtime.evaluate")
      return params.expression === "document"
        ? { result: { objectId: "document" } }
        : { result: { value: this.target } };
    if (method === "Runtime.callFunctionOn") return { result: { value: this.target } };
    return {};
  }
  onEvent(listener: (event: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: (error: Error) => void) {
    this.closers.add(listener);
    return () => this.closers.delete(listener);
  }
  drainEvents() {
    return [];
  }
  emit(method: string, params: object = {}, sessionId = `cdp-${this.target}`) {
    for (const listener of this.listeners) listener({ method, params, sessionId });
  }
  close() {
    this.closed = true;
    for (const listener of this.closers) listener(new Error("closed"));
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("attaches by resume alone and final cleanup never waits for a detach response", async () => {
  const client = new Client();
  const harness = createBrowserHarness(client, "tab");
  await harness.attach();
  expect(client.calls.map((call) => call.method)).toEqual([
    "Opensteer.resumeTab",
    "Target.attachToTarget",
  ]);
  await harness.detach({ final: true });
  expect(client.calls.some((call) => call.method === "Target.detachFromTarget")).toBe(false);
});

it("keeps two page handles and initial aliases bound across different profiles", async () => {
  const first = new Client("one"),
    second = new Client("two");
  const clients = [first, second];
  vi.spyOn(CdpClient, "connect").mockImplementation(async () => clients.shift());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, options: RequestInit) => {
      const input = JSON.parse(String(options.body)) as { tabId: string };
      return Response.json({
        tabId: input.tabId,
        sessionId: `session-${input.tabId}`,
        backend: "cdp",
        reloaded: false,
      });
    }),
  );
  const { facade, bindInitial, close } = createFacade("ws://127.0.0.1/relay", fetch);
  await bindInitial("first");
  const original = facade.page;
  const other = await facade.openPage("second");
  expect(await other.evaluate("2")).toBe("two");
  expect(await original.evaluate("1")).toBe("one");
  expect(await facade.js("1")).toBe("one");
  expect(facade.page).toBe(original);
  expect(original.tabId).toBe("first");
  expect(other.tabId).toBe("second");
  expect(
    first.calls
      .filter((call) => call.method === "Runtime.evaluate")
      .every((call) => call.sessionId === "cdp-one"),
  ).toBe(true);
  await close();
  expect(first.closed && second.closed).toBe(true);
});

it("returns shared ToolError results and preserves content blocks for tools without structured output", async () => {
  const error = { error: { code: "access_denied", message: "Denied", next: null } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, options: RequestInit) => {
      const input = JSON.parse(String(options.body)) as { callId: string; name: string };
      expect(input.callId).toMatch(/^[0-9a-f-]{36}$/u);
      return Response.json(
        input.name === "denied"
          ? {
              content: [{ type: "text", text: JSON.stringify(error) }],
              structuredContent: error,
              isError: true,
            }
          : { content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
        input.name === "denied" ? { status: 400 } : {},
      );
    }),
  );
  const { facade, close } = createFacade("ws://127.0.0.1/relay", fetch);
  expect(await facade.opensteer.callTool("denied", {})).toEqual(error);
  expect(await facade.opensteer.callTool("image", {})).toMatchObject({
    content: [{ type: "image" }],
  });
  expect(() => facade.page.title()).toThrow("Use --tab");
  await close();
});

it("observes network idle per handle, settles redirects and streaming responses, and stops at its deadline", async () => {
  vi.useFakeTimers();
  const client = new Client();
  const idle = networkIdle(
    client,
    () => Promise.resolve({}),
    () => "cdp-target",
    { idleMs: 50, timeout: 200 },
  );
  await vi.advanceTimersByTimeAsync(0);
  client.emit("Network.requestWillBeSent", { requestId: "request" });
  client.emit("Network.requestWillBeSent", { requestId: "request", redirectResponse: {} });
  client.emit("Network.requestWillBeSent", { requestId: "foreign" }, "other-handle");
  client.emit("Network.requestWillBeSent", { requestId: "stream", type: "EventSource" });
  await vi.advanceTimersByTimeAsync(100);
  client.emit("Network.loadingFinished", { requestId: "request" });
  await vi.advanceTimersByTimeAsync(50);
  expect(await idle).toBe(true);
  const deadline = networkIdle(
    client,
    () => Promise.resolve({}),
    () => "cdp-target",
    { idleMs: 50, timeout: 100 },
  );
  client.emit("Network.requestWillBeSent", { requestId: "never-finished" });
  await vi.advanceTimersByTimeAsync(100);
  expect(await deadline).toBe(false);
  expect(client.listeners.size).toBe(0);
  const closed = networkIdle(
    client,
    () => Promise.resolve({}),
    () => "cdp-target",
  );
  const rejection = expect(closed).rejects.toThrow("closed");
  client.close();
  await rejection;
  expect(client.listeners.size).toBe(0);
});

it("a newer dialog event beats an older snapshot when answering", async () => {
  const client = new Client();
  const send = client.command.bind(client);
  client.command = async (method, params = {}, sessionId) => {
    if (method === "Target.getTargetInfo") {
      client.emit("Page.javascriptDialogOpening", {
        dialogId: "new",
        type: "confirm",
        message: "New dialog",
      });
      return {
        targetInfo: {
          targetId: "target",
          dialog: { id: "old", type: "confirm", message: "Old dialog" },
        },
      };
    }
    return send(method, params, sessionId);
  };
  const harness = createBrowserHarness(client, "tab");
  await harness.attach();
  expect(await harness.currentTab()).toMatchObject({ dialog: { id: "new" } });
  await harness.respondDialog({ accept: true });
  expect(client.calls.at(-1)?.params).toMatchObject({ dialogId: "new" });
  await harness.detach({ final: true });
  client.close();
});

it("reloading one sleeping page invalidates that handle and its network wait alone", async () => {
  const firstClient = new Client("one"),
    secondClient = new Client("two");
  const first = createBrowserHarness(firstClient, "first"),
    second = createBrowserHarness(secondClient, "second");
  await first.attach();
  await second.attach();
  const wait = first.waitForNetworkIdle({ idleMs: 1000 });
  const failed = expect(wait).rejects.toThrow("stale");
  const send = firstClient.command.bind(firstClient);
  firstClient.command = async (method, params = {}, sessionId) =>
    method === "Opensteer.resumeTab"
      ? { surfaceId: "first", targetId: "replacement", documentId: "new", reloaded: true }
      : send(method, params, sessionId);
  await first.cdp("Opensteer.resumeTab", { surfaceId: "first" });
  await failed;
  await expect(first.js("true")).rejects.toThrow("stale");
  expect(await second.js("true")).toBe("two");
  await first.detach({ final: true });
  await second.detach({ final: true });
  firstClient.close();
  secondClient.close();
});

it("refuses the removed hidden target argument without sending a command", async () => {
  const client = new Client();
  const harness = createBrowserHarness(client, "first");
  await expect(harness.js("1", "other")).rejects.toThrow("openPage");
  expect(client.calls).toEqual([]);
});
