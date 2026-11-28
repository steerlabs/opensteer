import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import { createRequire } from "node:module";
import type { FastifyPluginCallback } from "fastify";
const hostRequire = createRequire(new URL("../../host/package.json", import.meta.url));
const websocket = hostRequire("@fastify/websocket") as FastifyPluginCallback;
import WebSocket from "ws";
import { SessionCdpRouter, type CdpCommand } from "../../../packages/browser-core/src/index.js";
import {
  BrowserController,
  HostSignIns,
  SessionFiles,
  SurfaceLedger,
} from "../../../packages/browser-runtime-core/src/index.js";
import {
  FakeBrowserCdpBackend,
  FakeContext,
  FakePage,
  FakeSink,
  testSessionFilesRoot,
  validClaims,
} from "../../../packages/browser-runtime-core/src/test-support/fakes.js";
import { registerAgentCdpBridge } from "../../host/src/browser/trigger-cdp-bridge.js";
import type { BrowserService } from "../../host/src/browser/browser-service.js";
import type { RunToolTokenService } from "../../host/src/agents/run-tool-tokens.js";
import { withTimeout } from "@opensteer/shared/withTimeout";

it("socket close releases real runtime channels and held input without a final detach response", async () => {
  const page = new FakePage();
  const context = new FakeContext([page]);
  const router = new SessionCdpRouter(new FakeBrowserCdpBackend(context));
  const claims = validClaims();
  const files = new SessionFiles(testSessionFilesRoot());
  const ledger = new SurfaceLedger(context, {
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    rootPages: [page],
  });
  await ledger.start();
  router.registerSession(
    claims.sessionId,
    await page.targetId(),
    (id) => ledger.resolveTarget(id),
    files.root,
  );
  const sink = new FakeSink();
  const controller = new BrowserController({
    claims,
    cdpRouter: router,
    ledger,
    files,
    sink,
    replaceSiteCookies: async () => {},
    signIns: new HostSignIns({ authority: undefined, runtimeId: "test" }),
  });
  await controller.start();
  const released = Promise.withResolvers<void>();
  const originalClose = page.cdpSession.close.bind(page.cdpSession);
  vi.spyOn(page.cdpSession, "close").mockImplementation(async () => {
    await originalClose();
    released.resolve();
  });
  const dispatch = async (command: CdpCommand) => {
    const requestId = randomUUID();
    const result = controller.handle({ type: "cdp.command", requestId, command }).then(() => {
      const reply = sink.messages.findLast(
        (message) =>
          (message.type === "cdp.result" || message.type === "cdp.error") &&
          message.requestId === requestId,
      );
      if (reply?.type === "cdp.error") throw new Error(reply.error.message);
      if (reply?.type !== "cdp.result") throw new Error("Runtime did not answer");
      return reply.result;
    });
    return { result };
  };
  const app = Fastify();
  await app.register(websocket);
  registerAgentCdpBridge(
    app,
    {
      attachCdpForAgent: async () => ({ close: () => {}, dispatch }),
    } as unknown as BrowserService,
    {
      authenticateExecution: async () => ({
        claims: { requestedBy: "user", runId: "run" },
        lineage: null,
      }),
      reauthorize: async (scope: unknown) => scope,
    } as unknown as RunToolTokenService,
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Socket fixture did not bind");
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/internal/v1/browser-cdp/${claims.sessionId}`,
    { headers: { authorization: "Bearer fixture-token-1234567890" } },
  );
  const messages: Array<{ id: number }> = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as { id: number }));
  await withTimeout(once(socket, "open"), 1000, {
    timeoutError: () => new Error("Socket fixture did not connect"),
  });
  const client = { socket, messages };
  const request = async (id: number, method: string, params: object = {}, sessionId?: string) => {
    const answered = new Promise<unknown>((resolve) =>
      client.socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
    );
    client.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return withTimeout(answered, 1000, {
      timeoutError: () => new Error(`Socket did not answer ${method}`),
    });
  };
  try {
    const attached = (await request(1, "Target.attachToTarget", {
      targetId: await page.targetId(),
    })) as { result: { sessionId: string } };
    await request(
      2,
      "Input.dispatchKeyEvent",
      { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 },
      attached.result.sessionId,
    );
    client.socket.close();
    await withTimeout(released.promise, 1000, {
      timeoutError: () => new Error("Socket close did not release the runtime channel"),
    });
    expect(
      page.cdpSession.sent.some(
        (command) =>
          command.method === "Input.dispatchKeyEvent" && command.parameters?.type === "keyUp",
      ),
    ).toBe(true);
    expect(page.cdpSession.detachCount).toBeGreaterThan(0);
    expect(client.messages.map((message) => message.id)).toEqual([1, 2]);
  } finally {
    client.socket.terminate();
    await controller.close();
    await router.close();
    await ledger.close();
    await app.close();
  }
});
