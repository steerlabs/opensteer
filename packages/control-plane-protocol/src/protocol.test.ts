import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  AdoptExistingDeploymentRequestSchema,
  AccountDeploymentSchema,
  ConnectProjectionRequestSchema,
  CompletePersonalHostAccountLinkResponseSchema,
  ControlPlaneAccountIdSchema,
  ControlPlaneErrorReasonSchema,
  ControlPlaneErrorResponseSchema,
  DeploymentProvisioningResultSchema,
  ListAccountDeploymentsResponseSchema,
  DeploymentOriginSchema,
  DirectoryProjectionRequestSchema,
  PublishHostAuthorityRequestSchema,
  HostAccountAdoptionProofCredentialSchema,
  HostAccountAdoptionProofIdSchema,
  ManagedHostProvisioningBundleSchema,
  adoptedHostProvisioningBundle,
} from "./index.js";

describe("control-plane protocol", () => {
  it("normalizes bare origins and accepts loopback development hosts", () => {
    expect(DeploymentOriginSchema.parse("https://host.example:8443/")).toBe(
      "https://host.example:8443",
    );
    expect(DeploymentOriginSchema.parse("http://127.0.0.1:4141")).toBe("http://127.0.0.1:4141");
  });

  it.each([
    "http://host.example",
    "https://host.example/path",
    "https://user:password@host.example",
    "https://host.example?secret=value",
    "https://host.example/#fragment",
  ])("rejects unsafe deployment origin %s", (origin) => {
    expect(DeploymentOriginSchema.safeParse(origin).success).toBe(false);
  });

  it("publishes the exact machine reasons a client is expected to branch on", () => {
    expect(ControlPlaneErrorReasonSchema.options).toEqual([
      "personal-account-link-challenge-expired",
      "personal-account-link-reservation-expired",
      "personal-account-link-cancelled",
      "personal-account-link-not-found",
      "personal-account-link-already-active",
      "personal-host-already-linked",
      "account-deployment-quota-exceeded",
      "connect-resource-active",
      "push-not-configured",
      "device-limit",
    ]);
    expect(
      ControlPlaneErrorResponseSchema.safeParse({
        error: { code: "conflict", message: "gone", reason: "connect-resource-active" },
      }).success,
    ).toBe(true);
    expect(
      ControlPlaneErrorResponseSchema.safeParse({
        error: { code: "conflict", message: "gone", reason: "invented-reason" },
      }).success,
    ).toBe(false);
  });

  it("keeps a Personal link completion free of any Deployment the Host has not made", () => {
    const completion = {
      completionGrant: `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`,
      hostCredential: `osc_${"d".repeat(43)}`,
      linkGeneration: "g".repeat(43),
      resultExpiresAt: new Date().toISOString(),
    } as const;
    expect(CompletePersonalHostAccountLinkResponseSchema.parse(completion)).toEqual(completion);
    // An Account response tolerates fields a newer Account added, and drops
    // them: tolerance is what keeps an older Desktop working, and dropping is
    // what keeps a Deployment the Host has not made out of the completion.
    expect(
      CompletePersonalHostAccountLinkResponseSchema.parse({
        ...completion,
        reservation: { reachability: "routed" },
      }),
    ).toEqual(completion);
  });

  it("requires fenced positive generations for Host projections", () => {
    const result = DirectoryProjectionRequestSchema.safeParse({
      hostInstanceId: createId("hostInstance"),
      generation: 0,
      present: true,
      observedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("keeps Host identity out of membership projections", () => {
    const projection = {
      hostInstanceId: createId("hostInstance"),
      generation: 1,
      present: true,
      observedAt: new Date().toISOString(),
    };
    expect(DirectoryProjectionRequestSchema.safeParse(projection).success).toBe(true);
    expect(
      DirectoryProjectionRequestSchema.safeParse({ ...projection, authorityEnvelope: {} }).success,
    ).toBe(false);
    expect(PublishHostAuthorityRequestSchema.safeParse({}).success).toBe(false);
  });

  it("requires a Connect origin only for routable states", () => {
    const base = {
      hostInstanceId: createId("hostInstance"),
      generation: 1,
    };
    expect(
      ConnectProjectionRequestSchema.safeParse({ ...base, state: "ready", origin: null }).success,
    ).toBe(false);
    expect(
      ConnectProjectionRequestSchema.safeParse({
        ...base,
        state: "provisioning",
        origin: "https://connect.example",
      }).success,
    ).toBe(false);
    expect(
      ConnectProjectionRequestSchema.safeParse({
        ...base,
        state: "ready",
        origin: "https://connect.example",
      }).success,
    ).toBe(true);
    expect(
      ConnectProjectionRequestSchema.safeParse({
        ...base,
        observedAt: new Date().toISOString(),
        state: "ready",
        origin: "https://connect.example",
      }).success,
    ).toBe(false);
  });

  it("bounds Account catalogs", () => {
    const deployment = {
      access: "owner" as const,
      generation: 1,
      reachability: "canonical" as const,
      id: createId("deployment"),
      lifecycle: "provisioning" as const,
      name: "Host",
      provisioning: {
        detail: null,
        operationId: "directory:test",
        state: "awaiting-host" as const,
      },
      updatedAt: new Date().toISOString(),
    };
    expect(
      ListAccountDeploymentsResponseSchema.safeParse({
        deployments: Array.from({ length: 101 }, () => deployment),
      }).success,
    ).toBe(false);
  });

  it("keeps historical signed artifacts opaque at the Account directory boundary", () => {
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const response = ListAccountDeploymentsResponseSchema.parse({
      deployments: [
        {
          access: "owner",
          authority: {
            canonicalOrigin: "https://historical.example",
            deploymentId,
            hostInstanceId,
            hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
          },
          authorityEnvelope: {
            document: { invalid: true },
            publicKey: { algorithm: "Ed25519", spki: "historical" },
            signature: "historical",
          },
          canonicalOrigin: "https://historical.example",
          generation: 1,
          reachability: "canonical",
          id: deploymentId,
          lifecycle: "active",
          name: "Historical Host",
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    expect(response.deployments).toHaveLength(1);
  });

  it("requires a one-use proof for the full current self-hosted authority", () => {
    const authority = {
      canonicalOrigin: "https://verified.example",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: `sha256:${"k".repeat(43)}`,
    };
    const proof = {
      proofId: HostAccountAdoptionProofIdSchema.parse(`hap_${crypto.randomUUID()}`),
      proofCredential: HostAccountAdoptionProofCredentialSchema.parse(`oap_${"A".repeat(43)}`),
    };
    expect(
      AdoptExistingDeploymentRequestSchema.parse({
        authority,
        reachability: "canonical",
        name: "Existing Host",
        proof,
      }).authority.deploymentId,
    ).toBe(authority.deploymentId);
    expect(
      AdoptExistingDeploymentRequestSchema.safeParse({
        authority,
        reachability: "canonical",
        name: "Existing Host",
      }).success,
    ).toBe(false);
    expect(
      AdoptExistingDeploymentRequestSchema.safeParse({
        authority,
        reachability: "canonical",
        name: "Existing Host",
        proof,
        email: "owner@example.test",
      }).success,
    ).toBe(false);
  });

  it("builds an adoption bundle from the proved Host identity without matching by email", () => {
    const accountId = ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
    const authority = {
      canonicalOrigin: "https://existing.example",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: `sha256:${"k".repeat(43)}`,
    };
    const request = AdoptExistingDeploymentRequestSchema.parse({
      authority,
      reachability: "canonical",
      name: "Existing Host",
      proof: {
        proofId: `hap_${crypto.randomUUID()}`,
        proofCredential: `oap_${"A".repeat(43)}`,
      },
    });
    const provisioning = DeploymentProvisioningResultSchema.parse({
      deployment: {
        id: authority.deploymentId,
        reachability: "canonical",
      },
      hostCredential: `osc_${"B".repeat(43)}`,
      owner: {
        subject: accountId,
        email: "display-only@example.test",
        displayName: "Owner",
      },
      oidc: {
        clientId: "opensteer-host-client",
        issuer: "https://accounts.example",
        redirectUri: `${authority.canonicalOrigin}/v1/auth/oidc/callback`,
        scopes: ["openid", "profile", "email"],
        tokenEndpointAuthMethod: "client_secret_basic",
        requirePkce: true,
      },
      oidcClientSecret: `ocs_${"C".repeat(43)}`,
    });
    const response = adoptedHostProvisioningBundle(
      "https://accounts.example",
      request,
      provisioning,
    );
    expect(response).toMatchObject({
      deployment: { ...authority, reachability: "canonical" },
      provisioningMode: "adoption",
    });
    expect("owner" in response).toBe(false);
  });

  it("binds provisioning mode to canonical reachability", () => {
    const canonicalOrigin = "https://host.example";
    const base = {
      controlApiOrigin: "https://accounts.example",
      deployment: {
        canonicalOrigin,
        deploymentId: createId("deployment"),
        hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
        hostInstanceId: createId("hostInstance"),
      },
      hostCredential: `osc_${"A".repeat(43)}`,
      oidc: {
        clientId: "opensteer-host-client",
        issuer: "https://accounts.example",
        redirectUri: `${canonicalOrigin}/v1/auth/oidc/callback`,
        scopes: ["openid", "profile", "email"],
        tokenEndpointAuthMethod: "client_secret_basic",
        requirePkce: true,
      },
      oidcClientSecret: `ocs_${"B".repeat(43)}`,
    } as const;
    expect(
      ManagedHostProvisioningBundleSchema.safeParse({
        ...base,
        deployment: { ...base.deployment, reachability: "canonical" },
        initialRunnerEnrollmentToken: "runner-enrollment-token".padEnd(32, "x"),
        provisioningMode: "managed",
        owner: {
          subject: `acct_${crypto.randomUUID()}`,
          email: "owner@example.test",
          displayName: "Owner",
        },
      }).success,
    ).toBe(true);
    expect(
      ManagedHostProvisioningBundleSchema.safeParse({
        ...base,
        deployment: { ...base.deployment, reachability: "routed" },
        provisioningMode: "adoption",
      }).success,
    ).toBe(false);
  });

  it("rejects an adoption result that changes any proved authority field", () => {
    const authority = {
      canonicalOrigin: "https://existing.example",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: `sha256:${"k".repeat(43)}`,
    };
    const request = AdoptExistingDeploymentRequestSchema.parse({
      authority,
      reachability: "canonical",
      name: "Existing Host",
      proof: {
        proofId: `hap_${crypto.randomUUID()}`,
        proofCredential: `oap_${"A".repeat(43)}`,
      },
    });
    const baseResult = DeploymentProvisioningResultSchema.parse({
      deployment: {
        id: authority.deploymentId,
        reachability: "canonical" as const,
      },
      hostCredential: `osc_${"B".repeat(43)}`,
      owner: {
        subject: `acct_${crypto.randomUUID()}`,
        email: "owner@example.test",
        displayName: "Owner",
      },
      oidc: {
        clientId: "opensteer-host-client",
        issuer: "https://accounts.example",
        redirectUri: `${authority.canonicalOrigin}/v1/auth/oidc/callback`,
        scopes: ["openid", "profile", "email"],
        tokenEndpointAuthMethod: "client_secret_basic" as const,
        requirePkce: true as const,
      },
      oidcClientSecret: `ocs_${"C".repeat(43)}`,
    });
    expect(() =>
      adoptedHostProvisioningBundle("https://accounts.example", request, {
        ...baseResult,
        deployment: {
          ...baseResult.deployment,
          id: createId("deployment"),
        },
      }),
    ).toThrow(/does not match the proved Host authority/u);
  });

  it("requires signed authority for an active Personal directory record", () => {
    const deploymentId = createId("deployment");
    const authority = {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId,
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    } as const;
    const authorityEnvelope = {
      document: authority,
      publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
      signature: "A".repeat(86),
    } as const;
    const common = {
      access: "owner",
      generation: 1,
      reachability: "routed",
      id: deploymentId,
      name: "Studio Mac",
      updatedAt: "2026-08-20T12:00:00.000Z",
    } as const;
    expect(AccountDeploymentSchema.safeParse({ ...common, lifecycle: "active" }).success).toBe(
      false,
    );

    const off = AccountDeploymentSchema.parse({
      ...common,
      accountLink: {
        generation: "g".repeat(43),
        issuer: "https://account.opensteer.test",
        subject: `acct_${crypto.randomUUID()}`,
      },
      authorityEnvelope,
      connectResourceState: "disabled",
      connectRoute: null,
      lastSeenAt: null,
      lifecycle: "active",
    });
    if (off.lifecycle !== "active" || off.reachability !== "routed") {
      throw new Error("Expected active Personal directory record");
    }
    expect(off.connectRoute).toBeNull();
    expect(off.connectResourceState).toBe("disabled");

    const route = {
      document: {
        authority,
        documentVersion: 2,
        purpose: "opensteer-personal-access-route",
        route: { generation: 2, kind: "connect", origin: "https://studio.example.test" },
      },
      publicKey: authorityEnvelope.publicKey,
      schemaVersion: 1,
      signature: "A".repeat(86),
    } as const;
    const observed = {
      ...off,
      connectResourceState: "ready",
      connectRoute: route,
      lastSeenAt: {
        expiresAt: "2026-08-20T12:02:00.000Z",
        observedAt: "2026-08-20T12:00:00.000Z",
      },
    } as const;
    const live = AccountDeploymentSchema.parse(observed);
    if (live.lifecycle !== "active" || live.reachability !== "routed") {
      throw new Error("Expected active Personal directory record");
    }
    // A record may carry the route without an observation — that is simply a
    // computer nobody has heard from yet. Reading those two facts as a status
    // belongs to `deploymentStatusFromPersonalConnect` in @opensteer/protocol,
    // not to this schema.
    expect(AccountDeploymentSchema.safeParse({ ...observed, lastSeenAt: null }).success).toBe(true);
    expect(AccountDeploymentSchema.safeParse({ ...observed, connectRoute: null }).success).toBe(
      true,
    );
    const canonical = {
      access: "owner",
      authorityEnvelope,
      canonicalOrigin: authority.canonicalOrigin,
      generation: 1,
      id: deploymentId,
      lifecycle: "active",
      name: "Host",
      reachability: "canonical",
      updatedAt: "2026-08-20T12:00:00.000Z",
    } as const;
    expect(AccountDeploymentSchema.safeParse(canonical).success).toBe(true);
    // A canonical record has no route to carry, so one offered alongside it is
    // dropped rather than admitted. The directory projection stays tolerant of
    // fields a newer Account adds without ever growing a route here.
    expect(AccountDeploymentSchema.parse({ ...canonical, connectRoute: null })).toEqual(canonical);
  });
});
