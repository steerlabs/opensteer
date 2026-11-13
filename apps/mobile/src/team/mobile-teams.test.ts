import { HostClientRequestError } from "@opensteer/client/host";
import { TeamEntryRefusalReasonSchema } from "@opensteer/protocol";
import { TeamEntryRefusedError } from "@opensteer/client/auth";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import {
  DeploymentConnectionSchema,
  DeploymentCatalogStore,
  type VerifiedHostEndpoint,
  type DeploymentConnection,
} from "@opensteer/client/connections";
import type { MockTeamHost, TeamCacheScope } from "@opensteer/client/team";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { createId, DeploymentIdSchema, TeamChannelIdSchema, OpensteerError } from "@opensteer/core";
import type { HostApiClient } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import type { MobileClient } from "../client/mobile-client.js";
import {
  mockDeploymentConnections,
  mockTeamConnection,
  mockDeploymentId,
  mockFamilyTeamId,
  mockFamilyTeamOrigin,
  mockTeamId,
  mockTeamOrigin,
} from "../client/mock-mode.js";
import type { NotificationPreviews } from "../notifications/notification-preview.js";
import { MobileTeams, teamFailure, type TeamTransport } from "./mobile-teams.js";
import { mockTeamReaderId, mockTeamTransport } from "./team-transport.js";

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
function fixture(
  options: {
    readonly bootstrapFailures?: number;
    readonly previews?: Pick<NotificationPreviews, "attach" | "clear">;
    /** Answers a team command in place of the mock team Host. */
    readonly dispatch?: (command: { readonly type: string }) => unknown;
    /** Teams on this phone beside the mock ones, and whether a credential is held for each. */
    readonly catalog?: readonly { connection: DeploymentConnection; signedIn: boolean }[];
  } = {},
) {
  let bootstrapFailures = options.bootstrapFailures ?? 0;
  let bootstrapCalls = 0;
  const hosts = new Map<string, MockTeamHost>();
  const mock = mockTeamTransport(hosts);
  let releaseAcme!: () => void;
  const acmeAnswers = new Promise<void>((resolve) => {
    releaseAcme = resolve;
  });
  const transport = (connection: DeploymentConnection, scope: TeamCacheScope): TeamTransport => {
    const inner = mock(connection, scope);
    const acme = connection.authority.document.deploymentId === mockTeamId;
    const rpc = new Proxy(inner.rpc, {
      get: (target, name, receiver) =>
        name === "team.bootstrap.get" && acme
          ? async (input: never) => {
              await acmeAnswers;
              return target["team.bootstrap.get"](input);
            }
          : name === "team.bootstrap.get" && !acme && options.bootstrapFailures !== undefined
            ? async (input: never) => {
                if (bootstrapCalls++ > 0 && bootstrapFailures > 0) {
                  bootstrapFailures--;
                  throw new Error("Team offline");
                }
                return target["team.bootstrap.get"](input);
              }
            : name === "commands.dispatch" && options.dispatch !== undefined
              ? async (input: { readonly type: string }) =>
                  options.dispatch!(input) ?? target["commands.dispatch"](input as never)
              : Reflect.get(target, name, receiver),
    }) as HostApiClient;
    return { ...inner, rpc };
  };
  const listeners = new Set<() => void>();
  const signOut = vi.fn(async (_teamId: string) => undefined);
  let snapshot = {
    selection: { deploymentId: mockDeploymentId, hostClient: null },
    teams: [
      ...connections.map((connection) => ({ connection, signedIn: true })),
      ...(options.catalog ?? []),
    ],
  };
  let suppressed = false;
  const client = {
    oauth: {
      subscribeAccountIdentityChanges: () => () => undefined,
      accountIdentity: () => null,
      teamEntryLease: () => ({
        generation: 0,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      }),
      hostCredentialState: () => ({ detail: null }),
      isTeamSignInSuppressed: () => suppressed,
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    signOut,
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
    signOut,
    releaseAcme,
    showComputer(deploymentId: string) {
      snapshot = { ...snapshot, selection: { deploymentId, hostClient: null } } as never;
      for (const listener of listeners) listener();
    },
    suppress() {
      suppressed = true;
      for (const listener of listeners) listener();
    },
    loseAuthorization() {
      snapshot = {
        ...snapshot,
        teams: snapshot.teams.map((team) => ({ ...team, signedIn: false })),
      };
      for (const listener of listeners) listener();
    },
    sockets: () =>
      Object.fromEntries([...hosts].map(([teamId, host]) => [teamId, host.socketCount])),
  };
}

describe("the one team socket a phone keeps", () => {
  it("retries an unloaded remembered viewer and starts its realtime connection", async () => {
    const f = fixture({ bootstrapFailures: 1 });
    try {
      const session = await f.teams.session(mockFamilyTeamId);
      await f.teams.select(mockFamilyTeamId);
      expect(f.teams.team(mockFamilyTeamId)?.state).toBe("offline");
      expect(session.getSnapshot().bootstrap).toBeNull();
      await f.teams.select(mockFamilyTeamId);
      expect(session.getSnapshot().bootstrap).not.toBeNull();
      expect(f.teams.team(mockFamilyTeamId)?.state).toBe("live");
      expect(f.sockets()[mockFamilyTeamId]).toBe(1);
    } finally {
      f.teams.dispose();
    }
  });

  it("shows sign-in immediately when a live team is explicitly suppressed", async () => {
    const f = fixture();
    f.teams.start();
    await f.teams.select(mockFamilyTeamId);
    await vi.waitFor(() => expect(f.teams.team(mockFamilyTeamId)?.state).toBe("live"), {
      timeout: 1000,
    });
    f.suppress();
    expect(f.teams.team(mockFamilyTeamId)?.state).toBe("signed-out");
    expect(f.teams.team(mockFamilyTeamId)?.session).toBeNull();
    f.teams.dispose();
  });

  it("retains an open team's draft when authorization temporarily disappears", async () => {
    const f = fixture();
    f.teams.start();
    const session = await f.teams.session(mockFamilyTeamId);
    await session.setDraft(
      {
        kind: "channel",
        channelId: TeamChannelIdSchema.parse("tch_00000000-0000-4000-8000-000000000001"),
      },
      "Keep this draft",
    );
    f.loseAuthorization();
    expect(Object.values(session.getSnapshot().drafts)).toEqual(["Keep this draft"]);
    expect(session.getSnapshot().ended).toBeNull();
    f.teams.dispose();
  });

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
    const f = fixture({ previews: { attach, clear: async () => undefined } });
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

  it("leaves through the team itself before forgetting it on this phone", async () => {
    const sent: { readonly type: string }[] = [];
    let refuse = true;
    const f = fixture({
      dispatch: (command) => {
        if (command.type !== "team.member.remove") return undefined;
        sent.push(command);
        return refuse
          ? {
              ok: false,
              error: { code: "conflict", message: "The last owner cannot leave", retryable: false },
            }
          : { ok: true, data: { type: "team.member.remove" } };
      },
    });
    await f.teams.session(mockFamilyTeamId);
    await expect(f.teams.leave(mockFamilyTeamId)).rejects.toThrow("The last owner cannot leave");
    expect(f.teams.computersIn(mockFamilyTeamId)).toEqual([mockDeploymentId]);
    expect(f.signOut).not.toHaveBeenCalled();
    refuse = false;
    await f.teams.leave(mockFamilyTeamId);
    expect(sent.at(-1)).toEqual({ type: "team.member.remove", userId: mockTeamReaderId });
    expect(f.teams.computersIn(mockFamilyTeamId)).toEqual([]);
    expect(f.signOut).toHaveBeenCalledWith(mockFamilyTeamId);
    f.teams.dispose();
  });

  it("takes an open team off its socket when the team removes the reader", async () => {
    const attach = vi.fn();
    const f = fixture({ previews: { attach, clear: async () => undefined } });
    f.teams.start();
    await f.teams.select(mockFamilyTeamId);
    const held = await f.teams.session(mockFamilyTeamId);
    await vi.waitFor(() => expect(held.getSnapshot().connection).toBe("connected"), {
      timeout: 2_000,
    });
    const host = f.hosts.get(mockFamilyTeamId)!;
    const read = host.read.bind(host);
    vi.spyOn(host, "read").mockImplementation((name, input) => {
      if (name === "team.bootstrap.get")
        throw new OpensteerError({
          code: "forbidden",
          reason: "removed",
          message: "Membership removed",
        });
      return read(name, input);
    });
    // The team closes the removed member's socket.
    host.dispose();
    await vi.waitFor(
      () => expect(f.teams.team(mockFamilyTeamId)?.state, "never shown as removed").toBe("removed"),
      { timeout: 2_000 },
    );
    expect(f.teams.team(mockFamilyTeamId)?.session).toBeNull();
    expect(held.getSnapshot().drafts).toEqual({});
    expect(attach.mock.calls.at(-1)![0].current()).toBe(false);
    f.teams.dispose();
  });

  it("never hands back the old person's session once the team's login names someone else", async () => {
    const f = fixture();
    f.releaseAcme();
    const first = await f.teams.session(mockFamilyTeamId);
    const host = f.hosts.get(mockFamilyTeamId)!;
    const someoneElse = createId("user");
    const read = host.read.bind(host);
    vi.spyOn(host, "read").mockImplementation(async (name, input) => {
      const answer = await read(name, input);
      return name === "team.bootstrap.get"
        ? { ...(answer as object), member: { ...host.bootstrap.member, userId: someoneElse } }
        : answer;
    });
    await first.load(false);
    expect(first.getSnapshot().ended).toBe("viewer-changed");
    const next = await f.teams.session(mockFamilyTeamId);
    expect(next).not.toBe(first);
    expect(next.getSnapshot().bootstrap?.member.userId ?? null).toBe(null);
    await next.load(false);
    expect(next.getSnapshot().bootstrap?.member.userId).toBe(someoneElse);
    f.teams.dispose();
  });
});

describe("the teams a phone lists", () => {
  it("lists a team Account says the person joined elsewhere, with no agent link anywhere", async () => {
    const teamId = DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-0000000000b1");
    const joinedElsewhere = DeploymentConnectionSchema.parse({
      ...mockTeamConnection({
        deploymentId: teamId,
        name: "Beta",
        origin: "https://beta.teams.opensteer.com",
      }),
      accountAccess: "member",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastUsedAt: null,
      preferredEndpointOrigin: null,
    });
    const f = fixture({ catalog: [{ connection: joinedElsewhere, signedIn: false }] });
    f.teams.start();
    await vi.waitFor(() => expect(f.teams.team(teamId), "Beta never listed").not.toBeNull(), {
      timeout: 2_000,
    });
    const { teams, unlinked } = f.teams.getSnapshot();
    expect(teams.map((team) => [team.teamId, team.state])).toEqual([
      [teamId, "signed-out"],
      [mockTeamId, expect.any(String)],
      [mockFamilyTeamId, expect.any(String)],
    ]);
    expect(unlinked).toEqual([]);
    // Another computer on screen, with no link to any team: the membership still shows.
    f.showComputer(createId("deployment"));
    expect(f.teams.getSnapshot().teams.map((team) => team.teamId)).toEqual([teamId]);
    f.teams.dispose();
  });
});

describe("adding a computer's team to the phone", () => {
  it.each([
    "member",
    "refused-member",
    "refused-no-account",
    "no-account",
    "old-team",
    "not-member",
    "outage",
    "sign-out-during-discovery",
    "account-switch-during-discovery",
  ])("uses the shared entry policy for %s", async (mode) => {
    const connection = connections[0]!;
    const teamId = connection.authority.document.deploymentId;
    const verifying = Promise.withResolvers<void>();
    const verified: VerifiedHostEndpoint = {
      discovery: connection.authority.document,
      discoveryEnvelope: connection.authority,
      endpoint: connection.endpoints[0]!,
      bootstrapMethods: ["oidc"],
      capabilities:
        mode === "old-team"
          ? ["native-oauth", "team-native-browser-return-v1"]
          : ["native-oauth", "team-session-exchange-v1", "team-native-browser-return-v1"],
    };
    const catalog = new DeploymentCatalogStore({
      filePath: "/private/mobile-entry/catalog.json",
      privateFiles: new MemoryPrivateFilesystem(),
    });
    const lease = {
      issuer: "https://account.example",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
      authorization: "Bearer account",
      signal: new AbortController().signal,
    };
    const exchange = vi.fn(async () => {
      if (mode === "not-member")
        throw new TeamEntryRefusedError("not-a-member", "Ask for an invite");
      if (mode === "outage") throw new Error("Account unreachable");
      return { admitted: false, member: {} };
    });
    const browser = vi.fn(async (held: DeploymentConnection) => ({
      status: "signed-in",
      connection: held,
    }));
    let entryCurrent = true;
    const client = {
      catalog,
      oauth: {
        subscribeAccountIdentityChanges: () => () => undefined,
        accountIdentity: () => null,
        teamEntryLease: () => {
          const captured = entryCurrent;
          return {
            generation: 0,
            signal: new AbortController().signal,
            assertCurrent: () => {
              if (captured !== entryCurrent) throw new Error("Entry changed");
            },
          };
        },
        accountAuthorizationLease: async () => (mode.endsWith("no-account") ? null : lease),
        authorizationHeader: async () => null,
        resumeTeamSignIn: async () => {},
        isTeamSignInSuppressed: () => false,
        exchangeTeamSession: exchange,
        beginHostSignIn: browser,
        hostCredentialState: () => ({ status: "signed-out" }),
        subscribeHostCredentials: () => () => {},
      },
      subscribe: () => () => {},
      getSnapshot: () => ({
        selection: { deploymentId: mockDeploymentId, hostClient: null },
        teams: mode.startsWith("refused-") ? [{ connection, signedIn: true }] : [],
      }),
    } as unknown as MobileClient;
    const teams = new MobileTeams({
      client,
      directory: "/private/mobile-entry",
      files: new MemoryPrivateFilesystem(),
      transport: () => {
        throw new Error("No socket needed for entry");
      },
      verify: async () => {
        await verifying.promise;
        return verified;
      },
      seed: {
        [mockDeploymentId]: [
          { teamId, origin: connection.authority.document.canonicalOrigin, teamName: "Acme" },
        ],
      },
    });
    teams.start();
    await vi.waitFor(() => expect(teams.team(teamId), "team row never loaded").not.toBeNull(), {
      timeout: 1000,
    });
    if (mode === "no-account") {
      verifying.resolve();
      await teams.addToPhone(teamId, false).catch(() => {});
      expect(teams.team(teamId)?.state).toBe("signed-out");
      expect(browser).not.toHaveBeenCalled();
    }
    const adding = teams.addToPhone(teamId);
    expect(teams.team(teamId)?.state).toBe("loading");
    if (mode.endsWith("during-discovery")) entryCurrent = false;
    verifying.resolve();
    try {
      if (mode.endsWith("during-discovery")) {
        await expect(adding).rejects.toThrow();
        expect((await catalog.load()).deployments).toHaveLength(0);
        expect(exchange).not.toHaveBeenCalled();
        expect(browser).not.toHaveBeenCalled();
        return;
      }
      if (mode === "not-member" || mode === "outage") {
        await expect(adding).rejects.toThrow();
        expect(teams.team(teamId)?.state).toBe(mode === "not-member" ? "join" : "offline");
      } else await adding;
      expect(browser).toHaveBeenCalledTimes(
        mode.endsWith("no-account") || mode === "old-team" ? 1 : 0,
      );
      expect(exchange).toHaveBeenCalledTimes(
        mode.endsWith("no-account") || mode === "old-team" ? 0 : 1,
      );
    } finally {
      teams.dispose();
    }
  });
});

it.each([...TeamEntryRefusalReasonSchema.options, "removed", undefined])(
  "presents authorization refusal %s without implying an unconfirmed removal",
  (reason) => {
    const error = new HostClientRequestError({
      code: "forbidden",
      status: 403,
      message: "Refused",
      ...(reason ? { reason } : {}),
    });
    expect(teamFailure(error)).toBe(
      reason === "not-a-member" ? "join" : reason === "removed" ? "removed" : "offline",
    );
  },
);

it.each(["load", "save-directory", "save-write"] as const)(
  "fences team cache handoff after Account invalidation during %s",
  async (stage) => {
    const { teamFilePersistence } = await import("./mobile-teams.js");
    const files = new MemoryPrivateFilesystem();
    let current = true;
    const scope = { teamDeploymentId: mockTeamId, userId: mockTeamReaderId };
    const persistence = teamFilePersistence(files, "/cache", () => {
      if (!current) throw new Error("Account changed");
    });
    await persistence.save(scope, { drafts: {}, pending: [] });
    const method =
      stage === "load"
        ? "readFile"
        : stage === "save-directory"
          ? "ensureDirectory"
          : "writeFileAtomic";
    const original = files[method].bind(files);
    const spy = vi.spyOn(files, method);
    spy.mockImplementation(async (...args: unknown[]) => {
      const result = await Reflect.apply(original, files, args);
      current = false;
      return result;
    });
    try {
      await expect(
        stage === "load"
          ? persistence.load(scope)
          : persistence.save(scope, { drafts: { test: "private" }, pending: [] }),
      ).rejects.toThrow("Account changed");
    } finally {
      spy.mockRestore();
    }
  },
);
