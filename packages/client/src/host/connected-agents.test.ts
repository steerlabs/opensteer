import { controlledClientSession } from "../test-support/client-connection.js";
import { UserIdSchema } from "@opensteer/core";
import type { AgentConnection } from "@opensteer/protocol";
import { MockHostClient } from "../mock/mock-host-client.js";
import { describe, expect, it, vi } from "vitest";
import {
  answerAgentConnection,
  ConnectedAgentsClient,
  createDedicatedProfile,
  externalAgentAddresses,
} from "./connected-agents.js";
import { unwrapRpcResult } from "./host-session-client.js";

function connectionFixture(): AgentConnection {
  return {
    id: `mcn_${crypto.randomUUID()}`,
    userId: UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001"),
    label: "My agent",
    clientName: "Example",
    accessMode: "approval-required",

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
    const host = new MockHostClient({
      latencyMs: 0,
      connections: [row],
      agentGrantsAvailable: false,
    });
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
      connection: controlledClientSession().connection,
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
        expect(resource.getSnapshot().issue).toMatchObject({ code: "read-failed" }),
      );
      expect(resource.getSnapshot().connections).toBeNull();
    } finally {
      stop();
      host.dispose();
    }
  });
  it("fences an old list response after revocation and disposes pending reads", async () => {
    const row = connectionFixture();
    const host = new MockHostClient({
      latencyMs: 0,
      connections: [row],
      agentGrantsAvailable: false,
    });
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
      await vi.waitFor(() =>
        expect(resolve, "the admitted list read never started").toBeTypeOf("function"),
      );
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
});

function grantedFixture(patch: Partial<AgentConnection> = {}): AgentConnection {
  return {
    ...connectionFixture(),
    grant: { scope: "selected", tasks: false, resources: [] },
    grantRevision: 1,
    consentVersion: 2,
    client: { fingerprint: null, redirectOrigin: "https://grok.com" },
    state: "active",
    lastActionUncertain: false,
    revokedAt: null,
    ...patch,
  };
}

describe("Connected agents with grants (agent-grants-v1)", () => {
  it("lists ended connections only from a Home that keeps their outcome", async () => {
    const stopped = grantedFixture({ state: "stopped", revokedAt: new Date().toISOString() });
    for (const grants of [true, false]) {
      const host = new MockHostClient({
        latencyMs: 0,
        connections: [stopped],
        agentGrantsAvailable: grants,
      });
      const list = vi.fn(host.rpc["connections.list"]);
      Object.defineProperty(host.rpc, "connections.list", { value: list, configurable: true });
      const resource = new ConnectedAgentsClient(host);
      const stop = resource.start();
      try {
        await vi.waitFor(() => expect(resource.getSnapshot().connections).not.toBeNull());
        expect(list).toHaveBeenCalledWith(
          grants ? { includeRevoked: true } : {},
          expect.anything(),
        );
        expect(resource.getSnapshot().grantsAvailable).toBe(grants);
        expect(resource.getSnapshot().connections).toEqual(grants ? [stopped] : []);
      } finally {
        stop();
        host.dispose();
      }
    }
  });

  it("saves an edit against its revision, and reads again after a stale one", async () => {
    const row = grantedFixture();
    const host = new MockHostClient({ latencyMs: 0, connections: [row] });
    const resource = new ConnectedAgentsClient(host);
    const stop = resource.start();
    try {
      await vi.waitFor(() => expect(resource.getSnapshot().connections).toHaveLength(1));
      const grant = { scope: "selected" as const, tasks: true, resources: [] };
      const saved = await resource.update(row.id, {
        expectedRevision: 1,
        grant,
        accessMode: "auto",
      });
      expect(saved).toMatchObject({
        kind: "saved",
        connection: { grantRevision: 2, accessMode: "auto", grant },
      });
      expect(resource.getSnapshot().connections?.[0]).toMatchObject({ grantRevision: 2 });
      const stale = await resource.update(row.id, {
        expectedRevision: 1,
        accessMode: "full-access",
      });
      expect(stale).toEqual({ kind: "conflict" });
      expect(resource.getSnapshot().conflict).toBe(row.id);
      expect(resource.getSnapshot().issue).toBeNull();
      await vi.waitFor(() =>
        expect(resource.getSnapshot().connections?.[0]).toMatchObject({ accessMode: "auto" }),
      );
      resource.dismiss();
      expect(resource.getSnapshot().conflict).toBeNull();
    } finally {
      stop();
      host.dispose();
    }
  });

  it("says Revoked the moment the Home confirms, then what the list reports, then removes it", async () => {
    const row = grantedFixture();
    const host = new MockHostClient({ latencyMs: 0, connections: [row] });
    const held: (() => void)[] = [];
    const list = host.rpc["connections.list"];
    const resource = new ConnectedAgentsClient(host);
    const stop = resource.start();
    try {
      await vi.waitFor(() => expect(resource.getSnapshot().connections).toHaveLength(1));
      Object.defineProperty(host.rpc, "connections.list", {
        value: vi.fn(
          (...args: Parameters<typeof list>) =>
            new Promise((done) => {
              held.push(() => done(list(...args)));
            }),
        ),
        configurable: true,
      });
      await resource.revoke(row.id);
      expect(resource.getSnapshot().revoked.has(row.id)).toBe(true);
      await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
      Object.defineProperty(host.rpc, "connections.list", { value: list, configurable: true });
      for (const release of held) release();
      await vi.waitFor(() =>
        expect(resource.getSnapshot().connections?.[0]).toMatchObject({ state: "stopped" }),
      );
      expect(resource.getSnapshot().revoked.size).toBe(0);
      const dispatch = vi.spyOn(host, "dispatch");
      await resource.remove(row.id);
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "connection.remove", connectionId: row.id }),
      );
      await vi.waitFor(() => expect(resource.getSnapshot().connections).toEqual([]));
    } finally {
      stop();
      host.dispose();
    }
  });

  it("sends the chosen grant with an approval, and only to a Home that takes it", async () => {
    const host = new MockHostClient({
      latencyMs: 0,
      connectionConsent: {
        requestId: "r".repeat(43),
        clientName: "Grok",
        redirectUri: "https://grok.com/cb",
        resource: "https://host.test/internal/v1/mcp",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    try {
      const dispatch = vi.spyOn(host, "dispatch");
      const profileId = await createDedicatedProfile(host, { name: "Grok", homeRunnerId: null });
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "browser.profile.create", input: { name: "Grok" } }),
      );
      const consent = unwrapRpcResult(
        await host.rpc["connections.authorization.get"]({ requestId: "r".repeat(43) }),
      );
      const grant = {
        scope: "selected" as const,
        tasks: false,
        resources: [{ kind: "browser-profile" as const, profileId: profileId as never }],
      };
      await answerAgentConnection(host, consent, {
        kind: "approve",
        label: "Grok",
        accessMode: "approval-required",
        grant,
      });
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "connection.authorize",
          decision: { kind: "approve", label: "Grok", accessMode: "approval-required", grant },
        }),
      );
      const [connection] = unwrapRpcResult(await host.rpc["connections.list"]({})).connections;
      expect(connection?.grant).toEqual(grant);
    } finally {
      host.dispose();
    }
  });
});
