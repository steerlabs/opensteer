import { expect, it, vi } from "vitest";
import { DeploymentConnectionSchema } from "@opensteer/client/connections";
import type { MockTeamHost } from "@opensteer/client/team";
import { mockDeploymentConnections } from "../client/mock-mode.js";
import { mockTeamReaderId, mockTeamTransport, networkTeamTransport } from "./team-transport.js";

it("keeps both busy mock teams and their conversations across phone sessions", async () => {
  const hosts = new Map<string, MockTeamHost>();
  const transport = mockTeamTransport(hosts);
  const teams = mockDeploymentConnections().filter((row) => row.kind === "team");
  expect(teams.map((team) => team.name)).toEqual(["Acme", "Family"]);
  for (const row of teams) {
    const connection = DeploymentConnectionSchema.parse({
      ...row,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
      preferredEndpointOrigin: null,
    });
    const scope = {
      teamDeploymentId: connection.authority.document.deploymentId,
      userId: mockTeamReaderId,
    };
    const first = transport(connection, scope);
    const host = hosts.get(scope.teamDeploymentId)!;
    expect(host.members).toHaveLength(7);
    const channelId = [...host.channels.values()][0]!.id;
    const message = host.post({ channelId, bodyMarkdown: "Back on my phone." });
    const next = transport(connection, scope);
    expect(next.rpc).toBe(first.rpc);
    const page = await next.rpc["team.messages.page"]({ channelId, page: { direction: "newest" } });
    expect(page.ok && page.data.messages.at(-1)?.id).toBe(message.id);
  }
});

it("forces one team refresh for concurrent 401s on a phone", async () => {
  const { DeploymentCatalogSchema } = await import("@opensteer/client/connections");
  const connection = DeploymentConnectionSchema.parse({
    ...mockDeploymentConnections().find((row) => row.kind === "team"),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastUsedAt: null,
    preferredEndpointOrigin: null,
  });
  let token = "Bearer rejected";
  const recoverHostAuthorization = vi.fn(async () => {
    token = "Bearer renewed";
    return true;
  });
  const oauth = {
    subscribeAccountIdentityChanges: () => () => undefined,
    recoverHostAuthorization,
    subscribe: () => () => undefined,
    subscribeHostCredentials: () => () => undefined,
  } as unknown as import("@opensteer/client/auth").NativeOAuthManager;
  const requests: string[] = [];
  const transport = networkTeamTransport({
    catalog: {
      load: async () =>
        DeploymentCatalogSchema.parse({
          deployments: [connection],
          selectedDeploymentId: connection.authority.document.deploymentId,
          revision: 1,
          schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
          updatedAt: new Date(0).toISOString(),
        }),
      subscribe: () => () => undefined,
    },
    credentials: { authorizationHeader: async () => token },
    oauth,
    network: {
      request: async (input) => {
        requests.push(input.authorization!);
        return Response.json(
          {
            ok: false,
            error: {
              code: input.authorization === "Bearer renewed" ? "forbidden" : "unauthorized",
              message: "Test refusal",
              retryable: false,
            },
          },
          { status: input.authorization === "Bearer renewed" ? 403 : 401 },
        );
      },
      openWebSocket: () => {
        throw new Error("No socket expected");
      },
    },
  })(connection, {
    teamDeploymentId: connection.authority.document.deploymentId,
    userId: mockTeamReaderId,
  });
  const results = await Promise.all([
    transport.rpc["auth.config"]({}),
    transport.rpc["auth.config"]({}),
  ]);
  expect(results).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: "forbidden" }) }),
    expect.objectContaining({ error: expect.objectContaining({ code: "forbidden" }) }),
  ]);
  expect(recoverHostAuthorization).toHaveBeenCalledOnce();
  expect(requests).toEqual([
    "Bearer rejected",
    "Bearer rejected",
    "Bearer renewed",
    "Bearer renewed",
  ]);
});
