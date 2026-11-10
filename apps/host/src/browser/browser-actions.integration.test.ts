import {
  BrowserActionRequestSchema,
  BrowserActionResponseSchema,
  BrowserActionBindingSchema,
  BrowserAgentActionSchema,
  type BrowserAction,
  type BrowserActionResult,
} from "@opensteer/protocol/browser-actions";
import { createBrowserSessionId } from "@opensteer/protocol/browser";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  createMachineAccessDatabase,
  startMachineAccessHost,
  connectCallerMachine,
  enrollmentToken,
  dispatchCallerRun,
  stopRun,
  waitForMessage,
  closed,
} from "../runtime/machine-access.test-support.js";
import { startBrowserRuntime } from "./browser-runtime.test-support.js";

const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse())
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, "Phone browser test cleanup failed");
});

async function connect(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers });
  const snapshot = url.includes("/v1/browser-sessions/")
    ? waitForMessage(socket, (message) => message.type === "browser.snapshot", 2_000)
    : undefined;
  cleanups.push(async () => {
    socket.terminate();
    await withTimeout(closed(socket), 2_000, {
      timeoutError: () => new Error("Browser test socket did not close"),
    });
  });
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    2_000,
    { timeoutError: () => new Error("Browser test socket did not open") },
  );
  if (snapshot) await snapshot;
  return socket;
}
async function setup() {
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
  cleanups.push(() => database.drop());
  const startedAt = Date.now();
  let now = startedAt;
  const host = await startMachineAccessHost(database.url, {
    runCapabilityNow: () => now,
    runCapabilityLifetimeSeconds: 60,
  });
  cleanups.push(() => host.close());
  const caller = await connectCallerMachine(host, {
    name: "Agent computer",
    token: await enrollmentToken(host, {
      allowedModules: ["agents"],
      idempotencyKey: "agent",
      name: "Agent computer",
    }),
  });
  cleanups.push(() => caller.close());
  const run = await dispatchCallerRun(host, caller, { key: "phone-run", title: "Phone browser" });
  const other = await dispatchCallerRun(host, caller, {
    key: "other-run",
    title: "Other workspace",
  });
  const phone = await startBrowserRuntime(
    host.hostPort,
    await enrollmentToken(host, {
      allowedModules: ["browser"],
      idempotencyKey: "phone",
      name: "Phone browser",
    }),
    { agentActions: true, basicInput: true, surfaceState: true, targetedStreaming: true },
  );
  cleanups.push(() => phone.close());
  await vi.waitFor(() => expect(host.runtime.browser.available).toBe(true), { timeout: 2_000 });
  const opened = await host.runtime.browser.start({
    ownerId: host.ownerId,
    workspaceId: run.workspaceId,
    fresh: true,
    origin: "workspace",
    reuseExisting: false,
    placement: { kind: "runner", runnerId: phone.runnerId },
  });
  const sessionId = opened.session.id;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const backend = (token = run.toolsToken, id = sessionId) =>
    fetch(`${host.origin}/internal/v1/browser-backend/${id}`, { headers: bearer(token) });
  const actions = (token = run.toolsToken, id = sessionId) =>
    connect(`ws://127.0.0.1:${host.hostPort}/internal/v1/browser-actions/${id}`, bearer(token));
  let sequence = 0;
  const act = async (
    socket: WebSocket,
    action: BrowserAction,
    overrides: Record<string, unknown> = {},
  ) => {
    const request = BrowserActionRequestSchema.parse({
      id: ++sequence,
      sessionId,
      surfaceId: "page-integration",
      documentId: "document-integration",
      geometryRevision: 1,
      action,
      ...overrides,
    });
    const answered = waitForMessage(
      socket,
      (message) => "id" in message && message.id === request.id,
      2_000,
    );
    socket.send(JSON.stringify(request));
    return BrowserActionResponseSchema.parse(
      await answered.catch((error: unknown) => {
        throw new Error(`No answer to ${action.type} ${JSON.stringify(overrides)}`, {
          cause: error,
        });
      }),
    );
  };
  return {
    host,
    run,
    other,
    phone,
    sessionId,
    backend,
    actions,
    act,
    bearer,
    expire: () => {
      now += 61_000;
    },
    restoreTime: () => {
      now = startedAt;
    },
  };
}

