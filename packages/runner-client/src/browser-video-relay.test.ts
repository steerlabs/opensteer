import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  createBrowserSessionId,
  encodeBrowserVideoFrame,
  RunnerAuxiliaryFrameFenceSchema,
} from "@opensteer/protocol";
import {
  BrowserChannelIdSchema,
  browserLocalVideoOperation,
  type BrowserVideoOperation,
} from "@opensteer/protocol/browser-relay";
import { browserVideoTestHeader } from "@opensteer/protocol/test-support/browser-video";
import { BrowserVideoRelay } from "./browser-video-relay.js";
import { LocalBrowserRuntimeBridge } from "./browser-bridge.js";

describe("independent browser media relay", () => {
  it("waits for Host admission and can stop while a start/control answer and media admission are pending", async () => {
    const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const native = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const sockets: WebSocket[] = [];
    let relay: BrowserVideoRelay | undefined;
    const gate = Promise.withResolvers<void>();
    try {
      await Promise.all([once(host, "listening"), once(native, "listening")]);
      const hostAddress = host.address();
      const nativeAddress = native.address();
      if (
        typeof hostAddress === "string" ||
        !hostAddress ||
        typeof nativeAddress === "string" ||
        !nativeAddress
      )
        throw new Error("Missing test listeners");
      const target = {
        kind: "browser-tab" as const,
        sessionId: createBrowserSessionId(),
        surfaceId: "tab" as import("@opensteer/core").BrowserSurfaceId,
      };
      const operation: Extract<BrowserVideoOperation, { type: "browser.video.start" }> = {
        ...RunnerAuxiliaryFrameFenceSchema.parse({
          runnerId: `rnr_${randomUUID()}`,
          auxiliaryStreamId: `rax_${randomUUID()}`,
          bootId: `rbt_${randomUUID()}`,
          connectionGeneration: 1,
          connectionId: `rcn_${randomUUID()}`,
          connectionLeaseId: `rls_${randomUUID()}`,
          module: "browser",
        }),
        module: "browser",
        capability: {
          runtimeId: "fixture",
          capabilityGeneration: 1,
          capabilityLeaseId:
            `bcl_${randomUUID()}` as import("@opensteer/protocol/browser-relay").BrowserCapabilityReference["capabilityLeaseId"],
        },
        channelId: BrowserChannelIdSchema.parse(`bch_${randomUUID()}`),
        target,
        streamId: browserVideoTestHeader.streamId,
        type: "browser.video.start",
        dataTicket: "private-ticket",
        budget: { maxWidth: 128, maxHeight: 128, maxFps: 15, maxBitrate: 500000 },
        creditWindow: 2,
        timeoutMs: 3000,
      };
      expect(browserLocalVideoOperation(operation)).not.toHaveProperty("dataTicket");
      expect(browserLocalVideoOperation(operation)).not.toHaveProperty("capability");
      const hostFrames: Buffer[] = [];
      const sourceCredits: unknown[] = [];
      let upstream: WebSocket | null = null;
      let producer: WebSocket | null = null;
      host.on("connection", (socket) => {
        sockets.push(socket);
        upstream = socket;
        socket.on("message", (raw) => hostFrames.push(Buffer.from(raw as Buffer)));
      });
      native.on("connection", (socket) => {
        sockets.push(socket);
        producer = socket;
        socket.on("message", (raw) => sourceCredits.push(JSON.parse(String(raw))));
      });
      const bridge = new LocalBrowserRuntimeBridge({
        bridgeToken: "x".repeat(64),
        runtimeId: "fixture",
        url: new URL(`http://127.0.0.1:${nativeAddress.port}`),
      });
      vi.spyOn(bridge, "openVideo").mockImplementation(async () => {
        const socket = new WebSocket(`ws://127.0.0.1:${nativeAddress.port}`);
        sockets.push(socket);
        await once(socket, "open", { signal: AbortSignal.timeout(1000) });
        return socket;
      });
      const send = vi.spyOn(bridge, "sendVideo").mockImplementation(async (message) => {
        if (message.type === "browser.video.start") await gate.promise;
      });
      relay = new BrowserVideoRelay(
        bridge,
        { mode: "development", hostOrigin: new URL(`http://127.0.0.1:${hostAddress.port}`) },
        vi.fn(),
      );
      relay.handle(operation);
      await vi.waitFor(
        () =>
          expect(send, "producer start submitted").toHaveBeenCalledWith(
            expect.objectContaining({ ...operation, timeoutMs: expect.any(Number) }),
          ),
        { timeout: 2000 },
      );
      const bytes = (sequence: number) =>
        encodeBrowserVideoFrame(
          { ...browserVideoTestHeader, sequence, ptsUs: sequence + 1 },
          new Uint8Array([0, 0, 0, 1, 0x65]),
        );
      const producerSocket = producer as unknown as WebSocket;
      const hostSocket = upstream as unknown as WebSocket;
      producerSocket.send(bytes(0));
      await vi.waitFor(() => expect(hostFrames, "AU reached Host").toHaveLength(1), {
        timeout: 1000,
      });
      expect(sourceCredits).toHaveLength(0);
      hostSocket.send(
        JSON.stringify({
          type: "video.ack",
          streamId: operation.streamId,
          sequence: 0,
          retainFor: [],
        }),
      );
      await vi.waitFor(
        () => expect(sourceCredits, "Host admission returned source credit").toHaveLength(1),
        { timeout: 1000 },
      );
      producerSocket.send(bytes(1));
      await vi.waitFor(() => expect(hostFrames, "second AU waiting on Host").toHaveLength(2), {
        timeout: 1000,
      });
      const {
        dataTicket: _ticket,
        budget: _budget,
        creditWindow: _credit,
        timeoutMs: _timeout,
        ...binding
      } = operation;
      relay.handle({ ...binding, type: "browser.video.stop" });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "browser.video.stop" }));
      expect(sourceCredits).toHaveLength(1);
      gate.resolve();
    } finally {
      gate.resolve();
      relay?.close();
      for (const socket of sockets) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => host.close(() => resolve())),
        new Promise<void>((resolve) => native.close(() => resolve())),
      ]);
    }
  });
});
