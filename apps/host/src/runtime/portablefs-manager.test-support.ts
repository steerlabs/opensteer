import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PortableFsMountManagerEndpoint } from "@opensteer/workspace-portablefs";

const certificate = "-----BEGIN CERTIFICATE-----\ndGVzdA==\n-----END CERTIFICATE-----\n";
const maximumRenewalFences = 65_536;

interface RecordedRequest {
  readonly body: Record<string, unknown>;
  readonly idempotencyKey: string | undefined;
  readonly method: string;
  readonly path: string;
}

interface FakeEnrollment {
  readonly id: string;
  readonly productIssuer: string;
  readonly renewalEpoch: number | undefined;
  readonly renewalScope: string | undefined;
  readonly state: "ACTIVE" | "CLOSED" | "REVOKED";
  readonly terminationReason: string | undefined;
  readonly volume_id: string;
}

export interface PortableFsManagerFake {
  readonly close: () => Promise<void>;
  readonly createCalls: number;
  readonly grantCalls: number;
  readonly mountEndpoint: PortableFsMountManagerEndpoint;
  readonly requests: readonly RecordedRequest[];
  readonly enrollment: (id: string) =>
    | {
        readonly state: FakeEnrollment["state"];
        readonly terminationReason: string | undefined;
      }
    | undefined;
  readonly seedReadyVolume: (input: {
    readonly id: string;
    readonly owner: string;
    readonly productIssuer?: string;
  }) => void;
  readonly url: URL;
}

