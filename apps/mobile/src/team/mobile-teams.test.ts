import { DeploymentConnectionSchema, type DeploymentConnection } from "@opensteer/client/connections";
import type { MockTeamHost, TeamCacheScope } from "@opensteer/client/team";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import type { HostApiClient } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import type { MobileClient } from "../client/mobile-client.js";
import {
  mockDeploymentConnections,
  mockDeploymentId,
  mockFamilyTeamId,
  mockFamilyTeamOrigin,
  mockTeamId,
  mockTeamOrigin,
} from "../client/mock-mode.js";
import type { NotificationPreviews } from "../notifications/notification-preview.js";
import { MobileTeams, type TeamTransport } from "./mobile-teams.js";
import { mockTeamTransport } from "./team-transport.js";

const connections: readonly DeploymentConnection[] = mockDeploymentConnections()
  .filter((row) => row.kind === "team")
  .map((row) =>
    DeploymentConnectionSchema.parse({
      ...row,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
      preferredEndpointOrigin: null,
    }),
  );

/**
 * The phone's teams over the real registry and mock team Hosts: Acme's first
 * bootstrap waits until the test lets it answer.
 */
function fixture(options: { readonly previews?: Pick<NotificationPreviews, "attach"> } = {}) {
  const hosts = new Map<string, MockTeamHost>();
  const mock = mockTeamTransport(hosts);
  let releaseAcme!: () => void;
  const acmeAnswers = new Promise<void>((resolve) => {
    releaseAcme = resolve;
  });
  const transport = (connection: DeploymentConnection, scope: TeamCacheScope): TeamTransport => {
    const inner = mock(connection, scope);
    if (connection.authority.document.deploymentId !== mockTeamId) return inner;
    const rpc = new Proxy(inner.rpc, {
      get: (target, name, receiver) =>
        name === "team.bootstrap.get"
          ? async (input: never) => {
              await acmeAnswers;
              return target["team.bootstrap.get"](input);
            }
          : Reflect.get(target, name, receiver),
    }) as HostApiClient;
    return { ...inner, rpc };
  };
  const listeners = new Set<() => void>();
  let snapshot = {
    selection: { deploymentId: mockDeploymentId, hostClient: null },
    teams: connections.map((connection) => ({ connection, signedIn: true })),
  };
  const client = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    signOut: async () => undefined,
    remove: async () => undefined,
  } as unknown as MobileClient;
  const teams = new MobileTeams({
    client,
    directory: "/private/teams-test",
    files: new MemoryPrivateFilesystem(),
    previews: (options.previews ?? null) as NotificationPreviews | null,
    transport,
    verify: () => Promise.reject(new Error("No network in this test.")),
    seed: {
      [mockDeploymentId]: [
        { teamId: mockTeamId, origin: mockTeamOrigin, teamName: "Acme" },
        { teamId: mockFamilyTeamId, origin: mockFamilyTeamOrigin, teamName: "Family" },
      ],
    },
  });
  return {
    teams,
    hosts,
    releaseAcme,
    showComputer(deploymentId: string) {
      snapshot = { ...snapshot, selection: { deploymentId, hostClient: null } } as never;
      for (const listener of listeners) listener();
    },
    sockets: () =>
      Object.fromEntries([...hosts].map(([teamId, host]) => [teamId, host.socketCount])),
  };
}

describe("the one team socket a phone keeps", () => {
  it("never lets a slower, older selection replace the team now in view", async () => {
    const f = fixture();
    const acme = f.teams.select(mockTeamId);
    await f.teams.select(mockFamilyTeamId);
    expect(f.sockets()[mockFamilyTeamId]).toBe(1);
    f.releaseAcme();
    await acme;
    expect(f.teams.getSnapshot().selected).toBe(mockFamilyTeamId);
    expect(f.sockets()).toEqual({ [mockTeamId]: 0, [mockFamilyTeamId]: 1 });
    f.teams.dispose();
  });

  it("does not reconnect in the background when a selection lands late", async () => {
    const f = fixture();
    const acme = f.teams.select(mockTeamId);
    f.teams.foreground(false);
    f.releaseAcme();
    await acme;
    expect(f.sockets()[mockTeamId] ?? 0).toBe(0);
    // Back in front, the team that was on screen is the one connected again.
    f.teams.foreground(true);
    await vi.waitFor(() => expect(f.sockets()[mockTeamId], "Acme never reconnected").toBe(1), {
      timeout: 2_000,
    });
    f.teams.dispose();
  });

  it("registers a team's notification preview key once its session is known", async () => {
    const attach = vi.fn();
    const f = fixture({ previews: { attach } });
    f.releaseAcme();
    const session = await f.teams.session(mockTeamId);
    expect(attach).toHaveBeenCalledTimes(1);
    const attachment = attach.mock.calls[0]![0];
    expect(attachment.deploymentId).toBe(mockTeamId);
    expect(attachment.current()).toBe(true);
    await f.teams.forget(mockTeamId);
    expect(attachment.current()).toBe(false);
    expect(session.getSnapshot().bootstrap).toBeNull();
    f.teams.dispose();
  });
});
