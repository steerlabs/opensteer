import {
  AccountLinkGenerationSchema,
  PersonalHostAccountLinkChallengeIdSchema,
  PersonalHostAccessRouteEnvelopeSchema,
} from "@opensteer/control-plane-protocol";
import { HostDiscoveryEnvelopeSchema } from "@opensteer/deployment-authority";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { AccountDirectoryClient as NativeAccountDirectoryClient } from "./account-directory-client.js";

const deployment = {
  activeHostInstanceId: createId("hostInstance"),
  lifecycle: "active",
} as const;
const authorityEnvelope = HostDiscoveryEnvelopeSchema.parse({
  document: {
    canonicalOrigin: "https://host.opensteer.test",
    deploymentId: createId("deployment"),
    hostInstanceId: deployment.activeHostInstanceId,
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: {
      defaultWorkspaceBacking: "portablefs",
      kind: "server" as const,
    },
  },
  publicKey: { algorithm: "Ed25519", spki: "a".repeat(59) },
  signature: "a".repeat(86),
});
class AccountDirectoryClient extends NativeAccountDirectoryClient {
  constructor(
    options: Omit<
      ConstructorParameters<typeof NativeAccountDirectoryClient>[0],
      "authorityEnvelope"
    > & {
      readonly authorityEnvelope?: typeof authorityEnvelope;
    },
  ) {
    super({ authorityEnvelope, ...options });
  }
}
const accountId = "acct_00000000-0000-4000-8000-000000000123";
const projection = {
  accountId,
  attempts: 1,
  generation: 4,
  leaseToken: "lease-token",
  observedAt: "2026-08-11T19:00:00.000Z",
  present: true,
  providerId: "official-provider",
  userId: createId("user"),
} as const;
const personalAccessRoute = PersonalHostAccessRouteEnvelopeSchema.parse({
  document: {
    authority: {
      ...authorityEnvelope.document,
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    },
    documentVersion: 2,
    purpose: "opensteer-personal-access-route",
    route: {
      generation: 3,
      kind: "connect",
      origin: "https://personal.connect.opensteer.test",
    },
  },
  publicKey: { algorithm: "Ed25519", spki: "a".repeat(59) },
  schemaVersion: 1,
  signature: "a".repeat(86),
});

