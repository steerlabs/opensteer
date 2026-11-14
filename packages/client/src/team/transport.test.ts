import { TeamEntryRefusalReasonSchema, type TeamEntryRefusalReason } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import {
  hostApiVersion,
  hostApiVersionHeader,
  teamApiVersion,
  teamApiVersionHeader,
} from "@opensteer/deployment-authority";
import { createHttpHostApiClient } from "../host/host-api-client.js";
import { mockTeamChannelId } from "./mock-team-host.js";
it("sends only the per-kind version for auth, bootstrap and commands during parallel attachments", async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json({
      ok: false,
      error: { code: "forbidden", message: "Test refusal", retryable: false },
    });
  };
  const personal = createHttpHostApiClient({
    baseUrl: new URL("https://personal.example"),
    fetch,
    onAuthenticationRequired: () => {},
  });
  const team = createHttpHostApiClient({
    baseUrl: new URL("https://team.example"),
    fetch,
    kind: "team",
    onAuthenticationRequired: () => {},
  });
  await Promise.all([
    personal["auth.config"]({}),
    team["auth.config"]({}),
    team["team.bootstrap.get"]({}),
    team["commands.dispatch"]({
      type: "team.channel.read",
      channelId: mockTeamChannelId,
      throughMessageId: "1",
    }),
  ]);
  expect(calls).toHaveLength(4);
  for (const call of calls) {
    if (call.url.startsWith("https://team.example")) {
      expect(call.headers.get(teamApiVersionHeader)).toBe(String(teamApiVersion));
      expect(call.headers.has(hostApiVersionHeader)).toBe(false);
    } else {
      expect(call.headers.get(hostApiVersionHeader)).toBe(String(hostApiVersion));
      expect(call.headers.has(teamApiVersionHeader)).toBe(false);
    }
  }
});
it("pins HTTP and WebSocket credentials and versions to the joined team while Personal stays selected", async () => {
  const { HostTransport } = await import("../connections/host-transport.js");
  const { DeploymentCatalogSchema, DeploymentConnectionSchema } =
    await import("../connections/deployment-catalog.js");
  const { signTestDiscoveryEnvelope, testHostAuthorityKeys } =
    await import("../test-support/host-authority.js");
  const { createId } = await import("@opensteer/core");
  const now = new Date().toISOString(),
    teamId = createId("deployment"),
    personalId = createId("deployment");
  const connection = (deploymentId: typeof teamId, kind: "personal" | "team") => {
    const origin = `https://${kind}.example`,
      keys = testHostAuthorityKeys();
    return DeploymentConnectionSchema.parse({
      authority: signTestDiscoveryEnvelope(
        {
          deploymentId,
          hostInstanceId: createId("hostInstance"),
          canonicalOrigin: origin,
          deploymentShape: { kind },
          hostKey: { algorithm: "Ed25519" },
        },
        keys,
      ),
      bootstrapMethods: ["password"],
      reachability: "canonical",
      endpoints: [{ kind: "canonical", origin, verifiedAt: now }],
      kind: kind === "team" ? "team" : "personal",
      preferredEndpointOrigin: null,
      source: { kind: "manual" },
      name: kind,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    });
  };
  const team = connection(teamId, "team"),
    personal = connection(personalId, "personal"),
    credentials: string[] = [],
    http: import("../connections/host-transport.js").HostNetworkRequest[] = [],
    sockets: Parameters<
      import("../connections/host-transport.js").HostNetwork["openWebSocket"]
    >[0][] = [];
  let token = "Bearer mock-session";
  let rejectCredentials = false;
  let recoveryOutcome:
    "recovered" | "unavailable" | "account-required" | "update-required" | TeamEntryRefusalReason =
    "recovered";
  const { TeamEntryRefusedError } = await import("../auth/native-oauth.js");
  const { HostSession } = await import("../auth/host-session.js");
  const { TeamEntryOutcomeError } = await import("./native-team-entry.js");
  const sessions: InstanceType<typeof HostSession>[] = [];
  const refresh = vi.fn(async () => {
    const reason = TeamEntryRefusalReasonSchema.safeParse(recoveryOutcome);
    if (reason.success) throw new TeamEntryRefusedError(reason.data, "Ask for an invite");
    if (recoveryOutcome === "update-required")
      throw new TeamEntryOutcomeError({ status: "update-required" });
    if (recoveryOutcome === "unavailable") throw new Error("Offline");
    if (recoveryOutcome === "account-required") return false;
    token = "Bearer refreshed";
    return true;
  });
  let socketEvents: import("../connections/host-transport.js").HostNetworkSocketEvents | undefined;
  const options: import("../connections/host-transport.js").HostTransportOptions & {
    deploymentId: typeof teamId;
  } = {
    deploymentId: teamId,
    expectedKind: "team",
    catalog: {
      load: async () =>
        DeploymentCatalogSchema.parse({
          deployments: [personal, team],
          selectedDeploymentId: personalId,
          revision: 1,
          schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
          updatedAt: now,
        }),
      subscribe: () => () => {},
    },
    localRuntime: { current: async () => null },
    credentials: {
      authorizationHeader: async (target) => {
        credentials.push(target.authority.document.deploymentId);
        return token;
      },
    },
    sessions: (attachment) => {
      const session = new HostSession({
        attachment,
        clearDeploymentSession: async () => undefined,
        exchange: {
          supports: () => false,
          probe: async () => "unauthenticated",
          establish: async () => {
            throw new Error("Unexpected exchange");
          },
        },
        localOwner: { ownsHostSession: () => false, recoverOwnerSession: async () => false },
        oauth: {
          recoverHostAuthorization: refresh,
          abandonHostSignIn: () => undefined,
          signInTeam: async () => {
            throw new Error("Unexpected sign-in");
          },
          hostCredentialState: () => {
            throw new Error("Unexpected state");
          },
          signOutHost: async () => {
            throw new Error("Unexpected sign-out");
          },
          subscribe: () => () => undefined,
          subscribeHostCredentials: () => () => undefined,
        },
      });
      sessions.push(session);
      return session;
    },
    network: {
      request: async (input) => {
        http.push(input);
        if (
          rejectCredentials &&
          ["/needs-session", "/v1/rpc/team.bootstrap.get"].includes(input.request.path) &&
          input.authorization !== "Bearer refreshed"
        )
          return Response.json(
            { ok: false, error: { code: "unauthorized", message: "Sign in", retryable: false } },
            { status: 401 },
          );
        return new Response("ok");
      },
      openWebSocket: (input, events) => {
        socketEvents = events;
        sockets.push(input);
        events.open();
        return {
          close() {},
          send(data) {
            sent.push(data);
          },
        };
      },
    },
  };
  const sent: (string | Uint8Array)[] = [];
  const transport = new HostTransport(options);
  const { pinnedTeamTransport } = await import("./transport-registry.js");
  const pinned = pinnedTeamTransport(options, new URL("https://team.example"));
  try {
    await transport.exchange(
      {
        path: "/v1/rpc/team.bootstrap.get",
        method: "POST",
        headers: {
          apiVersion: String(hostApiVersion),
          additional: { [hostApiVersionHeader]: "999", [teamApiVersionHeader]: "999" },
        },
      },
      (response) => response.text(),
    );
    await transport.openSocket({ path: "/v1/realtime" }, () => ({
      open() {},
      close() {},
      error() {},
      message() {},
    }));
    expect(credentials).toEqual([teamId, teamId]);
    expect(http[0]?.deploymentId).toBe(teamId);
    expect(http[0]?.request.headers.apiVersion).toBeUndefined();
    expect(http[0]?.request.headers.additional).toEqual({
      [teamApiVersionHeader]: String(teamApiVersion),
    });
    expect(sockets[0]?.deploymentId).toBe(teamId);
    expect(sockets[0]?.headers).toEqual({ [teamApiVersionHeader]: String(teamApiVersion) });
    const late = { open: vi.fn(), close: vi.fn(), message: vi.fn(), error: vi.fn() };
    await transport.openSocket({ path: "/v1/realtime" }, () => late);
    late.open.mockClear();
    transport.invalidateSession();
    socketEvents!.message("outgoing Account data");
    socketEvents!.open();
    socketEvents!.error("late error");
    expect(late.message).not.toHaveBeenCalled();
    expect(late.open).not.toHaveBeenCalled();
    expect(late.error).not.toHaveBeenCalled();
    const resolving = vi.fn();
    const release = Promise.withResolvers<void>();
    const delayed = new HostTransport({
      ...options,
      credentials: {
        authorizationHeader: async () => {
          resolving();
          await release.promise;
          return "Bearer outgoing";
        },
      },
    });
    const stale = delayed.exchange(
      { path: "/old-identity", method: "GET", headers: {} },
      async (response) => response.text(),
    );
    await vi.waitFor(() => expect(resolving).toHaveBeenCalledOnce(), { timeout: 1000 });
    delayed.invalidateSession();
    release.resolve();
    await expect(stale).rejects.toMatchObject({ code: "deployment-changed" });
    expect(http.some((call) => call.request.path === "/old-identity")).toBe(false);
    rejectCredentials = true;
    const request = () =>
      pinned.transport.exchange(
        { path: "/needs-session", method: "GET", headers: {} },
        async (response) => response.status,
      );
    await expect(Promise.all([request(), request()])).resolves.toEqual([200, 200]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(
      http
        .filter((call) => call.request.path === "/needs-session")
        .every((call) => call.deploymentId === teamId),
    ).toBe(true);
    token = "Bearer expired-again";
    recoveryOutcome = "unavailable";
    await expect(request()).rejects.toMatchObject({ code: "unreachable", retryable: true });
    const { TeamSessionClient } = await import("./team-session-client.js");
    const { createMemoryTeamPersistence } = await import("./persistence.js");
    const { mockTeamUserId } = await import("./mock-team-host.js");
    const scope = { teamDeploymentId: teamId, userId: mockTeamUserId };
    const persistence = createMemoryTeamPersistence();
    const saved = {
      drafts: { channel: "Keep this draft" },
      pending: [
        {
          command: {
            type: "team.message.send" as const,
            channelId: mockTeamChannelId,
            threadRootId: null,
            clientMessageId: "00000000-0000-4000-8000-000000000001",
            bodyMarkdown: "Unsent",
            mentions: [],
            attachmentIds: [],
          },
          createdAt: now,
          failure: null,
        },
      ],
    };
    await persistence.save(scope, saved);
    const client = new TeamSessionClient({
      scope,
      persistence,
      rpc: pinned.rpc,
      connect: pinned.connect,
    });
    try {
      await expect(client.load(false)).rejects.toMatchObject({ retryable: true });
      expect(client.getSnapshot().ended).toBeNull();
      expect(await persistence.load(scope)).toEqual(saved);
    } finally {
      client.dispose();
    }
    for (const reason of TeamEntryRefusalReasonSchema.options) {
      recoveryOutcome = reason;
      const classified = pinnedTeamTransport(options, new URL("https://team.example"));
      const result = await classified.rpc["team.bootstrap.get"]({});
      expect(result).toMatchObject({
        ok: false,
        error: {
          reason,
          retryable: reason !== "not-a-member",
        },
      });
      classified.transport.closeAllSockets();
    }
    recoveryOutcome = "update-required";
    const outdated = pinnedTeamTransport(options, new URL("https://team.example"));
    try {
      await expect(outdated.rpc["team.bootstrap.get"]({})).resolves.toMatchObject({
        ok: false,
        error: { code: "conflict", reason: "host-too-old", retryable: false },
      });
    } finally {
      outdated.transport.closeAllSockets();
    }
    // A separate attachment has no cooldown from the unavailable attempt.
    recoveryOutcome = "account-required";
    await expect(
      transport.exchange(
        { path: "/needs-session", method: "GET", headers: {} },
        async (response) => response.status,
      ),
    ).resolves.toBe(401);
    const refused = pinnedTeamTransport(options, new URL("https://team.example"));
    const ended = new TeamSessionClient({
      scope,
      persistence,
      rpc: refused.rpc,
      connect: refused.connect,
    });
    try {
      await expect(ended.load(false)).rejects.toMatchObject({ code: "unauthorized" });
      expect(ended.getSnapshot().ended).toBe("sign-in");
      expect(await persistence.load(scope)).toEqual(saved);
    } finally {
      ended.dispose();
      refused.transport.closeAllSockets();
    }
    recoveryOutcome = "not-a-member";
    const notMember = pinnedTeamTransport(options, new URL("https://team.example"));
    await expect(notMember.rpc["team.bootstrap.get"]({})).resolves.toMatchObject({
      ok: false,
      error: { code: "forbidden", reason: "not-a-member", message: "Ask for an invite" },
    });
    notMember.transport.closeAllSockets();
    const socket = pinned.connect();
    socket.addEventListener("open", () => socket.send("subscription"));
    await vi.waitFor(() =>
      expect(sent, "subscription was lost while the native socket handle settled").toEqual([
        "subscription",
      ]),
    );
  } finally {
    transport.closeAllSockets();
    pinned.transport.closeAllSockets();
    for (const session of sessions) session.dispose();
  }
});

it("disposes only the session a retired transport made for itself", async () => {
  const { HostTransport } = await import("../connections/host-transport.js");
  const { DeploymentCatalogSchema } = await import("../connections/deployment-catalog.js");
  const base = {
    catalog: {
      load: async () =>
        DeploymentCatalogSchema.parse({
          deployments: [],
          selectedDeploymentId: null,
          revision: 1,
          schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
          updatedAt: new Date(0).toISOString(),
        }),
      subscribe: () => () => {},
    },
    localRuntime: { current: async () => null },
    network: {
      request: async () => new Response("ok"),
      openWebSocket: () => ({ close() {}, send() {} }),
    },
  };
  const owned = { recoverUnauthorized: async () => "unavailable" as const, dispose: vi.fn() };
  const shared = { recoverUnauthorized: async () => "unavailable" as const, dispose: vi.fn() };
  new HostTransport({ ...base, sessions: () => owned }).retire();
  new HostTransport({ ...base, sessions: shared }).retire();
  expect(owned.dispose).toHaveBeenCalledOnce();
  expect(shared.dispose).not.toHaveBeenCalled();
});
