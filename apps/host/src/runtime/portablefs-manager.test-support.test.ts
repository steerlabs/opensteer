import { generateKeyPairSync } from "node:crypto";
import {
  Ed25519PortableFsProductAuthorizationSigner,
  PortableFsManagerClient,
  portableFsCsrSpkiSha256,
} from "@opensteer/workspace-portablefs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startPortableFsManagerFake,
  type PortableFsManagerFake,
} from "./portablefs-manager.test-support.js";

const csrPem = `-----BEGIN CERTIFICATE REQUEST-----
MIGOMEICAQAwDzENMAsGA1UEAwwEdGVzdDAqMAUGAytlcAMhAAYGrSfAi57mfReG
R2aFY+3K8yYGH4DbIXXJcl5SkdT5oAAwBQYDK2VwA0EAGrT0jM/3L4H0b3NNmPWi
y8bGphvw7IH69FOsfMn8nAJYBRlR9UD0j4soZYoYkT+zjZ/iO4FIwasapMoVchkt
Cw==
-----END CERTIFICATE REQUEST-----
`;

describe("PortableFS Manager fake renewal fences", () => {
  let fake: PortableFsManagerFake;
  let manager: PortableFsManagerClient;
  let signer: Ed25519PortableFsProductAuthorizationSigner;

  beforeEach(async () => {
    fake = await startPortableFsManagerFake();
    const keys = generateKeyPairSync("ed25519");
    signer = new Ed25519PortableFsProductAuthorizationSigner(keys.privateKey);
    manager = new PortableFsManagerClient({
      authorizationDomain: "opensteer-test",
      baseUrl: fake.url,
      mountEndpoint: fake.mountEndpoint,
      productIssuer: "opensteer-test",
      signer,
    });
  });

  afterEach(async () => {
    await fake.close();
  });

  it("validates a whole batch before applying it and returns final floors in request order", async () => {
    await expect(
      manager.advanceRenewalFences("status-sweep", [
        { epoch: 2, scope: "scope-one" },
        { epoch: 5, scope: "scope-two" },
      ]),
    ).resolves.toEqual({
      fences: [
        { epoch: 2, scope: "scope-one" },
        { epoch: 5, scope: "scope-two" },
      ],
    });

    const invalid = await fetch(new URL("/v1/renewal-fences", fake.url), {
      body: JSON.stringify({
        fences: [
          { epoch: 9, scope: "scope-one" },
          { epoch: 1, scope: "" },
        ],
        reason: "invalid-batch",
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    expect(invalid.status).toBe(400);

    await expect(
      manager.advanceRenewalFences("lower-replay", [
        { epoch: 1, scope: "scope-one" },
        { epoch: 3, scope: "scope-one" },
      ]),
    ).resolves.toEqual({
      fences: [
        { epoch: 3, scope: "scope-one" },
        { epoch: 3, scope: "scope-one" },
      ],
    });
    expect(fake.requests.filter((request) => request.path === "/v1/renewal-fences")).toEqual([
      expect.objectContaining({ idempotencyKey: undefined }),
      expect.objectContaining({ idempotencyKey: undefined }),
      expect.objectContaining({ idempotencyKey: undefined }),
    ]);
  });

  it("keeps equal-epoch enrollments admitted and revokes only strictly lower epochs", async () => {
    const volume = await manager.createVolume(
      { owner: "owner", quotaBytes: 1024, quotaInodes: 1 },
      { idempotencyKey: "create-fence-test-volume" },
    );
    const now = Math.floor(Date.now() / 1_000);
    const grant = await manager.issueAutomaticMountGrant(
      volume.id,
      {
        access: "write",
        authorization: {
          expiresUnix: now + 300,
          nonce: "issue-at-epoch-two",
          notBeforeUnix: now - 5,
        },
        clientCertificateRequestPem: csrPem,
        owner: volume.owner,
        renewalEpoch: 2,
        renewalScope: "strict-lower-scope",
        subject: "strict-lower-test",
      },
      { idempotencyKey: "issue-at-epoch-two" },
    );

    await manager.advanceRenewalFences("equal-floor", [{ epoch: 2, scope: "strict-lower-scope" }]);
    expect(fake.enrollment(grant.enrollment.id)).toEqual({
      state: "ACTIVE",
      terminationReason: undefined,
    });

    await manager.advanceRenewalFences("stopped-floor", [
      { epoch: 3, scope: "strict-lower-scope" },
    ]);
    expect(fake.enrollment(grant.enrollment.id)).toEqual({
      state: "REVOKED",
      terminationReason: "stopped-floor",
    });
  });

  it("admits scoped grant-only issuance and revokes only lower enrollment epochs", async () => {
    const volume = await manager.createVolume(
      { owner: "owner", quotaBytes: 1024, quotaInodes: 1 },
      { idempotencyKey: "create-grant-only-volume" },
    );
    const now = Math.floor(Date.now() / 1_000);
    const issueEnrollment = (epoch: number, nonce: string) =>
      manager.issueAutomaticMountGrant(
        volume.id,
        {
          access: "write",
          authorization: { expiresUnix: now + 300, nonce, notBeforeUnix: now - 5 },
          clientCertificateRequestPem: csrPem,
          owner: volume.owner,
          renewalEpoch: epoch,
          renewalScope: "grant-only-scope",
          subject: "grant-only-test",
        },
        { idempotencyKey: nonce },
      );
    const issueGrantOnly = async (
      epoch: number,
      nonce: string,
    ): Promise<Record<string, unknown>> => {
      const productAuthorization = signer.sign({
        access: ["read"],
        audience: "portablefs-manager",
        authorizationDomain: "opensteer-test",
        expires: now + 300,
        issuer: "opensteer-test",
        nonce,
        notBefore: now - 5,
        owner: volume.owner,
        peerSpkiSha256: portableFsCsrSpkiSha256(csrPem),
        renewalEpoch: epoch,
        renewalScope: "grant-only-scope",
        subject: "grant-only-test",
        volumeId: volume.id,
      });
      const response = await fetch(new URL("/v1/mount-authorizations", fake.url), {
        body: JSON.stringify({
          access: ["read"],
          automatic_reauthorization: false,
          client_csr_pem: csrPem,
          product_authorization: productAuthorization,
          volume_id: volume.id,
        }),
        headers: { "content-type": "application/json", "idempotency-key": nonce },
        method: "POST",
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };

    const lower = await issueEnrollment(1, "grant-only-lower-enrollment");
    await expect(issueGrantOnly(2, "grant-only-advance")).resolves.not.toHaveProperty(
      "enrollment_id",
    );
    expect(fake.enrollment(lower.enrollment.id)).toEqual({
      state: "REVOKED",
      terminationReason: "renewal-scope-superseded",
    });

    const equal = await issueEnrollment(2, "grant-only-equal-enrollment");
    await issueGrantOnly(2, "grant-only-equal");
    expect(fake.enrollment(equal.enrollment.id)).toEqual({
      state: "ACTIVE",
      terminationReason: undefined,
    });
  });

  it("rejects Idempotency-Key on both convergent PUT routes", async () => {
    const volume = await manager.createVolume(
      { owner: "owner", quotaBytes: 1024, quotaInodes: 1 },
      { idempotencyKey: "create-convergent-header-volume" },
    );
    const now = Math.floor(Date.now() / 1_000);
    const grant = await manager.issueAutomaticMountGrant(
      volume.id,
      {
        access: "write",
        authorization: {
          expiresUnix: now + 300,
          nonce: "convergent-header-enrollment",
          notBeforeUnix: now - 5,
        },
        clientCertificateRequestPem: csrPem,
        owner: volume.owner,
        subject: "convergent-header-test",
      },
      { idempotencyKey: "convergent-header-enrollment" },
    );
    const headers = {
      "content-type": "application/json",
      "idempotency-key": "forbidden-on-convergent-put",
    };
    const revocation = await fetch(
      new URL(
        `/v1/volumes/${volume.id}/mount-enrollments/${grant.enrollment.id}/revocation`,
        fake.url,
      ),
      {
        body: JSON.stringify({ reason: "header-rejection" }),
        headers,
        method: "PUT",
      },
    );
    expect(revocation.status).toBe(400);
    await expect(revocation.json()).resolves.toEqual({ error: "Idempotency-Key is not accepted" });
    expect(fake.enrollment(grant.enrollment.id)?.state).toBe("ACTIVE");

    const fence = await fetch(new URL("/v1/renewal-fences", fake.url), {
      body: JSON.stringify({
        fences: [{ epoch: 2, scope: "convergent-header-scope" }],
        reason: "header-rejection",
      }),
      headers,
      method: "PUT",
    });
    expect(fence.status).toBe(400);
    await expect(fence.json()).resolves.toEqual({ error: "Idempotency-Key is not accepted" });
  });

  it("rejects a batch that would exceed the 65536-fence Manager cap", async () => {
    for (let batch = 0; batch < 16; batch += 1) {
      await manager.advanceRenewalFences(
        `fill-fence-cap-${batch}`,
        Array.from({ length: 4_096 }, (_, index) => ({
          epoch: 1,
          scope: `cap-${batch}-${index}`,
        })),
      );
    }

    await expect(
      manager.advanceRenewalFences("exceed-fence-cap", [{ epoch: 1, scope: "cap-overflow" }]),
    ).rejects.toMatchObject({
      httpStatus: 409,
      message: "controlplane: renewal fence capacity reached",
    });
  }, 20_000);
});
