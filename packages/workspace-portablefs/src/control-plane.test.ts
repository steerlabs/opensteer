import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { TLSSocket } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Ed25519PortableFsProductAuthorizationSigner,
  PortableFsManagerClient,
  portableFsCsrSpkiSha256,
} from "./control-plane.js";
import {
  PortableFsAbortError,
  PortableFsControlPlaneError,
  PortableFsError,
  PortableFsOutputLimitError,
  PortableFsProtocolError,
  PortableFsRenewalScopeFencedError,
  PortableFsTimeoutError,
} from "./errors.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void;

const volumeId = "123e4567-e89b-42d3-a456-426614174000";
const cellId = "11111111-1111-4111-8111-111111111111";
const csrPem = `-----BEGIN CERTIFICATE REQUEST-----
MIGOMEICAQAwDzENMAsGA1UEAwwEdGVzdDAqMAUGAytlcAMhAAYGrSfAi57mfReG
R2aFY+3K8yYGH4DbIXXJcl5SkdT5oAAwBQYDK2VwA0EAGrT0jM/3L4H0b3NNmPWi
y8bGphvw7IH69FOsfMn8nAJYBRlR9UD0j4soZYoYkT+zjZ/iO4FIwasapMoVchkt
Cw==
-----END CERTIFICATE REQUEST-----
`;
const managerVolume = {
  authorization_domain: "opensteer-installation",
  authority_endpoint: "authority.internal:7443",
  authority_generation: 3,
  created_unix: 1_775_995_200,
  id: volumeId,
  owner: "usr_owner",
  placement: {
    authority_id: "authority-1",
    authority_server_name: "authority.internal",
    cell_id: cellId,
    created_unix: 1_775_995_200,
    listen_port: 7443,
    prior_strict_mounts_fenced: false,
    project_id: 42,
    sequence: 1,
    service_gid: 42,
    service_uid: 42,
  },
  placement_sequence: 1,
  pool: "product",
  product_issuer: "opensteer",
  product_public_key_pem: "test-product-public-key",
  quota_bytes: 100 * 1024 * 1024,
  quota_inodes: 100_000,
  state: "READY",
  updated_unix: 1_775_995_300,
} as const;

