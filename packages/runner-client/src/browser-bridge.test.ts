import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol";
import { BrowserChannelIdSchema } from "@opensteer/protocol/browser-relay";
import { gate } from "@opensteer/shared/test-support/observation";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { closeHttpServerNow } from "@opensteer/shared/httpServer";
import { LocalBrowserRuntimeBridge } from "./browser-bridge.js";

async function fixture(capabilities: object = {}) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        wireVersion: 1,
        runtimeId: "runtime_test",
        state: "ready",
        sessionCount: 1,
        profileHostCount: 1,
        ...capabilities,
      }),
    );
  });
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing bridge port");
  const bridge = new LocalBrowserRuntimeBridge({
    bridgeToken: "a".repeat(64),
    runtimeId: "runtime_test",
    url: new URL(`http://127.0.0.1:${address.port}`),
  });
  const keys = generateKeyPairSync("ed25519");
  bridge.setAttachPublicKeys([
    {
      keyId: "test",
      publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    },
  ]);
  return {
    bridge,
    sockets,
    close: async () => {
      bridge.closeAll();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await closeHttpServerNow(server);
    },
  };
}

describe("LocalBrowserRuntimeBridge", () => {
  it("advertises only capabilities reported by the prepared runtime, with exact storage identity", async () => {
    const localProfileStorage = { storageInstanceId: randomUUID(), engine: "electron" };
    const f = await fixture({
      localProfileStorage,
    });
    const old = await fixture();
    try {
      expect(await f.bridge.capabilities()).toEqual({
        wireVersion: 1,
        localProfileStorage,
      });
      expect(await old.bridge.capabilities()).toEqual({ wireVersion: 1 });
    } finally {
      await f.close();
      await old.close();
    }
  });
  it("answers a channel's close with the runtime's own close code, and 1006 when none comes", async () => {
    const f = await fixture();
    const silent = new Set<string>();
    f.sockets.on("connection", (socket, request) => {
      socket.send(JSON.stringify({ type: "browser.attached" }));
      // A runtime that never reads the close: it neither answers nor ends the channel.
      if (silent.size && request.headers["x-opensteer-browser-bridge-token"])
        (socket as unknown as { _socket: { pause(): void } })._socket.pause();
    });
    const sink = { onClosed() {}, onFrame() {}, onServerMessage() {} };
    try {
      const taken = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
      await f.bridge.attach(taken, "abc.def.ghi", sink);
      await expect(f.bridge.closeWithReceipt(taken, 5_000)).resolves.toBe(1000);
      // A channel the bridge no longer holds is lost, never cleanly closed.
      await expect(f.bridge.closeWithReceipt(taken, 5_000)).resolves.toBe(1006);
      silent.add("next");
      const unanswered = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
      await f.bridge.attach(unanswered, "abc.def.ghi", sink);
      await expect(f.bridge.closeWithReceipt(unanswered, 300)).resolves.toBe(1006);
    } finally {
      await f.close();
    }
  });

  it("opens local relay channel 33", async () => {
    const f = await fixture();
    f.sockets.on("connection", (socket) =>
      socket.send(JSON.stringify({ type: "browser.attached" })),
    );
    try {
      for (let index = 0; index < 33; index++)
        await expect(
          f.bridge.attach(BrowserChannelIdSchema.parse(`bch_${randomUUID()}`), "abc.def.ghi", {
            onClosed() {},
            onFrame() {},
            onServerMessage() {},
          }),
        ).resolves.toEqual({ type: "browser.attached" });
      expect(f.sockets.clients.size).toBe(33);
    } finally {
      await f.close();
    }
  });

  it("waits for page readiness rather than the transport upgrade", async () => {
    const f = await fixture();
    const held = gate({ label: "runtime initial page", deadlineMs: 2000 });
    const initialPage = {
      operationKey: "first-open",
      surfaceId: BrowserSurfaceIdSchema.parse(`bsf_${randomUUID()}`),
      navigation: "submitted",
    };
    f.sockets.once("connection", (socket) => {
      void held
        .enter()
        .then(() => socket.send(JSON.stringify({ type: "browser.attached", initialPage })))
        .catch(() => undefined);
    });
    let attached = false;
    const operation = f.bridge
      .attach(BrowserChannelIdSchema.parse(`bch_${randomUUID()}`), "abc.def.ghi", {
        onClosed() {},
        onFrame() {},
        onServerMessage() {},
      })
      .then((result) => {
        attached = true;
        return result;
      });
    try {
      await held.entered;
      expect(attached).toBe(false);
      held.release();
      expect(
        await withTimeout(operation, 2000, {
          timeoutError: () => new Error("bridge never reported readiness"),
        }),
      ).toEqual({ type: "browser.attached", initialPage });
    } finally {
      held.release();
      await operation.catch(() => undefined);
      await f.close();
    }
  });
  it("relays the runtime's own refusal before attachment and keeps transport failures generic", async () => {
    const f = await fixture();
    const error = {
      code: "conflict",
      message: "Browser Session open-1 could not initialize (profile-state).",
      reason: "session-start.profile-state",
      retryable: false,
    } as const;
    f.sockets.once("connection", (socket) => {
      socket.send(JSON.stringify({ type: "browser.error", error }));
      f.sockets.once("connection", (next) => next.close(1011, "runtime stopped"));
    });
    const sink = { onClosed() {}, onFrame() {}, onServerMessage() {} };
    try {
      await expect(
        f.bridge.attach(BrowserChannelIdSchema.parse(`bch_${randomUUID()}`), "abc.def.ghi", sink),
      ).rejects.toMatchObject({ message: error.message, runtimeError: error });
      await expect(
        f.bridge.attach(BrowserChannelIdSchema.parse(`bch_${randomUUID()}`), "abc.def.ghi", sink),
      ).rejects.toMatchObject({
        message: "The local browser runtime rejected the relay.",
        retryable: true,
        runtimeError: undefined,
      });
    } finally {
      await f.close();
    }
  });
  it("reads the runtime's health projection without mistaking additive facts for failure", async () => {
    const f = await fixture();
    try {
      expect(await f.bridge.health()).toMatchObject({
        runtimeId: "runtime_test",
        sessionId: null,
        state: "ready",
        detail: null,
      });
    } finally {
      await f.close();
    }
  });
});
