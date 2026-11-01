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
