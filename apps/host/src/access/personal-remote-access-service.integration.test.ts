import { generateKeyPairSync } from "node:crypto";
import { PersonalHostAccountLinkProofEnvelopeSchema } from "@opensteer/control-plane-protocol";
import { createId, HostInstanceIdSchema } from "@opensteer/core";
import type { IdentityService } from "@opensteer/identity";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PersonalRemoteAccessService } from "./personal-remote-access-service.js";
import type { AuthenticatedHostSession, HostCredentialKind } from "../identity/auth.js";
import { signHostDiscovery, signPersonalHostAccessRoute } from "../identity/host-keys.js";

const ownerId = createId("user");
let owner: Awaited<
  ReturnType<typeof import("../runtime/personal-owner.test-support.js").createPersonalOwnerFixture>
>;
beforeAll(async () => {
  owner = await (
    await import("../runtime/personal-owner.test-support.js")
  ).createPersonalOwnerFixture(ownerId);
});
afterAll(async () => {
  await owner?.close();
});
function ownerAuthority<Value extends { selectFrom: (table: string) => unknown }>(
  database: Value,
): Value {
  return new Proxy(database, {
    get(target, key, receiver) {
      if (key === "selectFrom")
        return (table: string) =>
          table === "personalSettings" || table === "deployments" || table === "users"
            ? owner.database.selectFrom(table)
            : target.selectFrom(table);
      return Reflect.get(target, key, receiver);
    },
  });
}
const authority = {
  canonicalOrigin: "http://127.0.0.1:4310",
  deploymentId: createId("deployment"),
  hostInstanceId: HostInstanceIdSchema.parse(`hst_${crypto.randomUUID()}`),
  hostKey: { algorithm: "Ed25519" as const },
  deploymentShape: {
    kind: "personal" as const,
  },
};

