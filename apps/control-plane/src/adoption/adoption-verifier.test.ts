import {
  ControlPlaneAccountIdSchema,
  HostAccountAdoptionProofCredentialSchema,
  HostAccountAdoptionProofIdSchema,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { HttpHostAccountAdoptionProofVerifier } from "./adoption-verifier.js";

describe("HttpHostAccountAdoptionProofVerifier", () => {
  it("consumes a proof bound to the exact Account and Host authority", async () => {
    const input = proofVerification();
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(request.toString()).toBe(
        `${input.authority.canonicalOrigin}/v1/auth/account-adoption/proofs/${input.proofId}/consume`,
      );
      expect(init).toMatchObject({ credentials: "omit", method: "POST", redirect: "manual" });
      expect(JSON.parse(String(init?.body))).toEqual({
        proofCredential: input.proofCredential,
        expectedAccount: input.account,
        expectedAuthority: input.authority,
      });
      return Response.json(
        {
          proofId: input.proofId,
          consumedAt: new Date().toISOString(),
          account: input.account,
          authority: input.authority,
          authorizedBy: {
            userId: createId("user"),
            sessionId: createId("authSession"),
          },
        },
        { headers: { "content-type": "application/json; charset=utf-8" } },
      );
    });

    await expect(
      new HttpHostAccountAdoptionProofVerifier({ fetch }).verify(input),
    ).resolves.toMatchObject({ proofId: input.proofId, authority: input.authority });
  });

  it("rejects cleartext origins, redirects, and receipts for another Account", async () => {
    const input = proofVerification();
    await expect(
      new HttpHostAccountAdoptionProofVerifier({ fetch: vi.fn() }).verify({
        ...input,
        authority: { ...input.authority, canonicalOrigin: "http://127.0.0.1:4310" },
      }),
    ).rejects.toThrow(/public HTTPS/u);

    await expect(
      new HttpHostAccountAdoptionProofVerifier({
        fetch: vi.fn(async () => new Response(null, { status: 307 })),
      }).verify(input),
    ).rejects.toThrow(/rejected/u);

    await expect(
      new HttpHostAccountAdoptionProofVerifier({
        fetch: vi.fn(async () =>
          Response.json(
            {
              proofId: input.proofId,
              consumedAt: new Date().toISOString(),
              account: {
                ...input.account,
                subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
              },
              authority: input.authority,
              authorizedBy: {
                userId: createId("user"),
                sessionId: createId("authSession"),
              },
            },
            { headers: { "content-type": "application/json" } },
          ),
        ),
      }).verify(input),
    ).rejects.toThrow(/does not match/u);

    await expect(
      new HttpHostAccountAdoptionProofVerifier({
        fetch: vi.fn(async () =>
          Response.json(
            {
              proofId: input.proofId,
              consumedAt: new Date().toISOString(),
              account: input.account,
              authority: {
                ...input.authority,
                hostKeyFingerprint: `sha256:${"b".repeat(43)}`,
              },
              authorizedBy: {
                userId: createId("user"),
                sessionId: createId("authSession"),
              },
            },
            { headers: { "content-type": "application/json" } },
          ),
        ),
      }).verify(input),
    ).rejects.toThrow(/does not match/u);
  });
});

function proofVerification() {
  return {
    proofId: HostAccountAdoptionProofIdSchema.parse(`hap_${crypto.randomUUID()}`),
    proofCredential: HostAccountAdoptionProofCredentialSchema.parse(`oap_${"A".repeat(43)}`),
    account: {
      issuer: "https://accounts.example",
      subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    },
    authority: {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      canonicalOrigin: "https://self-host.example",
      hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
    },
  } as const;
}
