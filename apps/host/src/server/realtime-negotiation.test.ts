import { withTimeout } from "@opensteer/shared/withTimeout";
import { createId, DeclinedRequestSchema, SequenceSchema, zeroSequence } from "@opensteer/core";
import { apiVersionQueryParameter, hostApiVersion } from "@opensteer/deployment-authority";
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
  deploymentShape: { kind: "personal" },
  hostInstanceId: createId("hostInstance"),
  hostKey: { algorithm: "Ed25519" },
});

/**
 * The realtime half of version negotiation, exercised over a real socket: the
 * refusal is a frame and a close code, neither of which `app.inject` can carry.
 */
describe("realtime version negotiation", () => {
  it("projects the Host's realtime output through its declared schema", async () => {
    const { close, socket } = await realtimeSocket(async ({ sink, deploymentId }) => {
      await sink.send({
        type: "host.synchronized",
        deploymentId,
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
          cursor: {
            deploymentId: testDiscovery.document.deploymentId,
            apiVersion: hostApiVersion,
            afterSequence: zeroSequence,
          },
          threadId: null,
        }),
      );
      expect(await frame).not.toContain("PRIVATE-HOST-VALUE");
    } finally {
      await close();
    }
  });

  it("keeps settlement sessions out of raw resolution subscription frames", async () => {
    const deploymentId = testDiscovery.document.deploymentId;
    const threadId = createId("thread");
    const ownerId = createId("user");
    const createdAt = new Date().toISOString();
    const request = DeclinedRequestSchema.parse({
      callId: "settlement-projection",
      id: createId("request"),
      createdAt,
      kind: "browser.access",
      mode: "durable",
      originatingOccurrenceId: null,
      originatingRunId: createId("run"),
      originatingThreadId: threadId,
      payload: {
        kind: "browser.access",
        reason: "Choose browser access",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        title: "Browser access",
        subject: { id: threadId, kind: "thread" },
      },
      requestedBy: ownerId,
      requiredActor: "requester",
      cancellationReason: null,
      resolvedAt: createdAt,
      resolvedBy: ownerId,
      status: "declined",
      response: { kind: "external", value: { decision: "declined" } },
      settlementProvenance: { sessionId: "PRIVATE-SETTLEMENT-SESSION", deviceLabel: "iPhone" },
    });
    const { close, socket } = await realtimeSocket(async ({ sink }) => {
      await sink.send({
        type: "host.events",
        throughSequence: SequenceSchema.parse("1"),
        events: [
          {
            createdAt,
            data: { request },
            environmentId: createId("environment"),
            eventId: createId("event"),
            runId: request.originatingRunId,
            sequence: SequenceSchema.parse("1"),
            threadId,
            type: "request.resolved",
          },
        ],
      });
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
          cursor: { deploymentId, apiVersion: hostApiVersion, afterSequence: zeroSequence },
          threadId,
        }),
      );
      const raw = await withTimeout(frame, 2_000, {
        timeoutError: () => new Error("Resolution event never reached the subscriber"),
      });
      expect(raw).not.toContain("PRIVATE-SETTLEMENT-SESSION");
      expect(JSON.parse(raw).events[0].data.request.settlementProvenance).toEqual({
        deviceLabel: "iPhone",
      });
    } finally {
      await close();
    }
  });

  it("refuses invalid publisher output before it reaches a reader", async () => {
    const { close, socket } = await realtimeSocket(async ({ sink }) => {
      await sink.send({
        type: "host.events",
        throughSequence: SequenceSchema.parse("1"),
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
          cursor: {
            deploymentId: testDiscovery.document.deploymentId,
            apiVersion: hostApiVersion,
            afterSequence: zeroSequence,
          },
          threadId: null,
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
          apiVersion: hostApiVersion + 1,
          threadId: null,
          type: "client.subscribe",
          cursor: {
            deploymentId: testDiscovery.document.deploymentId,
            apiVersion: hostApiVersion + 1,
            afterSequence: zeroSequence,
          },
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
    const deploymentId = testDiscovery.document.deploymentId;
    try {
      socket.send(
        JSON.stringify({
          apiVersion: hostApiVersion,
          threadId: null,
          type: "client.subscribe",
          cursor: { deploymentId, apiVersion: hostApiVersion, afterSequence: zeroSequence },
        }),
      );
      // The ping round trip proves the subscribe frame was fully processed
      // rather than merely not refused yet.
      socket.send(JSON.stringify({ nonce: "negotiated", type: "client.ping" }));

      expect(await nextMessage(socket)).toEqual({ nonce: "negotiated", type: "host.pong" });
      expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ deploymentId }));
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
    }),
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/v1/realtime?${apiVersionQueryParameter}=${hostApiVersion}`,
  );
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