export async function startPortableFsManagerFake(): Promise<PortableFsManagerFake> {
  let createCalls = 0;
  let grantCalls = 0;
  const requests: RecordedRequest[] = [];
  const volumes = new Map<string, Record<string, unknown>>();
  const enrollments = new Map<string, FakeEnrollment>();
  // This fake serves one authenticated product principal, just like one Host
  // client certificate. A scope therefore needs no second issuer dimension in
  // memory, while enrollments retain the issuer so rotation still checks it.
  const renewalFences = new Map<string, number>();
  const receipts = new Map<string, { readonly body: string; readonly response: unknown }>();
  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const body = request.method === "GET" ? {} : await readJson(request);
      const path = request.url ?? "/";
      const idempotencyKey = header(request, "idempotency-key");
      requests.push({ body, idempotencyKey, method: request.method ?? "", path });

      if (request.method === "GET" && path === "/healthz") {
        return sendJson(response, 200, { release_id: "portablefs-test", status: "ok" });
      }

      if (request.method === "GET" && path === "/v1/capacity") {
        return sendJson(response, 200, {
          pools: [
            {
              pool: "product",
              archived_volumes: 0,
              capacity_bytes: 100_000_000_000,
              capacity_inodes: 10_000_000,
              create_admissible: true,
              measured_used_bytes: 0,
              measured_used_inodes: 0,
              pending_bytes: 0,
              pending_inodes: 0,
              placements: volumes.size,
              restore_admissible: true,
            },
          ],
        });
      }

      if (request.method === "POST" && path === "/v1/volumes") {
        createCalls += 1;
        if (!idempotencyKey) return sendJson(response, 400, { error: "idempotency key required" });
        const replay = replayReceipt(receipts, idempotencyKey, body, response);
        if (replay) return;
        const now = Math.floor(Date.now() / 1_000);
        const volume = {
          authority_endpoint: "127.0.0.1:9443",
          authority_generation: 1,
          authority_server_name: "authority.test",
          cell_id: randomUUID(),
          created_unix: now,
          id: randomUUID(),
          owner: requireString(body.owner),
          product_issuer: requireString(body.product_issuer),
          project_id: 42,
          quota_bytes: requireNumber(body.quota_bytes),
          quota_inodes: requireNumber(body.quota_inodes),
          state: "READY",
          updated_unix: now,
        };
        volumes.set(volume.id, volume);
        receipts.set(idempotencyKey, { body: JSON.stringify(body), response: volume });
        return sendJson(response, 200, volume);
      }

      if (request.method === "GET" && path.startsWith("/v1/volumes/")) {
        const volume = volumes.get(decodeURIComponent(path.slice("/v1/volumes/".length)));
        return volume
          ? sendJson(response, 200, volume)
          : sendJson(response, 404, { error: "volume not found" });
      }

      if (request.method === "POST" && path === "/v1/mount-authorizations") {
        grantCalls += 1;
        if (!idempotencyKey) return sendJson(response, 400, { error: "idempotency key required" });
        const replay = replayReceipt(receipts, idempotencyKey, body, response);
        if (replay) return;
        const volumeId = requireString(body.volume_id);
        const volume = volumes.get(volumeId);
        if (!volume) return sendJson(response, 404, { error: "volume not found" });
        const productAuthorization = requireString(body.product_authorization);
        if (!productAuthorization.startsWith("v1.")) {
          return sendJson(response, 403, { error: "invalid product authorization" });
        }
        const automaticReauthorization = body.automatic_reauthorization;
        if (typeof automaticReauthorization !== "boolean") {
          return sendJson(response, 400, { error: "invalid automatic reauthorization" });
        }
        const claims = productAuthorizationClaims(productAuthorization);
        const renewalScope = optionalString(claims.renewal_scope);
        const renewalEpoch = optionalNumber(claims.renewal_epoch);
        if ((renewalScope === undefined) !== (renewalEpoch === undefined)) {
          return sendJson(response, 400, { error: "invalid renewal scope" });
        }
        if (
          renewalScope !== undefined &&
          (!validRenewalScope(renewalScope) || !validEpoch(renewalEpoch))
        ) {
          return sendJson(response, 400, { error: "invalid renewal scope" });
        }
        const productIssuer = requireString(volume.product_issuer);
        if (renewalScope !== undefined && renewalEpoch! < (renewalFences.get(renewalScope) ?? 0)) {
          return sendJson(response, 409, { error: "renewal_scope_fenced" });
        }
        const now = Math.floor(Date.now() / 1_000);
        if (renewalScope !== undefined) {
          renewalFences.set(
            renewalScope,
            Math.max(renewalFences.get(renewalScope) ?? 0, renewalEpoch!),
          );
          // Enrollment issuance rotates the scope, while grant-only issuance
          // advances its floor and revokes only credentials below that floor.
          for (const [id, enrollment] of enrollments) {
            if (
              enrollment.state === "ACTIVE" &&
              enrollment.productIssuer === productIssuer &&
              enrollment.renewalScope === renewalScope &&
              (automaticReauthorization || enrollment.renewalEpoch! < renewalEpoch!)
            ) {
              enrollments.set(id, {
                ...enrollment,
                state: "REVOKED",
                terminationReason: "renewal-scope-superseded",
              });
            }
          }
        }
        const enrollmentId = automaticReauthorization ? randomUUID() : undefined;
        if (enrollmentId) {
          enrollments.set(enrollmentId, {
            id: enrollmentId,
            productIssuer,
            renewalEpoch,
            renewalScope,
            state: "ACTIVE",
            terminationReason: undefined,
            volume_id: volumeId,
          });
        }
        const grant = {
          access: body.access,
          authority_ca_pem: certificate,
          authority_endpoint: "127.0.0.1:9443",
          authority_generation: 1,
          authority_server_name: "authority.test",
          capability: "v1.YWJj.ZGVm",
          certificate_expires_unix: now + 900,
          client_certificate_pem: certificate,
          ...(enrollmentId
            ? {
                enrollment_certificate_pem: certificate,
                enrollment_id: enrollmentId,
              }
            : {}),
          expires_unix: now + 900,
          release_id: "portablefs-test",
          sequence: 0,
          volume_id: volumeId,
        };
        receipts.set(idempotencyKey, { body: JSON.stringify(body), response: grant });
        return sendJson(response, 200, grant);
      }

      const revocationMatch =
        /^\/v1\/volumes\/([^/]+)\/mount-enrollments\/([^/]+)\/revocation$/u.exec(path);
      if (request.method === "PUT" && revocationMatch?.[1] && revocationMatch[2]) {
        if (idempotencyKey !== undefined) {
          return sendJson(response, 400, { error: "Idempotency-Key is not accepted" });
        }
        const reason = requireString(body.reason);
        if (!validIdentity(reason)) {
          return sendJson(response, 400, { error: "invalid revocation reason" });
        }
        const volumeId = decodeURIComponent(revocationMatch[1]);
        const id = decodeURIComponent(revocationMatch[2]);
        if (!volumes.has(volumeId)) return sendJson(response, 404, { error: "volume not found" });
        const enrollment = enrollments.get(id);
        if (enrollment && enrollment.volume_id !== volumeId) {
          return sendJson(response, 404, { error: "enrollment not found" });
        }
        let outcome = "ABSENT";
        if (enrollment) {
          outcome = enrollment.state === "CLOSED" ? "CLOSED" : "REVOKED";
          if (enrollment.state === "ACTIVE") {
            enrollments.set(id, {
              ...enrollment,
              state: "REVOKED",
              terminationReason: reason,
            });
          }
        }
        return sendJson(response, 200, { enrollment_id: id, outcome, volume_id: volumeId });
      }

      if (request.method === "PUT" && path === "/v1/renewal-fences") {
        if (idempotencyKey !== undefined) {
          return sendJson(response, 400, { error: "Idempotency-Key is not accepted" });
        }
        const reason = requireString(body.reason);
        if (!validIdentity(reason) || !Array.isArray(body.fences)) {
          return sendJson(response, 400, { error: "invalid renewal fences" });
        }
        if (body.fences.length < 1 || body.fences.length > 4_096) {
          return sendJson(response, 400, { error: "invalid renewal fences" });
        }
        const fences = body.fences.map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("invalid renewal fence");
          }
          const entry = value as Record<string, unknown>;
          const scope = requireString(entry.scope);
          const epoch = requireNumber(entry.epoch);
          if (Object.keys(entry).length !== 2 || !validRenewalScope(scope) || !validEpoch(epoch)) {
            throw new Error("invalid renewal fence");
          }
          return { epoch, scope };
        });
        const requestedHighWater = new Map<string, number>();
        for (const fence of fences) {
          requestedHighWater.set(
            fence.scope,
            Math.max(requestedHighWater.get(fence.scope) ?? 0, fence.epoch),
          );
        }
        const newFences = [...requestedHighWater.keys()].filter(
          (scope) => !renewalFences.has(scope),
        ).length;
        if (renewalFences.size + newFences > maximumRenewalFences) {
          return sendJson(response, 409, {
            error: "controlplane: renewal fence capacity reached",
          });
        }
        // Validate capacity before deriving any staged high-water. A rejected
        // batch must leave both floors and enrollments untouched.
        const resulting = new Map(renewalFences);
        for (const [scope, epoch] of requestedHighWater) {
          resulting.set(scope, Math.max(resulting.get(scope) ?? 0, epoch));
        }
        for (const [scope, epoch] of resulting) renewalFences.set(scope, epoch);
        for (const [id, enrollment] of enrollments) {
          if (
            enrollment.state === "ACTIVE" &&
            enrollment.renewalScope !== undefined &&
            enrollment.renewalEpoch !== undefined &&
            enrollment.renewalEpoch < (resulting.get(enrollment.renewalScope) ?? 0)
          ) {
            enrollments.set(id, {
              ...enrollment,
              state: "REVOKED",
              terminationReason: reason,
            });
          }
        }
        return sendJson(response, 200, {
          fences: fences.map((fence) => ({
            epoch: resulting.get(fence.scope)!,
            scope: fence.scope,
          })),
        });
      }

      return sendJson(response, 404, { error: "not found" });
    } catch {
      return sendJson(response, 400, { error: "invalid request" });
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error("PortableFS fake failed")),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PortableFS fake did not listen");
  return {
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    get createCalls() {
      return createCalls;
    },
    get grantCalls() {
      return grantCalls;
    },
    enrollment: (id) => {
      const value = enrollments.get(id);
      return value ? { state: value.state, terminationReason: value.terminationReason } : undefined;
    },
    mountEndpoint: {
      caCertificatePem: certificate,
      serverName: "manager.test",
      url: "https://manager.test",
    },
    requests,
    seedReadyVolume: (input) => {
      const now = Math.floor(Date.now() / 1_000);
      volumes.set(input.id, {
        authority_endpoint: "127.0.0.1:9443",
        authority_generation: 1,
        authority_server_name: "authority.test",
        cell_id: randomUUID(),
        created_unix: now,
        id: input.id,
        owner: input.owner,
        product_issuer: input.productIssuer ?? "opensteer-test",
        project_id: 42,
        quota_bytes: 10_000_000,
        quota_inodes: 10_000,
        state: "READY",
        updated_unix: now,
      });
    },
    url: new URL(`http://127.0.0.1:${address.port}`),
  };
}

function replayReceipt(
  receipts: ReadonlyMap<string, { readonly body: string; readonly response: unknown }>,
  key: string,
  body: unknown,
  response: ServerResponse,
): boolean {
  const receipt = receipts.get(key);
  if (!receipt) return false;
  if (receipt.body !== JSON.stringify(body)) {
    sendJson(response, 409, { error: "idempotency key reused with different request" });
  } else {
    sendJson(response, 200, receipt.response);
  }
  return true;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 1024 * 1024) throw new Error("request too large");
    chunks.push(value);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("expected number");
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return requireNumber(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value);
}

function productAuthorizationClaims(value: string): Record<string, unknown> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1]) {
    throw new Error("invalid product authorization");
  }
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    throw new Error("invalid product authorization");
  }
  return claims as Record<string, unknown>;
}

function validEpoch(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function validIdentity(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/\p{Control}/u.test(value)
  );
}

function validRenewalScope(value: string): boolean {
  return /^[A-Za-z0-9._:/-]{1,200}$/u.test(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