describe("PortableFsManagerClient", () => {
  let server: Server;
  let baseUrl: URL;
  let handler: Handler;
  const productKeys = generateKeyPairSync("ed25519");

  beforeEach(async () => {
    handler = (_request, response) => sendJson(response, 404, { error: "not found" });
    server = createServer((request, response) => {
      if (
        ignoreForeignTestRequest(
          request,
          response,
          (path) => path === "/healthz" || path.startsWith("/v1/"),
        )
      )
        return;
      Promise.resolve(handler(request, response)).catch((error: unknown) => {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "failed" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}/`);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("checks the authenticated Manager health contract", async () => {
    let seenPath = "";
    handler = (request, response) => {
      seenPath = request.url ?? "";
      sendJson(response, 200, { release_id: "portablefs-test-release", status: "ok" });
    };

    await expect(client(baseUrl, productKeys.privateKey).health()).resolves.toEqual({
      releaseId: "portablefs-test-release",
    });
    expect(seenPath).toBe("/healthz");
  });

  it("reads the Manager v2 capacity wire contract", async () => {
    let seenPath = "";
    handler = (request, response) => {
      seenPath = request.url ?? "";
      sendJson(response, 200, {
        pools: [
          {
            archived_volumes: 0,
            capacity_bytes: 40_000_000_000,
            capacity_inodes: 2_000_000,
            create_admissible: true,
            measured_used_bytes: 52_047_872,
            measured_used_inodes: 1_970,
            pending_bytes: 0,
            pending_inodes: 0,
            placements: 9,
            pool: "product",
            restore_admissible: false,
          },
        ],
      });
    };

    await expect(client(baseUrl, productKeys.privateKey).capacity()).resolves.toMatchObject({
      pools: [
        {
          archived_volumes: 0,
          capacity_bytes: 40_000_000_000,
          capacity_inodes: 2_000_000,
          create_admissible: true,
          measured_used_bytes: 52_047_872,
          measured_used_inodes: 1_970,
          pending_bytes: 0,
          pending_inodes: 0,
          placements: 9,
          pool: "product",
          restore_admissible: false,
        },
      ],
    });
    expect(seenPath).toBe("/v1/capacity");
  });

  it("uses the Manager v2 volume allocation contract", async () => {
    const seen: Array<{ body: unknown; idempotency: string | undefined; path: string }> = [];
    handler = async (request, response) => {
      seen.push({
        body: await readJson(request),
        idempotency: header(request, "idempotency-key"),
        path: request.url ?? "",
      });
      sendJson(response, 200, managerVolume);
    };

    const volume = await client(baseUrl, productKeys.privateKey).createVolume(
      { owner: "usr_owner", quotaBytes: 100 * 1024 * 1024, quotaInodes: 100_000 },
      { idempotencyKey: "workspace-create-1" },
    );

    expect(volume.id).toBe(volumeId);
    expect(seen).toEqual([
      {
        body: {
          authorization_domain: "opensteer-installation",
          owner: "usr_owner",
          product_issuer: "opensteer",
          quota_bytes: 100 * 1024 * 1024,
          quota_inodes: 100_000,
        },
        idempotency: "workspace-create-1",
        path: "/v1/volumes",
      },
    ]);
  });

  it("destroys a volume with a stable idempotency key and accepts already-gone outcomes", async () => {
    const seen: Array<{
      body: unknown;
      idempotency: string | undefined;
      method: string | undefined;
      path: string;
    }> = [];
    handler = async (request, response) => {
      seen.push({
        body: await readJson(request),
        idempotency: header(request, "idempotency-key"),
        method: request.method,
        path: request.url ?? "",
      });
      sendJson(response, 200, { id: volumeId, state: "DESTROYED" });
    };
    const manager = client(baseUrl, productKeys.privateKey);

    await expect(
      manager.destroyVolume(volumeId, { idempotencyKey: "workspace-destroy-1" }),
    ).resolves.toEqual({ id: volumeId, state: "DESTROYED" });
    expect(seen).toEqual([
      {
        body: {
          reason: "workspace deleted",
          volume_id: volumeId,
        },
        idempotency: "workspace-destroy-1",
        method: "DELETE",
        path: `/v1/volumes/${volumeId}`,
      },
    ]);

    for (const status of [404, 410]) {
      handler = (_request, response) => sendJson(response, status, { error: "already gone" });
      await expect(
        manager.destroyVolume(volumeId, { idempotencyKey: `workspace-destroy-${status}` }),
      ).resolves.toEqual({ id: volumeId, state: "DESTROYED" });
    }
  });

  it("observes an idempotently replayed destroy until the volume is terminal", async () => {
    const seen: Array<{ idempotency: string | undefined; method: string | undefined }> = [];
    let observation = "DESTROYING";
    handler = (request, response) => {
      seen.push({
        idempotency: header(request, "idempotency-key"),
        method: request.method,
      });
      sendJson(response, 200, {
        id: volumeId,
        state: request.method === "DELETE" ? "DESTROYING" : observation,
      });
    };
    await probeTestServer(server);
    const manager = client(baseUrl, productKeys.privateKey);

    await expect(
      manager.destroyVolume(volumeId, { idempotencyKey: "workspace-destroy-replay" }),
    ).rejects.toMatchObject({ operation: "destroy-volume", retryable: true });
    observation = "DESTROYED";
    await expect(
      manager.destroyVolume(volumeId, { idempotencyKey: "workspace-destroy-replay" }),
    ).resolves.toEqual({ id: volumeId, state: "DESTROYED" });
    expect(seen).toEqual([
      { idempotency: "workspace-destroy-replay", method: "DELETE" },
      { idempotency: undefined, method: "GET" },
      { idempotency: "workspace-destroy-replay", method: "DELETE" },
      { idempotency: undefined, method: "GET" },
    ]);
  });

  it("accepts a destroy that becomes absent after its initiating response", async () => {
    handler = (request, response) =>
      request.method === "DELETE"
        ? sendJson(response, 200, { id: volumeId, state: "DESTROYING" })
        : sendJson(response, 410, { error: "already gone" });

    await expect(
      client(baseUrl, productKeys.privateKey).destroyVolume(volumeId, {
        idempotencyKey: "workspace-destroy-gone-after-start",
      }),
    ).resolves.toEqual({ id: volumeId, state: "DESTROYED" });
  });

  it("frames a destroy body through the production mTLS transport", async () => {
    const ca = readFileSync(new URL("./test-fixtures/manager-ca.pem", import.meta.url));
    const certificate = readFileSync(
      new URL("./test-fixtures/manager-client.pem", import.meta.url),
    );
    const privateKey = readFileSync(
      new URL("./test-fixtures/manager-client-key.pem", import.meta.url),
    );
    let body: unknown;
    let contentLength: string | undefined;
    let peerAuthorized = false;
    const tlsServer = createHttpsServer(
      {
        ca,
        cert: certificate,
        key: privateKey,
        minVersion: "TLSv1.3",
        requestCert: true,
      },
      (request, response) => {
        void readJson(request)
          .then((value) => {
            body = value;
            contentLength = header(request, "content-length");
            peerAuthorized = request.socket instanceof TLSSocket && request.socket.authorized;
            sendJson(response, 200, { id: volumeId, state: "DESTROYED" });
          })
          .catch((error: unknown) => {
            sendJson(response, 500, {
              error: error instanceof Error ? error.message : "request body read failed",
            });
          });
      },
    );
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = tlsServer.address() as AddressInfo;
      const manager = new PortableFsManagerClient({
        authorizationDomain: "opensteer-installation",
        baseUrl: `https://127.0.0.1:${address.port}`,
        defaultTimeoutMs: 1_000,
        productIssuer: "opensteer",
        signer: new Ed25519PortableFsProductAuthorizationSigner(productKeys.privateKey),
        tls: {
          caCertificatePem: ca,
          clientCertificatePem: certificate,
          clientPrivateKeyPem: privateKey,
          serverName: "localhost",
        },
      });

      await expect(
        manager.destroyVolume(volumeId, { idempotencyKey: "workspace-destroy-mtls" }),
      ).resolves.toEqual({ id: volumeId, state: "DESTROYED" });
      expect(body).toEqual({ reason: "workspace deleted", volume_id: volumeId });
      expect(contentLength).toBe(String(Buffer.byteLength(JSON.stringify(body))));
      expect(peerAuthorized).toBe(true);
    } finally {
      tlsServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        tlsServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each([
    ["archiveVolume", "archive", "ARCHIVING"],
    ["wakeVolume", "wake", "RESTORING"],
  ] as const)(
    "posts %s with its idempotency key and parses additive volume fields",
    async (method, action, state) => {
      const fetchImplementation = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          Response.json({
            ...managerVolume,
            archive_cycle_step: "quiesce",
            restore_progress_permille: 125,
            restore_step: "restoring-namespace",
            state,
            wake_requested: action === "wake",
          }),
      );
      const manager = new PortableFsManagerClient({
        authorizationDomain: "opensteer-installation",
        baseUrl: "http://127.0.0.1:4314",
        fetchImplementation: fetchImplementation as typeof fetch,
        productIssuer: "opensteer",
        signer: new Ed25519PortableFsProductAuthorizationSigner(productKeys.privateKey),
      });

      await expect(
        manager[method](volumeId, { idempotencyKey: `workspace-${action}-1` }),
      ).resolves.toMatchObject({ restore_progress_permille: 125, state });
      const [input, init] = fetchImplementation.mock.calls[0]!;
      expect(new URL(input instanceof Request ? input.url : input.toString()).pathname).toBe(
        `/v1/volumes/${volumeId}/${action}`,
      );
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(`workspace-${action}-1`);
    },
  );

  it.each(["archiveVolume", "wakeVolume"] as const)(
    "surfaces a %s conflict as retryable",
    async (method) => {
      const manager = new PortableFsManagerClient({
        authorizationDomain: "opensteer-installation",
        baseUrl: "http://127.0.0.1:4314",
        fetchImplementation: vi.fn(async () =>
          Response.json({ error: "lifecycle_conflict" }, { status: 409 }),
        ) as typeof fetch,
        productIssuer: "opensteer",
        signer: new Ed25519PortableFsProductAuthorizationSigner(productKeys.privateKey),
      });

      await expect(
        manager[method](volumeId, { idempotencyKey: `conflict-${method}` }),
      ).rejects.toMatchObject({ httpStatus: 409, retryable: true });
    },
  );

  it("rejects an ambiguous volume destroy response", async () => {
    handler = (_request, response) => sendJson(response, 200, { id: volumeId, state: "ARCHIVED" });
    await expect(
      client(baseUrl, productKeys.privateKey).destroyVolume(volumeId, {
        idempotencyKey: "workspace-destroy-ambiguous",
      }),
    ).rejects.toBeInstanceOf(PortableFsProtocolError);

    handler = (request, response) =>
      sendJson(response, 200, {
        id: volumeId,
        state: request.method === "DELETE" ? "DESTROYING" : "ARCHIVED",
      });
    await expect(
      client(baseUrl, productKeys.privateKey).destroyVolume(volumeId, {
        idempotencyKey: "workspace-destroy-ambiguous-observation",
      }),
    ).rejects.toBeInstanceOf(PortableFsProtocolError);
  });

  it("signs the exact CSR-bound product authorization used by PortableFS", async () => {
    let body: Record<string, unknown> | undefined;
    handler = async (request, response) => {
      body = (await readJson(request)) as Record<string, unknown>;
      sendJson(response, 200, mountAuthorization());
    };
    const manager = client(baseUrl, productKeys.privateKey);
    const authorization = {
      expiresUnix: 1_775_995_800,
      nonce: "request-nonce-1",
      notBeforeUnix: 1_775_995_195,
    };

    const grant = await manager.issueAutomaticMountGrant(
      volumeId,
      {
        access: "write",
        authorization,
        clientCertificateRequestPem: csrPem,
        owner: "usr_owner",
        renewalEpoch: 7,
        renewalScope: "machine-private-state:runner_test",
        subject: "opensteer:run-1",
      },
      { idempotencyKey: "mount-request-1" },
    );

    expect(grant).toMatchObject({
      authorityAddress: "authority.internal:7443",
      enrollment: { id: "22222222-2222-4222-8222-222222222222" },
      expiresAt: "2026-04-12T12:10:00.000Z",
      manager: { serverName: "manager.test", url: "https://manager.test" },
      sequence: 0,
      volumeId,
    });
    expect(body).toMatchObject({
      access: ["write"],
      automatic_reauthorization: true,
      client_csr_pem: csrPem,
      volume_id: volumeId,
    });
    const token = String(body?.product_authorization);
    const [version, encodedPayload, encodedSignature] = token.split(".");
    expect(version).toBe("v1");
    const payload = Buffer.from(encodedPayload!, "base64url");
    expect(JSON.parse(payload.toString("utf8"))).toEqual({
      access: ["write"],
      audience: "portablefs-manager",
      authorization_domain: "opensteer-installation",
      expires: authorization.expiresUnix,
      issuer: "opensteer",
      nonce: authorization.nonce,
      not_before: authorization.notBeforeUnix,
      owner: "usr_owner",
      peer_spki_sha256: portableFsCsrSpkiSha256(csrPem),
      renewal_epoch: 7,
      renewal_scope: "machine-private-state:runner_test",
      subject: "opensteer:run-1",
      volume_id: volumeId,
    });
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from("portablefs-product-authorization-v1\0"), payload]),
        productKeys.publicKey,
        Buffer.from(encodedSignature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("omits both renewal claims for a generic automatic mount", async () => {
    let body: Record<string, unknown> | undefined;
    handler = async (request, response) => {
      body = (await readJson(request)) as Record<string, unknown>;
      sendJson(response, 200, mountAuthorization());
    };

    await client(baseUrl, productKeys.privateKey).issueAutomaticMountGrant(
      volumeId,
      {
        access: "write",
        authorization: {
          expiresUnix: 1_775_995_800,
          nonce: "generic-automatic-mount",
          notBeforeUnix: 1_775_995_195,
        },
        clientCertificateRequestPem: csrPem,
        owner: "usr_owner",
        subject: "opensteer:run-1",
      },
      { idempotencyKey: "generic-automatic-mount" },
    );

    const [, encodedPayload] = String(body?.product_authorization).split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8"));
    expect(payload).not.toHaveProperty("renewal_scope");
    expect(payload).not.toHaveProperty("renewal_epoch");
  });

  it("issues a standalone read session without creating a mount enrollment", async () => {
    let body: Record<string, unknown> | undefined;
    handler = async (request, response) => {
      body = (await readJson(request)) as Record<string, unknown>;
      sendJson(response, 200, { ...mountAuthorization(), access: ["read"] });
    };
    const authorization = {
      expiresUnix: 1_775_995_800,
      nonce: "files-session-1",
      notBeforeUnix: 1_775_995_195,
    };

    const grant = await client(baseUrl, productKeys.privateKey).issueReadSessionGrant(
      volumeId,
      {
        authorization,
        clientCertificateRequestPem: csrPem,
        owner: "usr_owner",
        subject: "opensteer-files:key-1",
      },
      { idempotencyKey: "files-session-1" },
    );

    expect(grant).toMatchObject({
      access: ["read"],
      authorityAddress: "authority.internal:7443",
      volumeId,
    });
    expect(grant).not.toHaveProperty("enrollment");
    expect(body).toMatchObject({
      access: ["read"],
      automatic_reauthorization: false,
      client_csr_pem: csrPem,
      volume_id: volumeId,
    });
    const token = String(body?.product_authorization);
    const [, encodedPayload] = token.split(".");
    expect(JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8"))).toMatchObject({
      access: ["read"],
      subject: "opensteer-files:key-1",
      volume_id: volumeId,
    });
  });

  it("parses every convergent volume-scoped revocation outcome", async () => {
    const seen: Array<{
      body: unknown;
      key: string | undefined;
      method: string | undefined;
      path: string;
    }> = [];
    let outcome: "REVOKED" | "CLOSED" | "EXPIRED" | "ABSENT" = "REVOKED";
    handler = async (request, response) => {
      seen.push({
        body: await readJson(request),
        key: header(request, "idempotency-key"),
        method: request.method,
        path: request.url ?? "",
      });
      sendJson(response, 200, {
        enrollment_id: "22222222-2222-4222-8222-222222222222",
        outcome,
        volume_id: volumeId,
      });
    };
    const manager = client(baseUrl, productKeys.privateKey);
    for (const expected of ["REVOKED", "CLOSED", "EXPIRED", "ABSENT"] as const) {
      outcome = expected;
      await expect(
        manager.revokeMountEnrollment(
          volumeId,
          "22222222-2222-4222-8222-222222222222",
          "opensteer-run-terminal",
        ),
      ).resolves.toEqual({
        enrollmentId: "22222222-2222-4222-8222-222222222222",
        outcome: expected,
        volumeId,
      });
    }
    expect(seen).toEqual(
      Array.from({ length: 4 }, () => ({
        body: { reason: "opensteer-run-terminal" },
        key: undefined,
        method: "PUT",
        path: `/v1/volumes/${volumeId}/mount-enrollments/22222222-2222-4222-8222-222222222222/revocation`,
      })),
    );
  });

  it("rejects a mismatched convergent revocation identity echo", async () => {
    handler = (_request, response) =>
      sendJson(response, 200, {
        enrollment_id: "33333333-3333-4333-8333-333333333333",
        outcome: "ABSENT",
        volume_id: volumeId,
      });
    await expect(
      client(baseUrl, productKeys.privateKey).revokeMountEnrollment(
        volumeId,
        "22222222-2222-4222-8222-222222222222",
        "opensteer-run-terminal",
      ),
    ).rejects.toBeInstanceOf(PortableFsProtocolError);
  });

  it("advances renewal fences in one convergent batch without an idempotency key", async () => {
    const seen: Array<{ body: unknown; key: string | undefined; path: string }> = [];
    handler = async (request, response) => {
      seen.push({
        body: await readJson(request),
        key: header(request, "idempotency-key"),
        path: request.url ?? "",
      });
      sendJson(response, 200, {
        fences: [
          { epoch: 9, scope: "machine-private-state:runner_one" },
          { epoch: 7, scope: "machine-private-state:runner_two" },
        ],
      });
    };
    const manager = client(baseUrl, productKeys.privateKey);
    await expect(
      manager.advanceRenewalFences("runner-lifecycle-status", [
        { epoch: 9, scope: "machine-private-state:runner_one" },
        { epoch: 4, scope: "machine-private-state:runner_two" },
      ]),
    ).resolves.toEqual({
      fences: [
        { epoch: 9, scope: "machine-private-state:runner_one" },
        { epoch: 7, scope: "machine-private-state:runner_two" },
      ],
    });
    expect(seen).toEqual([
      {
        body: {
          fences: [
            { epoch: 9, scope: "machine-private-state:runner_one" },
            { epoch: 4, scope: "machine-private-state:runner_two" },
          ],
          reason: "runner-lifecycle-status",
        },
        key: undefined,
        path: "/v1/renewal-fences",
      },
    ]);
  });

  it("maps a typed renewal scope fence without matching its message", async () => {
    handler = (_request, response) =>
      sendJson(response, 409, {
        error: "renewal_scope_fenced",
      });
    await expect(
      client(baseUrl, productKeys.privateKey).issueAutomaticMountGrant(
        volumeId,
        {
          access: "write",
          authorization: {
            expiresUnix: 1_775_995_800,
            nonce: "fenced-scope",
            notBeforeUnix: 1_775_995_195,
          },
          clientCertificateRequestPem: csrPem,
          owner: "usr_owner",
          renewalEpoch: 2,
          renewalScope: "machine-private-state:runner_test",
          subject: "opensteer:run-1",
        },
        { idempotencyKey: "fenced-scope" },
      ),
    ).rejects.toMatchObject({
      httpStatus: 409,
      remoteCode: "renewal_scope_fenced",
    });
    await expect(
      client(baseUrl, productKeys.privateKey).issueAutomaticMountGrant(
        volumeId,
        {
          access: "write",
          authorization: {
            expiresUnix: 1_775_995_800,
            nonce: "fenced-scope-again",
            notBeforeUnix: 1_775_995_195,
          },
          clientCertificateRequestPem: csrPem,
          owner: "usr_owner",
          renewalEpoch: 2,
          renewalScope: "machine-private-state:runner_test",
          subject: "opensteer:run-1",
        },
        { idempotencyKey: "fenced-scope-again" },
      ),
    ).rejects.toBeInstanceOf(PortableFsRenewalScopeFencedError);
  });

  it("requires renewal scope and epoch together", async () => {
    expect(() =>
      client(baseUrl, productKeys.privateKey).issueAutomaticMountGrant(
        volumeId,
        {
          access: "write",
          authorization: {
            expiresUnix: 1_775_995_800,
            nonce: "incomplete-renewal-fence",
            notBeforeUnix: 1_775_995_195,
          },
          clientCertificateRequestPem: csrPem,
          owner: "usr_owner",
          renewalScope: "machine-private-state:runner_test",
          subject: "opensteer:run-1",
        },
        { idempotencyKey: "incomplete-renewal-fence" },
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects mismatched identities and redacts manager errors", async () => {
    handler = (_request, response) => sendJson(response, 200, { ...managerVolume, id: cellId });
    await expect(
      client(baseUrl, productKeys.privateKey).getVolume(volumeId),
    ).rejects.toBeInstanceOf(PortableFsProtocolError);

    handler = (_request, response) =>
      sendJson(response, 503, {
        error: "manager temporarily unavailable v1.secretxx.signaturexx",
      });
    let thrown: unknown;
    try {
      await client(baseUrl, productKeys.privateKey).getVolume(volumeId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PortableFsControlPlaneError);
    expect(thrown).toMatchObject({ httpStatus: 503, retryable: true });
    expect((thrown as Error).message).toContain("[REDACTED]");

    handler = (_request, response) =>
      sendJson(response, 200, { ...mountAuthorization(), access: ["read", "write"] });
    await expect(
      client(baseUrl, productKeys.privateKey).issueAutomaticMountGrant(
        volumeId,
        {
          access: "write",
          authorization: {
            expiresUnix: 1_775_995_800,
            nonce: "broadened-access-response",
            notBeforeUnix: 1_775_995_195,
          },
          clientCertificateRequestPem: csrPem,
          owner: "usr_owner",
          subject: "opensteer:run-1",
        },
        { idempotencyKey: "broadened-access-response" },
      ),
    ).rejects.toBeInstanceOf(PortableFsProtocolError);
  });

  it("bounds responses, timeouts, cancellation, and invalid inputs", async () => {
    handler = () => undefined;
    const manager = client(baseUrl, productKeys.privateKey);
    await expect(manager.getVolume(volumeId, { timeoutMs: 40 })).rejects.toBeInstanceOf(
      PortableFsTimeoutError,
    );
    const abort = new AbortController();
    const pending = manager.getVolume(volumeId, { signal: abort.signal, timeoutMs: 2_000 });
    setTimeout(() => abort.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(PortableFsAbortError);

    handler = (_request, response) => {
      response.writeHead(200, { "content-length": "10000" });
      response.end("{}");
    };
    const bounded = new PortableFsManagerClient({
      authorizationDomain: "opensteer-installation",
      baseUrl,
      maxResponseBytes: 100,
      productIssuer: "opensteer",
      signer: new Ed25519PortableFsProductAuthorizationSigner(productKeys.privateKey),
    });
    await expect(bounded.getVolume(volumeId)).rejects.toBeInstanceOf(PortableFsOutputLimitError);
    await expect(
      manager.createVolume(
        { owner: "usr_owner", quotaBytes: 1, quotaInodes: 1 },
        { idempotencyKey: "" },
      ),
    ).rejects.toBeInstanceOf(PortableFsError);
  });

  it("requires HTTPS mTLS outside an injected loopback test transport", () => {
    const signer = new Ed25519PortableFsProductAuthorizationSigner(productKeys.privateKey);
    expect(
      () =>
        new PortableFsManagerClient({
          authorizationDomain: "domain",
          baseUrl: "http://manager.example.test",
          productIssuer: "opensteer",
          signer,
        }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new PortableFsManagerClient({
          authorizationDomain: "domain",
          baseUrl: "https://manager.example.test",
          productIssuer: "opensteer",
          signer,
        }),
    ).toThrow(/mTLS/);
    expect(
      () =>
        new PortableFsManagerClient({
          authorizationDomain: "domain",
          baseUrl: "http://127.0.0.1:8443/api/",
          productIssuer: "opensteer",
          signer,
        }),
    ).toThrow(/origin-only/);
  });
});

function client(baseUrl: URL, privateKey: KeyObject) {
  return new PortableFsManagerClient({
    authorizationDomain: "opensteer-installation",
    baseUrl,
    mountEndpoint: {
      caCertificatePem: "-----BEGIN CERTIFICATE-----\nmanager-ca\n-----END CERTIFICATE-----",
      serverName: "manager.test",
      url: "https://manager.test",
    },
    productIssuer: "opensteer",
    signer: new Ed25519PortableFsProductAuthorizationSigner(privateKey),
  });
}

function mountAuthorization() {
  return {
    access: ["write"],
    authority_ca_pem: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    authority_endpoint: "authority.internal:7443",
    authority_generation: 3,
    authority_server_name: "authority.internal",
    capability: "v1.payload.signature",
    certificate_expires_unix: 1_775_999_400,
    client_certificate_pem: "-----BEGIN CERTIFICATE-----\nclient\n-----END CERTIFICATE-----",
    enrollment_certificate_pem:
      "-----BEGIN CERTIFICATE-----\nenrollment\n-----END CERTIFICATE-----",
    enrollment_id: "22222222-2222-4222-8222-222222222222",
    expires_unix: 1_775_995_800,
    release_id: "portablefs-test",
    sequence: 0,
    volume_id: volumeId,
  };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
