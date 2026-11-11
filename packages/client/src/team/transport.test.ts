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
      kind: kind === "team" ? "self-hosted" : "personal",
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
        return "Bearer mock-session";
      },
    },
    network: {
      request: async (input) => {
        http.push(input);
        return new Response("ok");
      },
      openWebSocket: (input, events) => {
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
  }
});