describe("AccountDirectoryClient", () => {
  it("publishes a fenced idempotent projection and validates its acknowledgement", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input.toString()).toBe(
        `https://control.opensteer.test/v1/host/directory/${accountId}`,
      );
      expect(init).toMatchObject({
        headers: expect.objectContaining({ authorization: `Bearer osc_${"a".repeat(43)}` }),
        method: "PUT",
        redirect: "manual",
      });
      // Identity has exactly one publication path, and it is not this one.
      expect(JSON.parse(String(init?.body))).toEqual({
        generation: 4,
        hostInstanceId: deployment.activeHostInstanceId,
        observedAt: projection.observedAt,
        present: true,
      });
      expect(String(init?.body)).not.toContain(projection.userId);
      return Response.json({
        accountId: projection.accountId,
        generation: projection.generation,
        present: projection.present,
      });
    });
    const client = new AccountDirectoryClient({
      authorityEnvelope,
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch,
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(client.publish(projection)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a Host authority acknowledgement for another Deployment", async () => {
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () => Response.json({ deploymentId: createId("deployment"), published: true }),
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(client.publishAuthority()).rejects.toThrow(/different Deployment/);
  });

  it("keeps a refused Host authority publication retryable without leaking the credential", async () => {
    const credential = `osc_${"b".repeat(43)}`;
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () => new Response(credential, { status: 404 }),
      hostCredential: credential,
    });

    let failure: unknown;
    try {
      await client.publishAuthority();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "Host authority publication API returned HTTP 404",
    });
    expect(String(failure)).not.toContain(credential);
  });

  it("publishes Personal Connect route authority without a caller-owned liveness timestamp", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input.toString()).toBe("https://control.opensteer.test/v1/host/connect");
      expect(JSON.parse(String(init?.body))).toEqual({
        accessRoute: personalAccessRoute,
        generation: 3,
        hostInstanceId: deployment.activeHostInstanceId,
        origin: "https://personal.connect.opensteer.test",
        state: "ready",
      });
      return Response.json({
        accessRoute: personalAccessRoute,
        generation: 3,
        lastSeenAt: "2026-08-22T22:30:00.000Z",
        origin: "https://personal.connect.opensteer.test",
        state: "ready",
      });
    });
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch,
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(
      client.publishPersonalConnect({
        accessRoute: personalAccessRoute,
        generation: 3,
        state: "ready",
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    {
      code: "not_found",
      error: "PersonalAccountLinkNotFoundError",
      errorCode: "personal-account-link-not-found",
      reason: "personal-account-link-not-found",
      status: 404,
    },
    {
      code: "conflict",
      error: "PersonalAccountLinkActivationExpiredError",
      errorCode: "personal-account-link-activation-expired",
      reason: "personal-account-link-reservation-expired",
      status: 409,
    },
    {
      code: "conflict",
      error: "PersonalAccountLinkCancelledError",
      errorCode: "personal-account-link-cancelled",
      reason: "personal-account-link-cancelled",
      status: 409,
    },
  ])("classifies the $reason activation refusal as a durable answer", async (expected) => {
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () =>
        Response.json(
          { error: { code: expected.code, message: "refused", reason: expected.reason } },
          { status: expected.status },
        ),
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(
      client.activatePersonalAccountLink({
        challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
        linkGeneration: AccountLinkGenerationSchema.parse("g".repeat(43)),
      }),
    ).rejects.toMatchObject({ code: expected.errorCode, name: expected.error });
  });

  it("keeps an unreasoned activation refusal a transport failure", async () => {
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () =>
        Response.json({ error: { code: "conflict", message: "refused" } }, { status: 409 }),
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(
      client.activatePersonalAccountLink({
        challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
        linkGeneration: AccountLinkGenerationSchema.parse("g".repeat(43)),
      }),
    ).rejects.toThrow(/returned HTTP 409/);
  });

  it("reports a Personal unlink the Account has no record of as not found", async () => {
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () =>
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
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(
      client.unlinkPersonalHost({
        challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
        linkGeneration: AccountLinkGenerationSchema.parse("g".repeat(43)),
      }),
    ).rejects.toMatchObject({
      code: "personal-account-link-not-found",
      name: "PersonalAccountLinkNotFoundError",
    });
  });

  it("keeps an unreasoned Personal unlink failure retryable", async () => {
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () => new Response(null, { status: 503 }),
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(
      client.unlinkPersonalHost({
        challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
        linkGeneration: AccountLinkGenerationSchema.parse("g".repeat(43)),
      }),
    ).rejects.toThrow(/returned HTTP 503/);
  });

  it("rejects a Personal unlink acknowledgement for another Deployment", async () => {
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () =>
        Response.json({
          deploymentId: createId("deployment"),
          unlinked: true,
        }),
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(
      client.unlinkPersonalHost({
        challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(`phc_${crypto.randomUUID()}`),
        linkGeneration: AccountLinkGenerationSchema.parse("g".repeat(43)),
      }),
    ).rejects.toThrow(/different Deployment/);
  });

  it("rejects inactive authority and oversized response bodies", async () => {
    expect(
      () =>
        new AccountDirectoryClient({
          controlApiOrigin: new URL("https://control.opensteer.test"),
          deployment: { ...deployment, lifecycle: "transferring" },
          hostCredential: `osc_${"a".repeat(43)}`,
        }),
    ).toThrow(/active Deployment authority/);

    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () =>
        new Response(JSON.stringify({ content: "x".repeat(20_000) }), { status: 200 }),
      hostCredential: `osc_${"a".repeat(43)}`,
    });
    await expect(client.publish(projection)).rejects.toThrow(/size limit/);
  });

  it("rejects an invalid Account identity before making a network request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch,
      hostCredential: `osc_${"a".repeat(43)}`,
    });

    await expect(
      client.publish({ ...projection, accountId: "not-an-account-id" }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not expose its Host credential when the network layer fails", async () => {
    const credential = `osc_${"a".repeat(43)}`;
    const client = new AccountDirectoryClient({
      controlApiOrigin: new URL("https://control.opensteer.test"),
      deployment,
      fetch: async () => {
        throw new Error(`request failed with Bearer ${credential}`);
      },
      hostCredential: credential,
    });

    let failure: unknown;
    try {
      await client.publish(projection);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: "Account directory API request failed" });
    expect(String(failure)).not.toContain(credential);
  });
});
