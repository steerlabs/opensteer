import websocket from "@fastify/websocket";
import { createId } from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";
import Fastify from "fastify";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentControlTokenService } from "../agents/agent-control-service.js";
import { BrowserCdpConnectionEnded, type BrowserService } from "./browser-service.js";
import {
  registerAgentCdpBridge,
  registerTriggerCdpBridge,
  registerWatchCdpBridge,
} from "./trigger-cdp-bridge.js";
import type { TriggerControlTokenService } from "../triggers/trigger-control-service.js";
import type { WatchCapabilityTokenService } from "../triggers/watch-capability.js";

const applications: ReturnType<typeof Fastify>[] = [];

/** A browser that answers each command as soon as it is dispatched. */
function dispatchVia(request: (command: unknown) => Promise<unknown> | unknown) {
  return async (command: unknown) => ({ result: Promise.resolve(request(command)) });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function listen(app: ReturnType<typeof Fastify>): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return address.port;
}

async function connect(url: string, token: string) {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const messages: { id: number; result?: unknown; error?: { message: string } }[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as never));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { closed, messages, socket };
}

/** An agent connection whose browser dispatches and answers as the test says. */
async function agentBridge(
  dispatch: (command: { method: string }) => Promise<{ readonly result: Promise<unknown> }>,
) {
  const app = Fastify();
  applications.push(app);
  await app.register(websocket);
  const requestedBy = createId("user");
  registerAgentCdpBridge(
    app,
    {
      attachCdpForAgent: vi.fn(async () => ({
        close: vi.fn(),
        dispatch,
        request: async (command: { method: string }) => (await dispatch(command)).result,
        session: {},
      })),
      closeTriggerSessionsForBinding: vi.fn(async () => []),
      openAgentSession: vi.fn(),
    } as unknown as BrowserService,
    {
      authenticate: vi.fn(async () => ({
        requestedBy,
        runId: createId("run"),
        workspaceId: createId("workspace"),
      })),
      reauthorize: vi.fn(async (scope: unknown) => scope),
    } as unknown as AgentControlTokenService,
  );
  const port = await listen(app);
  return connect(
    `ws://127.0.0.1:${port}/internal/v1/browser-cdp/${createBrowserSessionId()}`,
    "agent-control-token-1234567890",
  );
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

describe("Trigger CDP bridge", () => {
  it("adapts standard CDP WebSocket frames to the Browser Runtime", async () => {
    const requestedBy = createId("user");
    const workspaceId = createId("workspace");
    const occurrenceId = createId("triggerOccurrence");
    const environmentId = createId("environment");
    const authenticate = vi.fn(async () => ({
      environmentId,
      occurrenceId,
      requestedBy,
      workspaceId,
    }));
    const request = vi.fn(async () => ({ product: "Opensteer/TestBrowser" }));
    const close = vi.fn();
    const closeTriggerSessionsForBinding = vi.fn(async () => []);
    const sessionId = createBrowserSessionId();
    const openAgentSession = vi.fn(async () => ({
      session: { id: sessionId },
      wasExisting: false,
    }));
    let allowAttachment!: () => void;
    const attachmentReady = new Promise<void>((resolve) => {
      allowAttachment = resolve;
    });
    let onBrowserClosed: (() => void) | undefined;
    const attachCdpForAgent = vi.fn(
      async (_authority: unknown, _onEvent: unknown, onClosed?: () => void) => {
        await attachmentReady;
        onBrowserClosed = onClosed;
        return { close, dispatch: dispatchVia(request), request, session: {} };
      },
    );
    const app = Fastify();
    applications.push(app);
    await app.register(websocket);
    registerTriggerCdpBridge(
      app,
      {
        attachCdpForAgent,
        closeTriggerSessionsForBinding,
        openAgentSession,
      } as unknown as BrowserService,
      { authenticate } as unknown as TriggerControlTokenService,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/v1/trigger-cdp`, {
      headers: { authorization: "Bearer trigger-control-token-1234567890" },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(JSON.stringify({ id: 7, method: "Browser.getVersion" }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      allowAttachment();
      const message = await new Promise<string>((resolve, reject) => {
        socket.once("message", (data) => resolve(data.toString()));
        socket.once("error", reject);
      });

      expect(JSON.parse(message)).toEqual({
        id: 7,
        result: { product: "Opensteer/TestBrowser" },
      });
      expect(authenticate).toHaveBeenCalledWith("trigger-control-token-1234567890");
      expect(openAgentSession).toHaveBeenCalledWith({
        fresh: true,
        agentBindingId: `trigger:${occurrenceId}`,
        environmentId,
        ownerId: requestedBy,
        workspaceId,
      });
      expect(attachCdpForAgent).toHaveBeenCalledWith(
        {
          agentBindingId: `trigger:${occurrenceId}`,
          environmentId,
          ownerId: requestedBy,
          sessionId,
          workspaceId,
        },
        expect.any(Function),
        expect.any(Function),
      );
      expect(request).toHaveBeenCalledWith({ method: "Browser.getVersion" });
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      onBrowserClosed?.();
      await closed;
      await vi.waitFor(() => {
        expect(close).toHaveBeenCalledOnce();
        expect(closeTriggerSessionsForBinding).toHaveBeenCalledWith(`trigger:${occurrenceId}`);
      });
    } finally {
      socket.close();
    }
  });
});

describe("Watch CDP bridge", () => {
  it("closes the Browser session when its rotating capability expires", async () => {
    const activationId = createId("triggerWatchActivation");
    const close = vi.fn();
    const closeTriggerSessionsForBinding = vi.fn(async () => []);
    const app = Fastify();
    applications.push(app);
    await app.register(websocket);
    registerWatchCdpBridge(
      app,
      {
        attachCdpForAgent: vi.fn(async () => ({
          close,
          dispatch: dispatchVia(vi.fn()),
          request: vi.fn(),
          session: {},
        })),
        closeTriggerSessionsForBinding,
        openAgentSession: vi.fn(async () => ({
          session: { id: createBrowserSessionId() },
          wasExisting: false,
        })),
      } as unknown as BrowserService,
      {
        authenticate: vi.fn(async () => ({
          activationId,
          createdBy: createId("user"),
          environmentId: createId("environment"),
          exp: (Date.now() + 100) / 1_000,
          workspaceId: createId("workspace"),
        })),
      } as unknown as WatchCapabilityTokenService<"opensteer-watch-browser-cdp">,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/internal/v1/watch-cdp`, {
      headers: { authorization: "Bearer watch-browser-token-1234567890" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(closeTriggerSessionsForBinding).toHaveBeenCalledWith(`watch:${activationId}`);
    });
  });
});

describe("Agent CDP bridge", () => {
  it("binds a connection to the session it names and never releases the Run's sessions", async () => {
    const requestedBy = createId("user");
    const workspaceId = createId("workspace");
    const runId = createId("run");
    const sessionId = createBrowserSessionId();
    const close = vi.fn();
    const closeTriggerSessionsForBinding = vi.fn(async () => []);
    const openAgentSession = vi.fn();
    const request = vi.fn(async () => ({ product: "Opensteer/TestBrowser" }));
    const attachCdpForAgent = vi.fn(async () => ({
      close,
      dispatch: dispatchVia(request),
      request,
      session: {},
    }));
    const app = Fastify();
    applications.push(app);
    await app.register(websocket);
    registerAgentCdpBridge(
      app,
      {
        attachCdpForAgent,
        closeTriggerSessionsForBinding,
        openAgentSession,
      } as unknown as BrowserService,
      {
        authenticate: vi.fn(async () => ({ requestedBy, runId, workspaceId })),
        reauthorize: vi.fn(async (scope: unknown) => scope),
      } as unknown as AgentControlTokenService,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/internal/v1/browser-cdp/${sessionId}`,
      { headers: { authorization: "Bearer agent-control-token-1234567890" } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    const message = await new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    );
    expect(JSON.parse(message)).toEqual({ id: 1, result: { product: "Opensteer/TestBrowser" } });
    expect(attachCdpForAgent).toHaveBeenCalledWith(
      { agentBindingId: `run:${runId}`, ownerId: requestedBy, sessionId, workspaceId },
      expect.any(Function),
      expect.any(Function),
    );
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(openAgentSession).not.toHaveBeenCalled();
    expect(closeTriggerSessionsForBinding).not.toHaveBeenCalled();
  });
});

describe("CDP bridge dispatch", () => {
  it("dispatches in arrival order and answers each command when the browser does", async () => {
    // A press its dialog blocks, then the answer that unblocks it.
    const press = deferred<unknown>();
    const answer = deferred<unknown>();
    const dispatched: string[] = [];
    const { messages, socket } = await agentBridge(async (command) => {
      dispatched.push(command.method);
      return {
        result: command.method === "Input.dispatchMouseEvent" ? press.promise : answer.promise,
      };
    });
    socket.send(JSON.stringify({ id: 1, method: "Input.dispatchMouseEvent", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "Page.handleJavaScriptDialog", params: {} }));
    await vi.waitFor(() =>
      expect(dispatched).toEqual(["Input.dispatchMouseEvent", "Page.handleJavaScriptDialog"]),
    );
    answer.resolve({});
    await vi.waitFor(() => expect(messages).toEqual([{ id: 2, result: {} }]));
    press.resolve({ pressed: true });
    await vi.waitFor(() =>
      expect(messages).toEqual([
        { id: 2, result: {} },
        { id: 1, result: { pressed: true } },
      ]),
    );
    socket.close();
  });

  it("admits a command only once the one before it is on its way", async () => {
    const admission = deferred<void>();
    const dispatched: string[] = [];
    const { messages, socket } = await agentBridge(async (command) => {
      if (command.method === "Target.attachToTarget") await admission.promise;
      dispatched.push(command.method);
      return { result: Promise.resolve({ method: command.method }) };
    });
    socket.send(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dispatched).toEqual([]);
    admission.resolve();
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(dispatched).toEqual(["Target.attachToTarget", "Runtime.evaluate"]);
    socket.close();
  });

  it("keeps a connection after a refused command and ends it after a terminal one", async () => {
    const dispatched: number[] = [];
    let count = 0;
    const { closed, messages, socket } = await agentBridge(async () => {
      count += 1;
      dispatched.push(count);
      if (count === 1) return { result: Promise.reject(new Error("Not allowed here.")) };
      if (count === 3) throw new BrowserCdpConnectionEnded("The Browser Session ended.");
      return { result: Promise.resolve({ ok: count }) };
    });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: {} }));
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages).toEqual([
      { error: { code: -32_000, message: "Not allowed here." }, id: 1 },
      { id: 2, result: { ok: 2 } },
    ]);
    socket.send(JSON.stringify({ id: 3, method: "Runtime.evaluate", params: {} }));
    socket.send(JSON.stringify({ id: 4, method: "Runtime.evaluate", params: {} }));
    expect((await closed).reason).toBe("The Browser Session ended.");
    expect(messages.at(-1)).toEqual({
      error: { code: -32_000, message: "The Browser Session ended." },
      id: 3,
    });
    expect(dispatched).toEqual([1, 2, 3]);
  });

  it("counts a command against the queue until it is answered", async () => {
    const pending: ReturnType<typeof deferred<unknown>>[] = [];
    const { closed, messages, socket } = await agentBridge(async () => {
      const answer = deferred<unknown>();
      pending.push(answer);
      return { result: answer.promise };
    });
    for (let id = 1; id <= 64; id += 1)
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {} }));
    await vi.waitFor(() => expect(pending).toHaveLength(64));
    for (const answer of pending.splice(0)) answer.resolve({});
    await vi.waitFor(() => expect(messages).toHaveLength(64));
    // Answered commands no longer count; unanswered ones do.
    for (let id = 65; id <= 128; id += 1)
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: {} }));
    await vi.waitFor(() => expect(pending).toHaveLength(64));
    socket.send(JSON.stringify({ id: 129, method: "Runtime.evaluate", params: {} }));
    expect((await closed).reason).toBe("CDP command queue is full");
  });

  it("sends nothing after a watch expires with commands outstanding, and closes its session", async () => {
    const activationId = createId("triggerWatchActivation");
    const claims = {
      activationId,
      createdBy: createId("user"),
      environmentId: createId("environment"),
      exp: (Date.now() + 500) / 1_000,
      workspaceId: createId("workspace"),
    };
    const close = vi.fn();
    const closeTriggerSessionsForBinding = vi.fn(async () => []);
    const answers = [deferred<unknown>(), deferred<unknown>()];
    let next = 0;
    const app = Fastify();
    applications.push(app);
    await app.register(websocket);
    registerWatchCdpBridge(
      app,
      {
        attachCdpForAgent: vi.fn(async () => ({
          close,
          dispatch: async () => ({ result: answers[next++]!.promise }),
          request: async () => answers[next++]!.promise,
          session: {},
        })),
        closeTriggerSessionsForBinding,
        openAgentSession: vi.fn(async () => ({
          session: { id: createBrowserSessionId() },
          wasExisting: false,
        })),
      } as unknown as BrowserService,
      {
        authenticate: vi.fn(async () => claims),
      } as unknown as WatchCapabilityTokenService<"opensteer-watch-browser-cdp">,
    );
    const port = await listen(app);
    const { closed, messages, socket } = await connect(
      `ws://127.0.0.1:${port}/internal/v1/watch-cdp`,
      "watch-browser-token-1234567890",
    );
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {} }));
    socket.send(JSON.stringify({ id: 2, method: "Browser.getVersion", params: {} }));
    await vi.waitFor(() => expect(next).toBeGreaterThan(0));
    expect((await closed).reason).toBe("CDP capability expired");
    answers[0]!.resolve({});
    answers[1]!.reject(new Error("The page went away."));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toEqual([]);
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(closeTriggerSessionsForBinding).toHaveBeenCalledWith(`watch:${activationId}`);
    });
  });
});
