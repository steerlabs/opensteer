import { generateKeyPairSync } from "node:crypto";
import { createId, HostInstanceIdSchema } from "@opensteer/core";
import type { IdentityService } from "@opensteer/identity";
import { describe, expect, it, vi } from "vitest";
import { PersonalRemoteAccessService } from "./personal-remote-access-service.js";
import type { AuthenticatedHostSession, HostCredentialKind } from "../identity/auth.js";
import { signHostDiscovery } from "../identity/host-keys.js";

const authority = {
  canonicalOrigin: "http://127.0.0.1:4310",
  deploymentId: createId("deployment"),
  hostInstanceId: HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`),
  hostKey: { algorithm: "Ed25519" as const },
  deploymentShape: {
    defaultWorkspaceBacking: "local-directory" as const,
    kind: "personal" as const,
  },
};

/** Stands in for the row the owner claim writes when it establishes a session. */
const machineLocalMarker = { authSessionId: "marked" } as const;

describe("PersonalRemoteAccessService", () => {
  it("rejects a remote administrator before route mutation", async () => {
    const keys = generateKeyPairSync("ed25519");
    const session = ownerSession();
    const transaction = fakeTransaction({ machineLocal: false });
    const database = fakeDatabase(transaction);
    const service = new PersonalRemoteAccessService({
      authority,
      database: database as never,
      identity: fakeIdentity(),
      keys,
    });

    await expect(
      service.configure(session, {
        mode: "private",
        routeOrigin: "https://personal.example.test",
        schemaVersion: 1,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Remote access settings can be changed only on the Personal computer",
    });
    expect(transaction.updateTable).not.toHaveBeenCalled();
  });

  it("refuses every credential that is not this session's own browser cookie", async () => {
    const keys = generateKeyPairSync("ed25519");
    // The marker is present for all of these: a token minted from a browser
    // session names that session, so the marker alone travels with it.
    const transaction = fakeTransaction({ machineLocal: true });
    const service = new PersonalRemoteAccessService({
      authority,
      database: fakeDatabase(transaction) as never,
      identity: fakeIdentity(),
      keys,
    });

    for (const credentialKind of [
      "native-oauth",
      "personal-remote-cookie",
      "personal-remote-header",
    ] as const) {
      await expect(service.isMachineLocalSession(ownerSession(credentialKind))).resolves.toBe(
        false,
      );
      await expect(service.issuePairingCode(ownerSession(credentialKind))).rejects.toMatchObject({
        code: "forbidden",
        message: "Remote access settings can be changed only on the Personal computer",
      });
    }
    await expect(service.isMachineLocalSession(ownerSession())).resolves.toBe(true);
  });

  it("disconnects the reachable computers exactly when the route generation moves", async () => {
    const keys = generateKeyPairSync("ed25519");
    const disconnectRunners = vi.fn(async () => undefined);
    const fixture = configureDatabase({ generation: 4, mode: "off", routeOrigin: null });
    const service = new PersonalRemoteAccessService({
      authority,
      database: fixture.database as never,
      disconnectRunners,
      identity: fakeIdentity(),
      keys,
    });

    await expect(
      service.configure(ownerSession(), {
        mode: "private",
        routeOrigin: "https://personal.example.test",
        schemaVersion: 1,
      }),
    ).resolves.toMatchObject({ generation: 5, mode: "private" });
    expect(fixture.written).toMatchObject({
      generation: 5,
      mode: "private",
      routeOrigin: "https://personal.example.test",
    });
    expect(disconnectRunners).toHaveBeenCalledOnce();
    // The durable generation is what a reconnecting computer is checked
    // against, so it has to be committed before anything is taken away.
    expect(fixture.updated).toHaveBeenCalledBefore(disconnectRunners);

    // Re-saving the settings that are already stored writes nothing and bumps
    // no generation, so it takes no connection away either.
    await expect(
      service.configure(ownerSession(), {
        mode: "private",
        routeOrigin: "https://personal.example.test",
        schemaVersion: 1,
      }),
    ).resolves.toMatchObject({ generation: 5 });
    expect(disconnectRunners).toHaveBeenCalledOnce();
  });

  it("does not let a remote administrator mint a new pairing capability", async () => {
    const keys = generateKeyPairSync("ed25519");
    const session = ownerSession();
    const transaction = fakeTransaction({ machineLocal: false });
    const service = new PersonalRemoteAccessService({
      authority,
      database: fakeDatabase(transaction) as never,
      identity: fakeIdentity(),
      keys,
    });

    await expect(service.issuePairingCode(session)).rejects.toMatchObject({
      code: "forbidden",
      message: "Remote access settings can be changed only on the Personal computer",
    });
  });

  it("pins Account approval and publishes with the Host-owned linked credential", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pinnedAuthority = authority;
    const local = ownerSession();
    const hostCredential = `osc_${"h".repeat(43)}`;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input.toString()).toBe("https://accounts.opensteer.test/v1/host/connect");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${hostCredential}` });
      return Response.json({
        accessRoute: null,
        generation: 1,
        lastSeenAt: null,
        origin: null,
        state: "disabled",
      });
    });
    const service = new PersonalRemoteAccessService({
      authority: pinnedAuthority,
      database: projectionDatabase("https://accounts.opensteer.test", hostCredential) as never,
      fetch,
      grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
      identity: fakeIdentity(),
      keys,
    });

    await expect(
      service.approveAccountLink(local, {
        account: {
          issuer: "https://attacker.example",
          subject: `acct_${crypto.randomUUID()}`,
        },
        authorityEnvelope: signHostDiscovery(keys, pinnedAuthority),
        challengeCredential: `olc_${"a".repeat(43)}`,
        challengeId: `phc_${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Account-link issuer does not match this Personal Host",
    });

    await expect(
      service.publishConnectProjection(local, {
        expectedAccessRoute: null,
        schemaVersion: 2,
        state: "disabled",
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();

    await expect(
      service.publishConnectProjection(local, {
        controlApiOrigin: "https://attacker.example",
        expectedAccessRoute: null,
        hostCredential: `osc_${"a".repeat(43)}`,
        schemaVersion: 2,
        state: "disabled",
      }),
    ).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("keeps the Host link until central unlink acknowledges the exact Deployment", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pinnedAuthority = authority;
    const link = accountLink("https://accounts.opensteer.test");
    link.state = "activating";
    const fixture = accountMutationDatabase(link);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          deploymentId: pinnedAuthority.deploymentId,
          unlinked: true,
        }),
      );
    const identity = fakeIdentity();
    const service = new PersonalRemoteAccessService({
      authority: pinnedAuthority,
      database: fixture.database as never,
      fetch,
      identity,
      keys,
    });

    await expect(service.removeAccountLink(ownerSession())).rejects.toThrow(/HTTP 401/);
    expect(fixture.deleteLink).not.toHaveBeenCalled();
    await expect(service.removeAccountLink(ownerSession())).resolves.toBeUndefined();
    expect(fixture.deleteLink).toHaveBeenCalledOnce();
    expect(fixture.revokeConnectSessions).toHaveBeenCalledOnce();
    // The deleted logins' live connections end as a sign-out's do.
    expect(identity.announceSessionsEnded).toHaveBeenCalledWith([remoteLoginId]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries activation from the stored Host link without re-verifying an expired grant", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pinnedAuthority = authority;
    const link = accountLink("https://accounts.opensteer.test");
    const fixture = accountMutationDatabase(link);
    const verifyLink = vi.fn(async () => {
      throw new Error("expired completion grant must not be verified on exact retry");
    });
    let activationCalls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(init).toMatchObject({
        headers: expect.objectContaining({ authorization: `Bearer ${link.hostCredential}` }),
      });
      if (input.toString() === "https://accounts.opensteer.test/v1/host/authority") {
        // The link is active only once the Host that exists now, not the one
        // that requested the link, is what the Account holds.
        expect(activationCalls).toBe(2);
        expect(init).toMatchObject({ method: "PUT" });
        expect(JSON.parse(String(init?.body))).toMatchObject({
          authorityEnvelope: { document: pinnedAuthority },
        });
        return Response.json({ deploymentId: pinnedAuthority.deploymentId, published: true });
      }
      expect(input.toString()).toBe(
        "https://accounts.opensteer.test/v1/host/personal-account-link/activate",
      );
      expect(init).toMatchObject({ method: "POST" });
      expect(JSON.parse(String(init?.body))).toEqual({
        challengeId: link.challengeId,
        linkGeneration: link.linkGeneration,
      });
      activationCalls += 1;
      if (activationCalls === 1) {
        return Response.json(
          {
            error: {
              code: "conflict",
              message: "Account-link activation has expired",
              reason: "personal-account-link-reservation-expired",
            },
          },
          { status: 409 },
        );
      }
      return Response.json({
        activated: true,
        deploymentId: pinnedAuthority.deploymentId,
        linkGeneration: link.linkGeneration,
      });
    });
    const service = new PersonalRemoteAccessService({
      authority: pinnedAuthority,
      database: fixture.database as never,
      fetch,
      grantVerifier: {
        issuer: link.issuer,
        verifyLink,
      } as never,
      identity: fakeIdentity(),
      keys,
    });

    const request = {
      completionGrant: `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`,
      hostCredential: link.hostCredential,
      linkGeneration: link.linkGeneration,
      schemaVersion: 1,
    } as const;
    await expect(service.consumeAccountLink(ownerSession(), request)).rejects.toMatchObject({
      code: "conflict",
      reason: "personal-account-link-reservation-expired",
    });
    await expect(service.consumeAccountLink(ownerSession(), request)).resolves.toMatchObject({
      accountLink: { generation: link.linkGeneration },
    });
    expect(verifyLink).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["activating", "active"] as const)(
    "refuses to sign a second Account-link proof while a %s link exists",
    async (state) => {
      const keys = generateKeyPairSync("ed25519");
      const pinnedAuthority = authority;
      const link = accountLink("https://accounts.opensteer.test");
      link.state = state;
      const fixture = accountMutationDatabase(link);
      const service = new PersonalRemoteAccessService({
        authority: pinnedAuthority,
        database: fixture.database as never,
        fetch: vi.fn<typeof globalThis.fetch>(),
        grantVerifier: { issuer: link.issuer } as never,
        identity: fakeIdentity(),
        keys,
      });
      const challenge = {
        // The same Account, so this is the Host's own single-link invariant
        // rather than a mismatched-Account check.
        account: { issuer: link.issuer, subject: link.subject },
        authorityEnvelope: signHostDiscovery(keys, pinnedAuthority),
        challengeCredential: `olc_${"a".repeat(43)}`,
        challengeId: `phc_${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };

      await expect(service.approveAccountLink(ownerSession(), challenge)).rejects.toMatchObject({
        code: "conflict",
        message: "Personal Host already holds an Opensteer Account link",
      });

      // Replaying the exact challenge the stored link came from stays allowed:
      // that is the crash-safe courier repeating its own transcript.
      await expect(
        service.approveAccountLink(ownerSession(), {
          ...challenge,
          challengeId: link.challengeId,
        }),
      ).resolves.toMatchObject({ document: { challenge: { id: link.challengeId } } });
    },
  );

  it("completes unlink when the Account definitively holds no such link", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pinnedAuthority = authority;
    const link = accountLink("https://accounts.opensteer.test");
    link.state = "activating";
    const fixture = accountMutationDatabase(link);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          error: {
            code: "not_found",
            message: "no link",
            reason: "personal-account-link-not-found",
          },
        },
        { status: 404 },
      ),
    );
    const service = new PersonalRemoteAccessService({
      authority: pinnedAuthority,
      database: fixture.database as never,
      fetch,
      identity: fakeIdentity(),
      keys,
    });

    await expect(service.removeAccountLink(ownerSession())).resolves.toBeUndefined();
    expect(fixture.deleteLink).toHaveBeenCalledOnce();
    expect(fixture.revokeConnectSessions).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("refuses an out-of-order link removal while the Host route is Connect", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pinnedAuthority = authority;
    const fixture = accountMutationDatabase(accountLink("https://accounts.opensteer.test"), [
      "connect",
    ]);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = new PersonalRemoteAccessService({
      authority: pinnedAuthority,
      database: fixture.database as never,
      fetch,
      identity: fakeIdentity(),
      keys,
    });

    await expect(service.removeAccountLink(ownerSession())).rejects.toMatchObject({
      code: "conflict",
      message: "Disable the Connect route before unlinking the Opensteer Account",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(fixture.deleteLink).not.toHaveBeenCalled();
    expect(fixture.revokeConnectSessions).not.toHaveBeenCalled();
  });

  it("preserves the link when the route races back to Connect before final unlink", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pinnedAuthority = authority;
    const fixture = accountMutationDatabase(accountLink("https://accounts.opensteer.test"), [
      "off",
      "connect",
    ]);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        deploymentId: pinnedAuthority.deploymentId,
        unlinked: true,
      }),
    );
    const service = new PersonalRemoteAccessService({
      authority: pinnedAuthority,
      database: fixture.database as never,
      fetch,
      identity: fakeIdentity(),
      keys,
    });

    await expect(service.removeAccountLink(ownerSession())).rejects.toMatchObject({
      code: "conflict",
      message: "Disable the Connect route before unlinking the Opensteer Account",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.deleteLink).not.toHaveBeenCalled();
    expect(fixture.revokeConnectSessions).not.toHaveBeenCalled();
  });

  it("clears only the Connect projection while preserving a linked private route", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pinnedAuthority = authority;
    const hostCredential = `osc_${"h".repeat(43)}`;
    const privateState = {
      generation: 9,
      mode: "private" as const,
      routeOrigin: "https://personal.private.opensteer.test",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        accessRoute: null,
        generation: privateState.generation,
        origin: null,
        state: "disabled",
      });
      return Response.json({
        accessRoute: null,
        generation: privateState.generation,
        lastSeenAt: null,
        origin: null,
        state: "disabled",
      });
    });
    const service = new PersonalRemoteAccessService({
      authority: pinnedAuthority,
      database: projectionDatabase(
        "https://accounts.opensteer.test",
        hostCredential,
        privateState,
      ) as never,
      fetch,
      identity: fakeIdentity(),
      keys,
    });
    const before = await service.status("machine-local");

    await expect(
      service.publishConnectProjection(ownerSession(), {
        expectedAccessRoute: null,
        schemaVersion: 2,
        state: "disabled",
      }),
    ).resolves.toBeUndefined();

    expect(await service.status("machine-local")).toEqual(before);
    expect(before).toMatchObject({
      generation: privateState.generation,
      mode: "private",
      route: { document: { route: { kind: "private", origin: privateState.routeOrigin } } },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("revokes Connect through the linked Host credential with an authority-fenced operation", async () => {
    const keys = generateKeyPairSync("ed25519");
    const pinnedAuthority = authority;
    const link = accountLink("https://accounts.opensteer.test");
    const fixture = accountMutationDatabase(link);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input.toString()).toBe("https://accounts.opensteer.test/v1/host/connect");
      expect(init).toMatchObject({
        headers: expect.objectContaining({ authorization: `Bearer ${link.hostCredential}` }),
        method: "DELETE",
      });
      return Response.json({ generation: 7, revoked: true });
    });
    const service = new PersonalRemoteAccessService({
      authority: pinnedAuthority,
      database: fixture.database as never,
      fetch,
      identity: fakeIdentity(),
      keys,
    });

    await expect(
      service.revokeConnectResource(ownerSession(), {
        hostInstanceId: pinnedAuthority.hostInstanceId,
        operationId: `cop_${crypto.randomUUID()}`,
      }),
    ).resolves.toEqual({ generation: 7, revoked: true });
    expect(fetch).toHaveBeenCalledOnce();

    await expect(
      service.revokeConnectResource(ownerSession(), {
        hostInstanceId: createId("hostInstance"),
        operationId: `cop_${crypto.randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

function ownerSession(
  credentialKind: HostCredentialKind = "browser-cookie",
): AuthenticatedHostSession {
  const now = new Date();
  return {
    credentialKind,
    session: {
      absoluteExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      id: createId("authSession"),
      user: {
        disabledAt: null,
        displayName: "You",
        email: "owner@personal.opensteer.invalid",
        emailVerified: true,
        id: createId("user"),
        image: null,
        instanceRole: "administrator",
      },
    },
    surface: credentialKind === "browser-cookie" ? "canonical" : "personal-remote",
  };
}

/**
 * One optional row behind the chained builder, which is how both the
 * `machineLocalSessions` marker and an absent singleton read.
 */
function rowQuery(row: { readonly authSessionId: string } | undefined) {
  return {
    execute: vi.fn(async () => []),
    orderBy() {
      return this;
    },
    forUpdate() {
      return this;
    },
    executeTakeFirst: vi.fn(async () => row),
    forShare() {
      return this;
    },
    select() {
      return this;
    },
    where() {
      return this;
    },
  };
}

function fakeDatabase(transaction: ReturnType<typeof fakeTransaction>) {
  return {
    transaction: () => ({ execute: (run: (value: unknown) => unknown) => run(transaction) }),
  };
}

/**
 * The one stored remote-access row, answered from a mutable state object so a
 * second `configure` reads back exactly what the first one wrote.
 */
function configureDatabase(initial: {
  readonly generation: number;
  readonly mode: "off" | "connect" | "private";
  readonly routeOrigin: string | null;
}) {
  let state = { ...initial };
  const remoteAccessQuery = {
    executeTakeFirstOrThrow: vi.fn(async () => state),
    forNoKeyUpdate() {
      return this;
    },
    selectAll() {
      return this;
    },
    where() {
      return this;
    },
  };
  const marker = rowQuery(machineLocalMarker);
  const absentAccountLink = rowQuery(undefined);
  const written: { generation?: number; mode?: string; routeOrigin?: string | null } = {};
  const updated = vi.fn(async () => ({ numUpdatedRows: 1n }));
  const updateQuery = {
    executeTakeFirstOrThrow: updated,
    set(values: { generation: number; mode: typeof state.mode; routeOrigin: string | null }) {
      Object.assign(written, values);
      state = { generation: values.generation, mode: values.mode, routeOrigin: values.routeOrigin };
      return this;
    },
    where() {
      return this;
    },
  };
  const deleteQuery = {
    execute: vi.fn(async () => []),
    returning() {
      return this;
    },
    where() {
      return this;
    },
  };
  const transaction = {
    deleteFrom: vi.fn(() => deleteQuery),
    getExecutor: () => ({
      compileQuery: () => ({}),
      executeQuery: vi.fn(async () => ({ rows: [] })),
      transformQuery: (node: unknown) => node,
    }),
    selectFrom: vi.fn((table: string) =>
      table === "personalRemoteAccess" ? remoteAccessQuery : marker,
    ),
    updateTable: vi.fn(() => updateQuery),
  };
  return {
    database: {
      selectFrom: vi.fn((table: string) =>
        table === "personalRemoteAccess" ? remoteAccessQuery : absentAccountLink,
      ),
      transaction: () => ({ execute: (run: (value: unknown) => unknown) => run(transaction) }),
    },
    updated,
    written,
  };
}

function projectionDatabase(
  linkedIssuer: string,
  hostCredential: string,
  remoteAccessState: {
    readonly generation: number;
    readonly mode: "off" | "connect" | "private";
    readonly routeOrigin: string | null;
  } = { generation: 1, mode: "off", routeOrigin: null },
) {
  const link = {
    challengeId: `phc_${crypto.randomUUID()}`,
    grantId: `phg_${crypto.randomUUID()}`,
    hostCredential,
    issuer: linkedIssuer,
    linkGeneration: "g".repeat(43),
    state: "active",
    singletonKey: "opensteer-account",
    subject: `acct_${crypto.randomUUID()}`,
  };
  const localSessionQuery = {
    executeTakeFirst: vi.fn(async () => machineLocalMarker),
    forShare() {
      return this;
    },
    select() {
      return this;
    },
    where() {
      return this;
    },
  };
  const remoteAccessQuery = {
    executeTakeFirstOrThrow: vi.fn(async () => remoteAccessState),
    selectAll() {
      return this;
    },
    where() {
      return this;
    },
  };
  const linkQuery = {
    executeTakeFirst: vi.fn(async () => link),
    select() {
      return this;
    },
    selectAll() {
      return this;
    },
    where() {
      return this;
    },
  };
  return {
    selectFrom: vi.fn((table: string) =>
      table === "personalRemoteAccess" ? remoteAccessQuery : linkQuery,
    ),
    transaction: () => ({
      execute: (run: (value: unknown) => unknown) =>
        run({
          selectFrom: vi.fn(() => localSessionQuery),
        }),
    }),
  };
}

function accountLink(issuer: string) {
  return {
    challengeId: `phc_${crypto.randomUUID()}`,
    grantId: `phg_${crypto.randomUUID()}`,
    hostCredential: `osc_${"h".repeat(43)}`,
    issuer,
    linkGeneration: "g".repeat(43),
    linkedAt: new Date(),
    singletonKey: "opensteer-account" as const,
    state: "active" as "activating" | "active",
    subject: `acct_${crypto.randomUUID()}`,
    updatedAt: new Date(),
  };
}

function accountMutationDatabase(
  link: ReturnType<typeof accountLink>,
  remoteModes: readonly ("connect" | "off" | "private")[] = ["off"],
) {
  const machineLocalQuery = rowQuery(machineLocalMarker);
  let remoteModeRead = 0;
  const remoteAccessQuery = {
    executeTakeFirstOrThrow: vi.fn(async () => ({
      mode: remoteModes[Math.min(remoteModeRead++, remoteModes.length - 1)],
    })),
    forShare() {
      return this;
    },
    select() {
      return this;
    },
    where() {
      return this;
    },
  };
  const linkQuery = {
    executeTakeFirst: vi.fn(async () => link),
    executeTakeFirstOrThrow: vi.fn(async () => link),
    forNoKeyUpdate() {
      return this;
    },
    select() {
      return this;
    },
    selectAll() {
      return this;
    },
    where() {
      return this;
    },
  };
  const deleteLink = vi.fn(async () => ({ numDeletedRows: 1n }));
  const deleteQuery = {
    executeTakeFirst: deleteLink,
    where() {
      return this;
    },
  };
  const revokeConnectSessions = vi.fn(async () => [{ id: remoteLoginId }]);
  const updateLinkQuery = {
    executeTakeFirstOrThrow: vi.fn(async () => {
      link.state = "active";
      return { numUpdatedRows: 1n };
    }),
    set() {
      return this;
    },
    where() {
      return this;
    },
  };
  const authSessionDeleteQuery = {
    execute: revokeConnectSessions,
    returning() {
      return this;
    },
    where() {
      return this;
    },
  };
  const transaction = {
    deleteFrom: vi.fn((table: string) =>
      table === "personalRemoteAccountLink" ? deleteQuery : authSessionDeleteQuery,
    ),
    getExecutor: () => ({
      compileQuery: () => ({}),
      executeQuery: vi.fn(async () => ({ rows: [] })),
      transformQuery: (node: unknown) => node,
    }),
    selectFrom: vi.fn((table: string) => {
      if (table === "personalRemoteAccess") return remoteAccessQuery;
      if (table === "personalRemoteAccountLink") return linkQuery;
      return machineLocalQuery;
    }),
  };
  const statusRemoteAccessQuery = {
    executeTakeFirstOrThrow: vi.fn(async () => ({
      generation: 0,
      mode: "off",
      routeOrigin: null,
    })),
    selectAll() {
      return this;
    },
    where() {
      return this;
    },
  };
  return {
    database: {
      selectFrom: vi.fn((table: string) =>
        table === "personalRemoteAccess" ? statusRemoteAccessQuery : linkQuery,
      ),
      transaction: () => ({ execute: (run: (value: unknown) => unknown) => run(transaction) }),
      updateTable: vi.fn(() => updateLinkQuery),
    },
    deleteLink,
    revokeConnectSessions,
  };
}

const remoteLoginId = "ses_00000000-0000-4000-8000-000000000042";

function fakeIdentity() {
  return { announceSessionsEnded: vi.fn() } as unknown as IdentityService & {
    readonly announceSessionsEnded: ReturnType<typeof vi.fn>;
  };
}

function fakeTransaction(input: { readonly machineLocal: boolean }) {
  const sessionQuery = rowQuery(input.machineLocal ? machineLocalMarker : undefined);
  return {
    deleteFrom: vi.fn(),
    executeQuery: vi.fn(async () => ({ rows: [] })),
    selectFrom: vi.fn(() => sessionQuery),
    updateTable: vi.fn(),
  };
}