describe("PersonalRemoteAccessService", () => {
  it("never contacts a stored Account link without a configured issuer", async () => {
    const link = accountLink("https://accounts.opensteer.test");
    link.state = "active";
    const fixture = accountMutationDatabase(link);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({}));
    const service = new PersonalRemoteAccessService({
      authority,
      database: ownerAuthority(fixture.database) as never,
      fetch,
      identity: fakeIdentity(),
      keys: generateKeyPairSync("ed25519"),
    });
    await expect(service.publishAccountAuthority()).resolves.toBe("unlinked");
    await expect(
      service.resumeAccountLink(ownerSession(), { schemaVersion: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("admits owner administration from every credential family", async () => {
    for (const credentialKind of [
      "browser-cookie",
      "native-oauth",
      "personal-remote-cookie",
      "personal-remote-header",
    ] as const) {
      const fixture = configureDatabase({ generation: 0, mode: "off", routeOrigin: null });
      const service = new PersonalRemoteAccessService({
        authority,
        database: ownerAuthority(fixture.database) as never,
        identity: fakeIdentity(),
        keys: generateKeyPairSync("ed25519"),
      });
      await expect(
        service.configure(ownerSession(credentialKind), {
          mode: "private",
          routeOrigin: "https://private.example",
          schemaVersion: 1,
        }),
      ).resolves.toMatchObject({ generation: 1, mode: "private" });
    }
  });

  it("changes Remote access only as the step of an unfinished operation that asked for it (AD10)", async () => {
    const attempt = async (operation: Parameters<typeof configureDatabase>[1]) => {
      const fixture = configureDatabase(
        { generation: 0, mode: "off", routeOrigin: null },
        operation,
      );
      const service = new PersonalRemoteAccessService({
        authority,
        database: ownerAuthority(fixture.database) as never,
        identity: fakeIdentity(),
        keys: generateKeyPairSync("ed25519"),
      });
      const result = service.configure(ownerSession(), {
        mode: "private",
        routeOrigin: "https://private.example",
        schemaVersion: 1,
      });
      return { result, fixture };
    };
    // With the person's admitted, unfinished request for this mode: it is carried out.
    const carried = await attempt({
      intent: { action: "configure", mode: "private" },
      state: "running",
    });
    await expect(carried.result).resolves.toMatchObject({ mode: "private" });
    // Without any operation, for a finished one, or for one that asked for another mode: refused
    // before anything changes.
    for (const operation of [
      null,
      { intent: { action: "configure", mode: "private" }, state: "succeeded" },
      { intent: { action: "configure", mode: "private" }, state: "failed" },
      { intent: { action: "configure", mode: "off" }, state: "running" },
    ]) {
      const refused = await attempt(operation);
      await expect(refused.result, JSON.stringify(operation)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(refused.fixture.updated).not.toHaveBeenCalled();
    }
  });

  it("issues a Connect credential and publishes Connect as on only as the step of its operation (AD10)", async () => {
    const issuer = "https://accounts.opensteer.test";
    const keys = generateKeyPairSync("ed25519");
    const refusal = "Remote access changes only as part of a change you asked for in Opensteer.";
    const steps = [
      {
        name: "connect-provision",
        asks: { action: "configure", mode: "connect" },
        run: (service: PersonalRemoteAccessService) =>
          service.connectCredentialForExecutor({} as never, false),
      },
      {
        name: "connect-rotate",
        asks: { action: "rotate" },
        run: (service: PersonalRemoteAccessService) =>
          service.connectCredentialForExecutor({} as never, true),
      },
      {
        name: "connect-projection (on)",
        asks: { action: "configure", mode: "connect" },
        run: (service: PersonalRemoteAccessService) =>
          service.publishConnectProjection(ownerSession(), {
            expectedAccessRoute: signPersonalHostAccessRoute(keys, {
              authority,
              documentVersion: 2,
              purpose: "opensteer-personal-access-route",
              route: { generation: 1, kind: "connect", origin: "https://connect.test" },
            }),
            schemaVersion: 2,
            state: "ready",
          }),
      },
    ];
    for (const step of steps) {
      const attempt = async (operation: Parameters<typeof projectionDatabase>[3]) => {
        const fetch = vi.fn(async () => Response.json({}, { status: 500 }));
        const service = new PersonalRemoteAccessService({
          authority,
          database: ownerAuthority(
            projectionDatabase(issuer, `osc_${"h".repeat(43)}`, undefined, operation),
          ) as never,
          fetch,
          grantVerifier: { issuer } as never,
          identity: fakeIdentity(),
          keys,
        });
        const outcome = await step.run(service).then(
          () => "done",
          (error: { readonly message?: string }) => error.message ?? "error",
        );
        return { outcome, fetch };
      };
      // With its admitted, unfinished operation: past the check, to what the step does next.
      const carried = await attempt({ intent: step.asks, state: "running" });
      expect(carried.outcome, step.name).not.toBe(refusal);
      // Without one, for a finished or failed one, or for one that asked for something else:
      // refused before anything reaches the Opensteer account.
      for (const operation of [
        null,
        { intent: step.asks, state: "succeeded" },
        { intent: step.asks, state: "failed" },
        { intent: { action: "configure", mode: "private" }, state: "running" },
      ]) {
        const refused = await attempt(operation);
        expect(refused.outcome, `${step.name} ${JSON.stringify(operation)}`).toBe(refusal);
        expect(refused.fetch).not.toHaveBeenCalled();
      }
    }
  });

  it("takes Remote access away with no operation behind it, on record for the person (AD10)", async () => {
    const issuer = "https://accounts.opensteer.test";
    const keys = generateKeyPairSync("ed25519");
    const database = projectionDatabase(issuer, `osc_${"h".repeat(43)}`);
    const fetch = vi.fn(async () =>
      Response.json({
        accessRoute: null,
        generation: 1,
        lastSeenAt: null,
        origin: null,
        state: "disabled",
      }),
    );
    const service = new PersonalRemoteAccessService({
      authority,
      database: ownerAuthority(database) as never,
      fetch,
      grantVerifier: { issuer } as never,
      identity: fakeIdentity(),
      keys,
    });
    // The Mac app's startup cleanup: no operation, never refused.
    await expect(
      service.publishConnectProjection(ownerSession(), {
        expectedAccessRoute: null,
        schemaVersion: 2,
        state: "disabled",
      }),
    ).resolves.toBeUndefined();
    await service
      .revokeConnectResource(ownerSession(), {
        hostInstanceId: authority.hostInstanceId,
        operationId: `cop_${crypto.randomUUID()}`,
      })
      .catch(() => undefined);
    expect(database.audits.map((row) => row.action)).toEqual([
      "remote-access.connect-off",
      "remote-access.connect-removed",
    ]);
  });

  it("refuses non-owners before any administration effect", async () => {
    const fixture = configureDatabase({ generation: 0, mode: "off", routeOrigin: null });
    const service = new PersonalRemoteAccessService({
      authority,
      database: ownerAuthority(fixture.database) as never,
      identity: fakeIdentity(),
      keys: generateKeyPairSync("ed25519"),
    });
    const caller = ownerSession("personal-remote-header");
    const session = {
      ...caller.session,
      user: { ...caller.session.user, id: createId("user") },
    };
    await expect(
      service.configure({ session }, { mode: "off", routeOrigin: null, schemaVersion: 1 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.issuePairingCode({ session })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(fixture.updated).not.toHaveBeenCalled();
  });

  it("disconnects the reachable computers exactly when the route generation moves", async () => {
    const keys = generateKeyPairSync("ed25519");
    const disconnectRunners = vi.fn(async () => undefined);
    const fixture = configureDatabase({ generation: 4, mode: "off", routeOrigin: null });
    const service = new PersonalRemoteAccessService({
      authority,
      database: ownerAuthority(fixture.database) as never,
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
      database: ownerAuthority(
        projectionDatabase("https://accounts.opensteer.test", hostCredential),
      ) as never,
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
        completionFormat: "sealed-v1",
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

  it("signs an Account-link proof for a Home on its own server, which has no Remote access", async () => {
    const keys = generateKeyPairSync("ed25519");
    const issuer = "https://accounts.opensteer.test";
    const home = { ...authority, canonicalOrigin: "https://home.opensteer.test" };
    const service = new PersonalRemoteAccessService({
      authority: home,
      database: owner.database as never,
      grantVerifier: { issuer } as never,
      identity: fakeIdentity(),
      keys,
    });
    const caller = ownerSession();
    await owner.database
      .insertInto("authSessions")
      .values({
        absoluteExpiresAt: new Date(caller.session.absoluteExpiresAt),
        deviceLabel: "Owner device",
        expiresAt: new Date(caller.session.expiresAt),
        id: caller.session.id,
        memberGeneration: "1",
        token: crypto.randomUUID(),
        userId: ownerId,
      })
      .execute();
    const challengeId = `phc_${crypto.randomUUID()}`;
    const proof = PersonalHostAccountLinkProofEnvelopeSchema.parse(
      await service.approveAccountLink(caller, {
        account: { issuer, subject: `acct_${crypto.randomUUID()}` },
        authorityEnvelope: signHostDiscovery(keys, home),
        completionFormat: "sealed-v1",
        challengeCredential: `olc_${"a".repeat(43)}`,
        challengeId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(proof.document.authority).toEqual(home);
    expect(proof.document.challenge.id).toBe(challengeId);
    await expect(
      service.configure(caller, {
        mode: "private",
        routeOrigin: "https://home-route.opensteer.test",
        schemaVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(service.status()).resolves.toMatchObject({ mode: "off", route: null });
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
      database: ownerAuthority(fixture.database) as never,
      fetch,
      grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
      identity,
      keys,
    });

    await expect(service.removeAccountLink(ownerSession())).rejects.toMatchObject(
      accountAnswered(401),
    );
    expect(fixture.deleteLink).not.toHaveBeenCalled();
    expect(link.accountOperation).toMatchObject({ kind: "unlink" });
    expect(link.hostCredential).toBe(`osc_${"h".repeat(43)}`);
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
    link.state = "activating";
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
      database: ownerAuthority(fixture.database) as never,
      fetch,
      grantVerifier: {
        issuer: link.issuer,
        verifyLink,
      } as never,
      identity: fakeIdentity(),
      keys,
    });

    const request = {
      challengeId: link.challengeId,
      sealedCompletion: {
        version: 1,
        ciphertext: "abc",
        ephemeralPublicKey: "k".repeat(43),
        nonce: "n".repeat(16),
        tag: "t".repeat(22),
      },
      resultExpiresAt: new Date(Date.now() + 60000).toISOString(),
      linkGeneration: link.linkGeneration,
      schemaVersion: 2,
    } as const;
    await expect(service.consumeAccountLink(ownerSession(), request)).rejects.toMatchObject({
      code: "conflict",
      reason: "personal-account-link-reservation-expired",
    });
    expect(link.accountOperation).toBeNull();
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
        database: ownerAuthority(fixture.database) as never,
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
        completionFormat: "sealed-v1",
        challengeCredential: `olc_${"a".repeat(43)}`,
        challengeId: `phc_${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };

      await expect(service.approveAccountLink(ownerSession(), challenge)).rejects.toMatchObject({
        code: "conflict",
        message: "Personal Host already holds an Opensteer Account link",
      });

      await expect(
        service.approveAccountLink(ownerSession(), {
          ...challenge,
          challengeId: link.challengeId,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
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
      database: ownerAuthority(fixture.database) as never,
      fetch,
      grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
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
      database: ownerAuthority(fixture.database) as never,
      fetch,
      grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
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

  it("keeps the unlink journal if an unexpected Connect route prevents finalization", async () => {
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
      database: ownerAuthority(fixture.database) as never,
      fetch,
      grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
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
      database: ownerAuthority(
        projectionDatabase("https://accounts.opensteer.test", hostCredential, privateState),
      ) as never,
      fetch,
      grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
      identity: fakeIdentity(),
      keys,
    });
    const before = await service.status();

    await expect(
      service.publishConnectProjection(ownerSession(), {
        expectedAccessRoute: null,
        schemaVersion: 2,
        state: "disabled",
      }),
    ).resolves.toBeUndefined();

    expect(await service.status()).toEqual(before);
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
      database: ownerAuthority(fixture.database) as never,
      fetch,
      grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
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
        id: ownerId,
        image: null,
      },
    },
    surface: credentialKind === "browser-cookie" ? "canonical" : "personal-remote",
  };
}

/**
 * One optional row behind the chained builder, which is how both the
 * an absent singleton read.
 */
function rowQuery<T>(row: T) {
  return {
    execute: vi.fn(async () => []),
    innerJoin() {
      return this;
    },
    selectAll() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
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

/**
 * The one stored remote-access row, answered from a mutable state object so a
 * second `configure` reads back exactly what the first one wrote.
 */
function configureDatabase(
  initial: {
    readonly generation: number;
    readonly mode: "off" | "connect" | "private";
    readonly routeOrigin: string | null;
  },
  /** The latest Remote access operation: by default, the person's unfinished request for private. */
  operation: { readonly intent: Record<string, unknown>; readonly state: string } | null = {
    intent: { action: "configure", mode: "private" },
    state: "running",
  },
) {
  let state = { ...initial };
  const operationQuery = rowQuery(operation ?? undefined);
  const remoteAccessQuery = {
    executeTakeFirstOrThrow: vi.fn(async () => state),
    forNoKeyUpdate() {
      return this;
    },
    leftJoin() {
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
  const marker = rowQuery(undefined);
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
      table === "personalRemoteAccess"
        ? remoteAccessQuery
        : table === "authSessions"
          ? liveSessionQuery()
          : table === "personalRemoteAdministration"
            ? operationQuery
            : marker,
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
  /** The latest Remote access operation; none by default. */
  operation: { readonly intent: Record<string, unknown>; readonly state: string } | null = null,
) {
  const operationQuery = rowQuery(operation ?? undefined);
  /** What the steps put on record for the person's activity. */
  const audits: Record<string, unknown>[] = [];
  const link = {
    accountOperation: null as import("kysely").Selectable<
      import("@opensteer/database").DatabaseSchema["personalRemoteAccountLink"]
    >["accountOperation"],
    challengeId: `phc_${crypto.randomUUID()}`,
    grantId: `phg_${crypto.randomUUID()}`,
    hostCredential,
    issuer: linkedIssuer,
    linkGeneration: "g".repeat(43),
    state: "active",
    singletonKey: "opensteer-account",
    subject: `acct_${crypto.randomUUID()}`,
  };
  const remoteAccessQuery = {
    executeTakeFirstOrThrow: vi.fn(async () => ({
      ...remoteAccessState,
      accountIssuer: link.issuer,
      accountGeneration: link.linkGeneration,
      accountState: link.state,
      accountSubject: link.subject,
    })),
    leftJoin() {
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
  const linkQuery = {
    forNoKeyUpdate() {
      return this;
    },
    forUpdate() {
      return this;
    },
    executeTakeFirst: vi.fn(async () => link),
    leftJoin() {
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
  return {
    audits,
    selectFrom: vi.fn((table: string) =>
      table === "personalRemoteAccess"
        ? remoteAccessQuery
        : table === "personalRemoteAdministration"
          ? operationQuery
          : linkQuery,
    ),
    transaction: () => ({
      execute: (run: (value: unknown) => unknown) =>
        run({
          getExecutor: () => ({
            compileQuery: () => ({}),
            executeQuery: vi.fn(async () => ({ rows: [] })),
            transformQuery: (node: unknown) => node,
          }),
          insertInto: (table: string) => ({
            values(row: Record<string, unknown>) {
              if (table === "securityAudit") audits.push(row);
              return this;
            },
            execute: async () => [],
          }),
          updateTable: () => ({
            set(values: Partial<typeof link>) {
              Object.assign(link, values);
              return this;
            },
            where() {
              return this;
            },
            executeTakeFirstOrThrow: async () => ({ numUpdatedRows: 1n }),
          }),
          selectFrom: vi.fn((table: string) =>
            table === "authSessions"
              ? liveSessionQuery()
              : table === "personalRemoteAccess"
                ? remoteAccessQuery
                : table === "personalRemoteAdministration"
                  ? operationQuery
                  : linkQuery,
          ),
        }),
    }),
  };
}

function accountLink(issuer: string) {
  return {
    accountOperation: null as import("kysely").Selectable<
      import("@opensteer/database").DatabaseSchema["personalRemoteAccountLink"]
    >["accountOperation"],
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
  const emptyQuery = rowQuery(undefined);
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
    forUpdate() {
      return this;
    },
    forNoKeyUpdate() {
      return this;
    },
    leftJoin() {
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
    executeTakeFirstOrThrow: vi.fn(async () => ({ numUpdatedRows: 1n })),
    set(values: Partial<typeof link>) {
      Object.assign(link, values);
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
    insertInto: () => ({
      values() {
        return this;
      },
      execute: async () => [],
    }),
    deleteFrom: vi.fn((table: string) =>
      table === "personalRemoteAccountLink"
        ? deleteQuery
        : table === "personalAccountLinkKeys"
          ? {
              execute: async () => [],
              where() {
                return this;
              },
            }
          : authSessionDeleteQuery,
    ),
    getExecutor: () => ({
      compileQuery: () => ({}),
      executeQuery: vi.fn(async () => ({ rows: [] })),
      transformQuery: (node: unknown) => node,
    }),
    updateTable: vi.fn(() => updateLinkQuery),
    selectFrom: vi.fn((table: string) => {
      if (table === "personalRemoteAccess") return remoteAccessQuery;
      if (table === "personalRemoteAccountLink") return linkQuery;
      if (table === "authSessions") return liveSessionQuery();
      return emptyQuery;
    }),
  };
  const statusRemoteAccessQuery = {
    executeTakeFirstOrThrow: vi.fn(async () => ({
      generation: 0,
      mode: "off",
      routeOrigin: null,
      accountIssuer: link.issuer,
      accountGeneration: link.linkGeneration,
      accountState: link.state,
      accountSubject: link.subject,
    })),
    leftJoin() {
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
  return {
    database: {
      selectFrom: vi.fn((table: string) =>
        table === "personalRemoteAccess" ? statusRemoteAccessQuery : linkQuery,
      ),
      transaction: () => ({ execute: (run: (value: unknown) => unknown) => run(transaction) }),
      updateTable: vi.fn(() => updateLinkQuery),
      deleteFrom: () => ({
        where() {
          return this;
        },
        execute: async () => [],
      }),
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

function liveSessionQuery() {
  return rowQuery({ id: createId("authSession"), deviceLabel: "Owner device", userAgent: null });
}

/** The Account answered with this status; its technical line stays out of the message. */
function accountAnswered(status: number) {
  return { request: expect.stringContaining(`HTTP ${status}`), status };
}
