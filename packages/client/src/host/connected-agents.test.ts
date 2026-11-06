import { UserIdSchema } from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import { describe, expect, it, vi } from "vitest";
import { ConnectedAgentsClient, externalAgentAddresses } from "./connected-agents.js";
import { unwrapRpcResult } from "./host-session-client.js";

function connectionFixture(): AgentConnection {
  return {
    id: `mcn_${crypto.randomUUID()}`,
    userId: UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001"),
    label: "My agent",
    clientName: "Example",
    accessMode: "approval-required",
    reach: { kind: "user" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastUsedAt: null,
  };
}
describe("Settings connected agents", () => {
  it("forgets the owner’s list synchronously on sign-out", async () => {
    const row = connectionFixture();
    const host = new MockHostClient({ latencyMs: 0, connections: [row] });
    const resource = new ConnectedAgentsClient(host);
    const stop = resource.start();
    try {
      await vi.waitFor(() => expect(resource.getSnapshot().connections).toEqual([row]));
      await host.rpc["auth.signOut"]({});
      expect(resource.getSnapshot().connections).toBeNull();
    } finally {
      stop();
      host.dispose();
    }
  });
  it("mock consent creates one owned record per approval and supports list and revoke", async () => {
    const host = new MockHostClient({
      latencyMs: 0,
      connectionConsent: {
        requestId: "r".repeat(43),
        clientName: "Example",
        redirectUri: "https://example.test/cb",
        resource: "https://host.test/internal/v1/mcp",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        workspaces: [],
      },
    });
    try {
      const consent = unwrapRpcResult(
        await host.rpc["connections.authorization.get"]({ requestId: "r".repeat(43) }),
      );
      const command = {
        type: "connection.authorize" as const,
        requestId: consent.requestId,
        idempotencyKey: "approve",
        decision: {
          kind: "approve" as const,
          label: "My agent",
          accessMode: "auto" as const,
          reach: { kind: "user" as const },
        },
      };
      await host.dispatch(command);
      await host.dispatch({ ...command, idempotencyKey: "second" });
      const connections = unwrapRpcResult(await host.rpc["connections.list"]({})).connections;
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({
        userId: host.getSnapshot().user!.id,
        accessMode: "auto",
      });
      await host.dispatch({
        type: "connection.revoke",
        connectionId: connections[0]!.id,
        idempotencyKey: "revoke",
      });
      expect(unwrapRpcResult(await host.rpc["connections.list"]({})).connections).toEqual([]);
    } finally {
      host.dispose();
    }
  });
  it("adds no construction or attach reads; lists only when observed and revokes through commands", async () => {
    const row = connectionFixture();
    const host = new MockHostClient({ latencyMs: 0, connections: [row] });
    const rpc = vi.fn(host.rpc["connections.list"]);
    Object.defineProperty(host.rpc, "connections.list", { value: rpc, configurable: true });
    const dispatch = vi.spyOn(host, "dispatch");
    const resource = new ConnectedAgentsClient(host);
    expect(rpc).not.toHaveBeenCalled();
    const stop = resource.start();
    try {
      await vi.waitFor(() => expect(resource.getSnapshot().connections).toEqual([row]));
      await resource.revoke(row.id);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "connection.revoke", connectionId: row.id }),
      );
      expect(resource.getSnapshot().connections).toEqual([]);
      expect(unwrapRpcResult(await host.rpc["connections.list"]({})).connections).toEqual([]);
      await host.dispatch({
        type: "connection.revoke",
        connectionId: row.id,
        idempotencyKey: "repeat",
      });
      expect(unwrapRpcResult(await host.rpc["connections.list"]({})).connections).toEqual([]);
    } finally {
      stop();
      host.dispose();
    }
  });
  it("shows a connection approved and revoked on another device without reconnecting", async () => {
    const row = connectionFixture();
    let listed: AgentConnection[] = [];
    let changed: (() => void) | undefined;
    const list = vi.fn(async () => ({ ok: true as const, data: { connections: listed } }));
    const snapshot = {
      connection: "connected" as const,
      session: "authenticated" as const,
      user: { id: row.userId },
    };
    const host = {
      rpc: { "connections.list": list },
      dispatch: vi.fn(),
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      subscribeConnectionsChanged: (listener: () => void) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    } as unknown as ConstructorParameters<typeof ConnectedAgentsClient>[0];
    const resource = new ConnectedAgentsClient(host);
    const stop = resource.start();
    try {
      await vi.waitFor(() => expect(resource.getSnapshot().connections).toEqual([]));
      listed = [row];
      changed?.();
      await vi.waitFor(() => expect(resource.getSnapshot().connections).toEqual([row]));
      listed = [];
      changed?.();
      await vi.waitFor(() => expect(resource.getSnapshot().connections).toEqual([]));
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
    expect(changed).toBeUndefined();
  });
  it("shows a failed list read without claiming there are no connections", async () => {
    const host = new MockHostClient({ latencyMs: 0 });
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn().mockRejectedValue(new Error("unreachable")),
      configurable: true,
    });
    const resource = new ConnectedAgentsClient(host);
    const stop = resource.start();
    try {
      await vi.waitFor(() =>
        expect(resource.getSnapshot().error).toBe("Connected agents could not be loaded."),
      );
      expect(resource.getSnapshot().connections).toBeNull();
    } finally {
      stop();
      host.dispose();
    }
  });
  it("fences an old list response after revocation and disposes pending reads", async () => {
    const row = connectionFixture();
    const host = new MockHostClient({ latencyMs: 0, connections: [row] });
    let resolve:
      ((value: Awaited<ReturnType<(typeof host.rpc)["connections.list"]>>) => void) | undefined;
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((done) => {
              resolve = done;
            }),
        )
        .mockImplementation(host.rpc["connections.list"]),
      configurable: true,
    });
    const resource = new ConnectedAgentsClient(host);
    const stop = resource.start();
    try {
      await resource.revoke(row.id);
      resolve?.({ ok: true, data: { connections: [row] } });
      await resource.refresh();
      expect(resource.getSnapshot().connections).toEqual([]);
      stop();
      const snapshot = resource.getSnapshot();
      await resource.refresh();
      expect(resource.getSnapshot()).toBe(snapshot);
    } finally {
      stop();
      host.dispose();
    }
  });
});

describe("external agent addresses", () => {
  // The Host accepts only these origins, so a wrong one fails sign-in.
  const personal = { exposure: "loopback", publicOrigin: "http://127.0.0.1:4310" } as const;
  it.each([
    [personal, null, null],
    [personal, { mode: "off", origin: null }, null],
    [
      personal,
      { mode: "connect", origin: "https://mac.connect.example" },
      { url: "https://mac.connect.example/internal/v1/mcp", reach: "internet" },
    ],
    [
      personal,
      { mode: "private", origin: "https://mac.tailnet.example" },
      { url: "https://mac.tailnet.example/internal/v1/mcp", reach: "private-network" },
    ],
  ] as const)("Personal %#", (identity, remoteAccess, remote) => {
    expect(externalAgentAddresses({ identity, remoteAccess })).toEqual({
      remote,
      thisComputer: "http://127.0.0.1:4310/internal/v1/mcp",
    });
  });
  it("a networked Host is reached at its own origin", () => {
    expect(
      externalAgentAddresses({
        identity: { exposure: "networked", publicOrigin: "https://steer.example" },
        remoteAccess: null,
      }),
    ).toEqual({
      remote: { url: "https://steer.example/internal/v1/mcp", reach: "internet" },
      thisComputer: null,
    });
  });
});
