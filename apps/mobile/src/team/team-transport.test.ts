import { expect, it } from "vitest";
import { DeploymentConnectionSchema } from "@opensteer/client/connections";
import type { MockTeamHost } from "@opensteer/client/team";
import { mockDeploymentConnections } from "../client/mock-mode.js";
import { mockTeamReaderId, mockTeamTransport } from "./team-transport.js";

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