integration("session-scoped browser agent backends", () => {
  it("admits focus, empty-session actions and suspended close without resuming or loosening other fences", async () => {
    const f = await setup();
    const socket = await f.actions();
    const viewer = await connect(
      `ws://127.0.0.1:${f.host.hostPort}/v1/browser-sessions/${f.sessionId}/connect?surfaceState=1`,
      f.host.ownerHeaders,
    );
    const forward = async (action: BrowserAction, result: BrowserActionResult, overrides = {}) => {
      const start = f.phone.receivedCommands().length;
      const pending = f.act(socket, action, overrides);
      const command = await vi.waitFor(
        () => {
          const received = f.phone
            .receivedCommands()
            .slice(start)
            .find((message) => message.type === "agent.action");
          expect(received, `${action.type} never reached the phone`).toBeDefined();
          return BrowserAgentActionSchema.parse(received);
        },
        { timeout: 1_000 },
      );
      f.phone.sendServer({
        type: "agent.result",
        attachmentId: command.attachmentId,
        requestId: command.requestId,
        result,
      });
      expect(await pending).toEqual({ id: command.request.id, result });
      return command.request;
    };
    const focused = await forward(
      { type: "dom.act", kind: "focus", locator: { by: "css", value: "input" } },
      { type: "dom.act", outcome: "acted", trusted: false },
    );
    expect(focused.documentId).toBe("document-integration");
    const publish = async (surfaces: readonly Record<string, unknown>[]) => {
      const changed = waitForMessage(
        viewer,
        (message) => message.type === "browser.surfaces.changed",
        2_000,
      );
      f.phone.sendServer({ type: "browser.surfaces.changed", surfaces });
      await changed;
    };
    await publish([]);
    const noTarget = { surfaceId: undefined, documentId: undefined, geometryRevision: undefined };
    const tabs = await forward(
      { type: "session.tabs" },
      { type: "session.tabs", tabs: [] },
      noTarget,
    );
    expect(tabs).not.toHaveProperty("surfaceId");
    const binding = BrowserActionBindingSchema.parse({
      surfaceId: "first-tab",
      documentId: "first-document",
      geometryRevision: 1,
      state: "live" as const,
      title: "First",
      url: "about:blank",
    });
    const opened = await forward(
      { type: "surface.open" },
      { type: "surface.open", binding },
      noTarget,
    );
    expect(opened).not.toHaveProperty("surfaceId");
    await publish([
      {
        id: binding.surfaceId,
        active: true,
        title: binding.title,
        url: binding.url,
        state: "suspended",
        documentId: binding.documentId,
        geometryRevision: 1,
      },
    ]);
    const target = { surfaceId: binding.surfaceId, documentId: binding.documentId };
    expect(await f.act(socket, { type: "page.info" }, target)).toMatchObject({
      error: { code: "target-suspended" },
    });
    expect(
      await f.act(socket, { type: "surface.close" }, { ...target, documentId: "stale" }),
    ).toMatchObject({ error: { code: "stale-document" } });
    await forward({ type: "surface.close" }, { type: "surface.close", outcome: "closed" }, target);
    expect(
      f.phone
        .receivedCommands()
        .some(
          (message) =>
            message.type === "agent.action" &&
            BrowserAgentActionSchema.parse(message).request.action.type === "surface.resume",
        ),
    ).toBe(false);
    expect(f.phone.protocolErrors()).toEqual([]);
  });

  it("negotiates the exact authorized session, pins CDP first, and refuses wrong Runs, sessions, expiry and revoked grants", async () => {
    const f = await setup();
    const response = await f.backend();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: f.sessionId,
      backend: "actions",
      version: 1,
    });
    expect((await f.backend(f.other.toolsToken)).status).toBe(403);
    expect((await f.backend(f.run.toolsToken, createBrowserSessionId())).status).toBe(403);
    const chromium = await startBrowserRuntime(
      f.host.hostPort,
      await enrollmentToken(f.host, {
        allowedModules: ["browser", "integrations"],
        idempotencyKey: "chromium",
        name: "CDP browser",
      }),
      {
        agentReady: true,
        agentActions: true,
        browserEngine: "android-webview",
        device: { form: "phone", platform: "android" },
      },
    );
    cleanups.push(() => chromium.close());
    await vi.waitFor(
      () =>
        expect(f.host.runtime.browser.bootstrap(f.host.ownerId)).resolves.toMatchObject({
          placements: expect.arrayContaining([
            expect.objectContaining({ runnerId: chromium.runnerId, available: true }),
          ]),
        }),
      { timeout: 2_000 },
    );
    const opened = await f.host.runtime.browser.start({
      ownerId: f.host.ownerId,
      workspaceId: f.run.workspaceId,
      fresh: true,
      origin: "workspace",
      reuseExisting: false,
      placement: { kind: "runner", runnerId: chromium.runnerId },
    });
    expect(await (await f.backend(f.run.toolsToken, opened.session.id)).json()).toEqual({
      sessionId: opened.session.id,
      backend: "cdp",
      version: 1,
    });
    const wrongBackend = await f.actions(f.run.toolsToken, opened.session.id);
    const refusal = await f.act(
      wrongBackend,
      { type: "session.tabs" },
      { sessionId: opened.session.id },
    );
    expect(refusal).toMatchObject({ error: { code: "unsupported-operation" } });
    const cdp = await connect(
      `ws://127.0.0.1:${f.host.hostPort}/internal/v1/browser-cdp/${f.sessionId}`,
      f.bearer(f.run.toolsToken),
    );
    const refused = waitForMessage(cdp, (message) => "id" in message && message.id === 1, 2_000);
    cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
    expect(await refused).toMatchObject({
      error: { reason: "unsupported-operation", message: expect.not.stringContaining("Update") },
    });
    f.expire();
    expect((await f.backend()).status).toBe(401);
    f.restoreTime();
    await stopRun(f.host, f.run, "revoke-agent");
    expect((await f.backend()).status).toBe(403);
    expect(f.phone.protocolErrors()).toEqual([]);
  });

  it("relays attributed actions only within the admitted Run/session and fences suspension, stale provenance and revocation", async () => {
    const f = await setup();
    const socket = await f.actions();
    const pending = f.act(socket, { type: "page.info" });
    let forwarded: Record<string, unknown> | undefined;
    await vi.waitFor(
      () => {
        forwarded = f.phone.receivedCommands().find((message) => message.type === "agent.action");
        expect(forwarded, "The phone never received the admitted action").toBeDefined();
      },
      { timeout: 2_000 },
    );
    expect(forwarded).toMatchObject({
      attachmentId: expect.any(String),
      actorToken: expect.any(String),
      request: { sessionId: f.sessionId },
    });
    const attached = f.phone.receivedCommands().find((message) => message.type === "agent.attach");
    expect(attached).toMatchObject({
      attachmentId: forwarded!.attachmentId,
      actorToken: forwarded!.actorToken,
      backend: "actions",
    });
    const reply = {
      type: "agent.result",
      attachmentId: forwarded!.attachmentId,
      requestId: forwarded!.requestId,
      result: {
        type: "page.info",
        binding: {
          surfaceId: "page-integration",
          documentId: "document-integration",
          geometryRevision: 1,
          title: "Integration page",
          url: "about:blank",
          state: "live",
        },
        loading: false,
        navigationFailed: false,
        sizedByAgent: false,
        dialog: null,
      },
    };
    f.phone.sendServer({
      ...reply,
      attachmentId: crypto.randomUUID(),
      result: { ...reply.result, binding: { ...reply.result.binding, title: "Wrong attachment" } },
    });
    f.phone.sendServer(reply);
    expect(await pending).toMatchObject({
      result: { type: "page.info", binding: { title: "Integration page" } },
    });
    expect(
      await f.act(socket, { type: "page.info" }, { sessionId: createBrowserSessionId() }),
    ).toMatchObject({ error: { code: "forbidden" } });
    expect(await f.act(socket, { type: "page.info" }, { documentId: "stale" })).toMatchObject({
      error: { code: "stale-document" },
    });
    expect(
      await f.act(socket, { type: "pointer.tap", x: 10, y: 10, count: 1 }, { geometryRevision: 0 }),
    ).toMatchObject({ error: { code: "stale-geometry" } });
    expect(await f.act(socket, { type: "page.info" }, { surfaceId: "closed" })).toMatchObject({
      error: { code: "target-closed" },
    });
    const viewer = await connect(
      `ws://127.0.0.1:${f.host.hostPort}/v1/browser-sessions/${f.sessionId}/connect?basicInput=1&surfaceState=1`,
      f.host.ownerHeaders,
    );
    const suspended = waitForMessage(
      viewer,
      (message) => message.type === "browser.surfaces.changed",
      2_000,
    );
    f.phone.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        {
          id: "page-integration",
          active: true,
          title: "Phone",
          url: "about:blank",
          state: "suspended",
          documentId: "document-integration",
          geometryRevision: 1,
        },
      ],
    });
    await suspended.catch((error: unknown) => {
      throw new Error("Viewer never observed the suspended tab", { cause: error });
    });
    expect(await f.act(socket, { type: "text.insert", text: "Do not type" })).toMatchObject({
      error: { code: "target-suspended" },
    });
    const wrongRun = await f.actions(f.other.toolsToken);
    expect(await f.act(wrongRun, { type: "session.tabs" })).toMatchObject({
      error: { code: "forbidden" },
    });
    const missingSession = await f.actions(f.run.toolsToken, createBrowserSessionId());
    expect(await f.act(missingSession, { type: "session.tabs" })).toMatchObject({
      error: { code: "forbidden" },
    });
    f.expire();
    await expect(f.actions()).rejects.toThrow("401");
    f.restoreTime();
    const ended = withTimeout(closed(socket), 2_000, {
      timeoutError: () => new Error("Revoked Run left its actions socket open"),
    });
    await stopRun(f.host, f.run, "revoke-agent");
    expect(await f.act(socket, { type: "session.tabs" })).toMatchObject({
      error: { code: "forbidden" },
    });
    await withTimeout(f.run.reportInterrupted(), 2_000, {
      timeoutError: () => new Error("Runner interruption was not acknowledged"),
    });
    await ended;
    await vi.waitFor(
      () =>
        expect(f.phone.receivedCommands()).toContainEqual(
          expect.objectContaining({ type: "agent.detach", attachmentId: forwarded!.attachmentId }),
        ),
      { timeout: 2_000 },
    );
    expect(
      f.phone.receivedCommands().filter((message) => message.type === "agent.action"),
    ).toHaveLength(1);
    expect(f.phone.protocolErrors()).toEqual([]);
  });

  it("admits only negotiated basic viewer input, routes plain clipboard, and refuses input on suspended tabs", async () => {
    const f = await setup();
    const viewer = await connect(
      `ws://127.0.0.1:${f.host.hostPort}/v1/browser-sessions/${f.sessionId}/connect?basicInput=1&surfaceState=1`,
      f.host.ownerHeaders,
    );
    const commands = f.phone.receivedCommands();
    const send = (message: Record<string, unknown>) =>
      viewer.send(JSON.stringify({ surfaceId: "page-integration", ...message }));
    send({ type: "input.command", command: "selectAll" });
    await vi.waitFor(
      () =>
        expect(commands).toContainEqual(
          expect.objectContaining({
            type: "input.command",
            command: "selectAll",
            consumerToken: expect.any(String),
            producerId: expect.any(String),
          }),
        ),
      { timeout: 2_000 },
    );
    for (const message of [
      { type: "input.command", command: "undo" },
      { type: "clipboard.cut", operationId: crypto.randomUUID() },
      {
        type: "clipboard.paste-data",
        operationId: crypto.randomUUID(),
        items: [{ type: "text/html", size: 1 }],
      },
      { type: "input.key", action: "down", key: "Tab", code: "Tab", modifiers: [] },
      {
        type: "input.text",
        edit: { contextId: crypto.randomUUID(), text: "bad", before: "replace", after: "" },
      },
    ]) {
      const refused = waitForMessage(viewer, (message) => message.type === "browser.error", 2_000);
      send(message);
      expect(await refused).toMatchObject({ error: { reason: "unsupported-operation" } });
    }
    const operationId = crypto.randomUUID();
    send({ type: "clipboard.copy", operationId });
    await vi.waitFor(
      () =>
        expect(commands).toContainEqual(
          expect.objectContaining({
            type: "clipboard.copy",
            operationId,
            consumerToken: expect.any(String),
          }),
        ),
      { timeout: 2_000 },
    );
    const copy = commands.find(
      (message) => message.type === "clipboard.copy" && message.operationId === operationId,
    )!;
    const copied = waitForMessage(viewer, (message) => message.type === "clipboard.result", 2_000);
    f.phone.sendServer({
      type: "clipboard.result",
      surfaceId: "page-integration",
      operationId,
      consumerToken: copy.consumerToken,
      outcome: "copied",
      items: [{ type: "text/plain", size: 2 }],
    });
    expect(await copied).toMatchObject({ outcome: "copied" });
    for (let index = 0; index < 33; index++) {
      const copyId = crypto.randomUUID();
      const part = waitForMessage(
        viewer,
        (message) =>
          message.type === "clipboard.part" &&
          "part" in message &&
          (message.part as { operationId?: string }).operationId === copyId,
        2_000,
      );
      f.phone.sendServer({
        type: "clipboard.result",
        surfaceId: "page-integration",
        operationId: copyId,
        consumerToken: copy.consumerToken,
        outcome: "copied",
        items: [{ type: "text/plain", size: 2 }],
      });
      f.phone.sendServer({
        type: "clipboard.part",
        consumerToken: copy.consumerToken,
        part: { operationId: copyId, index: 0, data: "aGk=" },
      });
      expect(await part).toMatchObject({ part: { operationId: copyId, index: 0, data: "aGk=" } });
    }
    const legacy = await connect(
      `ws://127.0.0.1:${f.host.hostPort}/v1/browser-sessions/${f.sessionId}/connect`,
      f.host.ownerHeaders,
    );
    const notNegotiated = withTimeout(
      new Promise<{ code: number; reason: string }>((resolve) =>
        legacy.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
      ),
      2_000,
      { timeoutError: () => new Error("Legacy viewer input was not refused") },
    );
    legacy.send(
      JSON.stringify({
        type: "input.command",
        surfaceId: "page-integration",
        command: "selectAll",
      }),
    );
    expect(await notNegotiated).toEqual({
      code: 4002,
      reason: "Browser editing was not negotiated.",
    });
    const changed = waitForMessage(
      viewer,
      (message) => message.type === "browser.surfaces.changed",
      2_000,
    );
    f.phone.sendServer({
      type: "browser.surfaces.changed",
      surfaces: [
        {
          id: "page-integration",
          active: true,
          title: "Phone",
          url: "about:blank",
          state: "suspended",
        },
      ],
    });
    await changed;
    const refused = waitForMessage(viewer, (message) => message.type === "browser.error", 2_000);
    send({ type: "clipboard.paste", text: "Do not type" });
    expect(await refused).toMatchObject({ error: { reason: "target-suspended" } });
    expect(f.phone.protocolErrors()).toEqual([]);
  });
});
