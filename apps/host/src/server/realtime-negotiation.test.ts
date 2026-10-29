import { createId, zeroSequence } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  HostToClientMessageSchema,
  unsupportedVersionCloseCode,
  type HostToClientMessage,
} from "@opensteer/protocol";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { createHostServer, type HostServerDependencies } from "../server.js";
import { signHostDiscovery } from "../identity/host-keys.js";
import { hostServerTestDependencies } from "./host-server-test-harness.js";

const testDiscovery = signHostDiscovery(generateKeyPairSync("ed25519"), {
  canonicalOrigin: "https://opensteer.example",
  deploymentId: createId("deployment"),
  deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
  hostInstanceId: createId("hostInstance"),
  hostKey: { algorithm: "Ed25519" },
});

/**
 * The realtime half of version negotiation, exercised over a real socket: the
 * refusal is a frame and a close code, neither of which `app.inject` can carry.
 */
describe("realtime version negotiation", () => {
  it("projects the Host's realtime output through its declared schema", async () => {
    const { close, socket } = await realtimeSocket(async ({ sink, workspaceId }) => {
      await sink.send({
        type: "host.synchronized",
        workspaceId,
        sequence: zeroSequence,
        internalOnly: "PRIVATE-HOST-VALUE",
      } as unknown as HostToClientMessage);
      return () => undefined;
    });
    try {
      const frame = new Promise<string>((resolve) =>
        socket.once("message", (value) => resolve(value.toString())),
      );
      socket.send(
        JSON.stringify({
          type: "client.subscribe",
          apiVersion: hostApiVersion,
          workspaceId: createId("workspace"),
          threadId: null,
          afterSequence: zeroSequence,
        }),
      );
      expect(await frame).not.toContain("PRIVATE-HOST-VALUE");
    } finally {
      await close();
    }
  });

  it("refuses invalid publisher output before it reaches a reader", async () => {
    const { close, socket } = await realtimeSocket(async ({ sink }) => {
      await sink.send({
        type: "host.events",
        events: [{ type: "run.started", data: { status: "PRIVATE-INVALID-STATUS" } }],
      } as unknown as HostToClientMessage);
      return () => undefined;
    });
    try {
      const frame = new Promise<string>((resolve) =>
        socket.once("message", (value) => resolve(value.toString())),
      );
      socket.send(
        JSON.stringify({
          type: "client.subscribe",
          apiVersion: hostApiVersion,
          workspaceId: createId("workspace"),
          threadId: null,
          afterSequence: zeroSequence,
        }),
      );
      const refusal = JSON.parse(await frame);
      expect(refusal).toMatchObject({
        type: "host.error",
        error: { retryable: false, reason: "invalid-realtime-publication" },
      });
      expect(JSON.stringify(refusal)).not.toContain("PRIVATE-INVALID-STATUS");
    } finally {
      await close();
    }
  });
  it("refuses a subscription on another epoch with a final close, before subscribing", async () => {
    const subscribe = vi.fn();
    const { close, socket } = await realtimeSocket(subscribe);
    try {
      socket.send(
        JSON.stringify({
          afterSequence: zeroSequence,
          apiVersion: hostApiVersion + 1,
          threadId: null,
          type: "client.subscribe",
          workspaceId: createId("workspace"),
        }),
      );

      const refusal = await nextMessage(socket);
      expect(refusal).toEqual({
        error: {
          code: "bad_message",
          message: `This deployment speaks Opensteer protocol ${hostApiVersion}.`,
          reason: "unsupported-version",
          retryable: false,
        },
        type: "host.error",
      });
      expect(await closedWith(socket)).toBe(unsupportedVersionCloseCode);
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("subscribes a client that states this tree's epoch", async () => {
    const subscribe = vi.fn(async () => () => undefined);
    const { close, socket } = await realtimeSocket(subscribe);
    const workspaceId = createId("workspace");
    try {
      socket.send(
        JSON.stringify({
          afterSequence: zeroSequence,
          apiVersion: hostApiVersion,
          threadId: null,
          type: "client.subscribe",
          workspaceId,
        }),
      );
      // The ping round trip proves the subscribe frame was fully processed
      // rather than merely not refused yet.
      socket.send(JSON.stringify({ nonce: "negotiated", type: "client.ping" }));

      expect(await nextMessage(socket)).toEqual({ nonce: "negotiated", type: "host.pong" });
      expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    } finally {
      await close();
    }
  });
});

async function realtimeSocket(
  subscribe: HostServerDependencies["realtime"]["subscribe"],
): Promise<{ readonly close: () => Promise<void>; readonly socket: WebSocket }> {
  const userId = createId("user");
  const app = await createHostServer(
    hostServerTestDependencies({
      authenticator: {
        authenticateSession: async () => ({
          absoluteExpiresAt: "2099-09-15T00:00:00.000Z",
          createdAt: "2026-09-15T00:00:00.000Z",
          expiresAt: "2099-09-15T00:00:00.000Z",
          id: createId("authSession"),
          user: {
            disabledAt: null,
            displayName: "Owner",
            email: "owner@example.com",
            emailVerified: true,
            id: userId,
            image: null,
            instanceRole: "administrator",
          },
        }),
        identity: {
          configuration: async () => ({ localPasswordEnabled: true, oidcProviders: [] }),
          nativeOpenIdConfiguration: () => undefined,
        },
      } as never,
      discovery: testDiscovery,
      realtime: {
        broadcast: () => undefined,
        registerConnection: () => () => undefined,
        subscribe,
      } as never,
      workspaces: {} as never,
    }),
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    close: async () => {
      socket.close();
      await app.close();
    },
    socket,
  };
}

function nextMessage(socket: WebSocket): Promise<HostToClientMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (frame) => {
      try {
        resolve(HostToClientMessageSchema.parse(JSON.parse(frame.toString())));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Unreadable Host frame"));
      }
    });
  });
}

function closedWith(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}
