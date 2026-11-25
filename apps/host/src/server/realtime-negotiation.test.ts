import { createId } from "@opensteer/core";
import {
  apiVersionHeaders,
  hostApiVersion,
  hostApiCurrentHeader,
  hostApiVersionHeader,
} from "@opensteer/deployment-authority";
import { unsupportedVersionCloseCode } from "@opensteer/protocol";
import { RealtimeHub } from "@opensteer/orchestration";
import { ScopedHostMessageSchema } from "@opensteer/protocol/personal-sync";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { signHostDiscovery } from "../identity/host-keys.js";
import { createHostServer, type HostServerDependencies } from "../server.js";
import { hostServerTestDependencies } from "./host-server-test-harness.js";

const readCut = vi.hoisted(() => vi.fn());
vi.mock(import("./personal-reads.js"), async (original) => {
  const { createPersonalReads } = await original();
  return {
    createPersonalReads: (...args: Parameters<typeof createPersonalReads>) => ({
      ...createPersonalReads(...args),
      readCut,
    }),
  };
});

const deploymentId = createId("deployment");
const ownerId = createId("user");
const epoch = randomUUID();
const discovery = signHostDiscovery(generateKeyPairSync("ed25519"), {
  canonicalOrigin: "https://opensteer.example",
  deploymentId,
  deploymentShape: { kind: "personal" },
  hostInstanceId: createId("hostInstance"),
  hostKey: { algorithm: "Ed25519" },
});
const shellCursor = {
  deploymentId,
  epoch,
  viewerId: ownerId,
  scopeKey: "shell",
  afterSequence: "0",
};
const attach = {
  type: "client.attach",
  apiVersion: hostApiVersion,
  generation: 1,
  interests: [],
  installed: {},
};

describe("personal realtime negotiation", () => {
  it.each([63, 62])(
    "instructs a v%i realtime caller to update before reading any Personal state",
    async (version) => {
      readCut.mockClear();
      await using peer = await realtimeSocket();
      const closed = once(peer.socket, "close");
      peer.socket.send(JSON.stringify({ ...attach, apiVersion: version }));
      const [code, reason] = await deadline(closed);
      expect(code).toBe(unsupportedVersionCloseCode);
      expect(String(reason)).toContain("Update Opensteer");
      expect(readCut).not.toHaveBeenCalled();
    },
  );

  it("rejects main's v63 version headers before attaching", async () => {
    readCut.mockClear();
    await using peer = await realtimeSocket();
    const response = await peer.app.inject({
      method: "GET",
      url: "/v1/realtime",
      headers: { [hostApiVersionHeader]: "63", [hostApiCurrentHeader]: "63" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        reason: "unsupported-version",
        message: expect.stringContaining("Update Opensteer"),
      },
    });
    expect(readCut).not.toHaveBeenCalled();
  });

  it("passes the current version's resume cursor to the scoped reader", async () => {
    const cursor = { ...shellCursor, afterSequence: "41" };
    readCut.mockReset().mockResolvedValue({ throughSequence: "41", cursor, frames: [] });
    await using peer = await realtimeSocket();
    const message = once(peer.socket, "message");
    peer.socket.send(JSON.stringify({ ...attach, cursor }));
    const [raw] = await deadline(message);
    expect(ScopedHostMessageSchema.parse(JSON.parse(String(raw)))).toEqual({
      type: "host.synchronized",
      generation: 1,
      subscriptionId: "shell",
      throughSequence: "41",
      scope: { kind: "shell" },
    });
    expect(readCut).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ user: expect.objectContaining({ id: ownerId }) }),
      "canonical",
      { kind: "shell" },
      cursor,
      undefined,
      undefined,
      expect.objectContaining({ atLeast: expect.any(String) }),
      false,
    );
  });

  it("rejects an oversized input while the scoped read is pending", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    readCut.mockReset().mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { throughSequence: "0", cursor: shellCursor, frames: [] };
    });
    await using peer = await realtimeSocket();
    try {
      peer.socket.send(JSON.stringify(attach));
      await deadline(entered.promise);
      const closed = once(peer.socket, "close");
      peer.socket.send(JSON.stringify({ type: "client.ping", nonce: "x".repeat(32 * 1024) }));
      await expect(deadline(closed)).resolves.toEqual([1009, expect.any(Buffer)]);
    } finally {
      release.resolve();
    }
  });
});

const deadline = <T>(pending: Promise<T>) =>
  withTimeout(pending, 2_000, {
    timeoutError: () => new Error("Personal realtime did not respond"),
  });

async function realtimeSocket() {
  const app = await createHostServer(
    hostServerTestDependencies({
      authenticator: {
        authenticateSessionContext: async () => ({
          credentialKind: "browser-cookie",
          surface: "canonical",
          session: {
            absoluteExpiresAt: "2099-09-15T00:00:00.000Z",
            createdAt: "2026-09-15T00:00:00.000Z",
            expiresAt: "2099-09-15T00:00:00.000Z",
            id: createId("authSession"),
            user: {
              disabledAt: null,
              displayName: "Owner",
              email: "owner@example.com",
              emailVerified: true,
              id: ownerId,
              image: null,
            },
          },
        }),
        identity: {
          configuration: async () => ({ localPasswordEnabled: true, oidcProviders: [] }),
          nativeOpenIdConfiguration: () => undefined,
        },
      } as unknown as HostServerDependencies["authenticator"],
      discovery,
      store: { recordHarnessCatalogs: vi.fn() } as unknown as HostServerDependencies["store"],
      realtime: new RealtimeHub(),
    }),
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`, {
    headers: apiVersionHeaders("personal"),
  });
  try {
    await deadline(once(socket, "open"));
  } catch (error) {
    socket.terminate();
    await app.close();
    throw error;
  }
  return {
    app,
    socket,
    async [Symbol.asyncDispose]() {
      socket.terminate();
      await app.close();
    },
  };
}
