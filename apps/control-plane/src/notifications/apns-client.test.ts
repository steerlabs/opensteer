import { maximumPreviewMessage } from "./notification-preview.test-support.js";
import { generateKeyPairSync } from "node:crypto";
import { createId } from "@opensteer/core";
import { decodeProtectedHeader, decodeJwt } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ApnsClient, type ApnsTransport } from "./apns-client.js";
import { notificationMessage } from "./notification-message.js";

const deploymentId = createId("deployment");
const threadId = createId("thread");
const token = "a".repeat(64);
const expiresAt = new Date("2026-09-14T12:02:00.000Z");
let privateKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
});

function client(transport: ApnsTransport, now = () => new Date("2026-09-14T12:00:00.000Z")) {
  return new ApnsClient({
    keyId: "ABCDE12345",
    now,
    privateKeyPem,
    teamId: "TEAM123456",
    topic: "com.opensteer.mobile",
    transport,
  });
}

function send(instance: ApnsClient, apsEnvironment: "development" | "production" = "development") {
  return instance.send({
    apsEnvironment,
    expiresAt,
    message: notificationMessage({
      deploymentId,
      kind: "request-opened",
      requestId: null,
      threadId,
    }),
    collapseKey: `${threadId}:request-opened`,
    token,
  });
}

describe("ApnsClient", () => {
  it("routes each device to its own origin and shares the provider token", async () => {
    const transport = vi.fn<ApnsTransport>(async () => ({ body: "", status: 200 }));
    const instance = client(transport);
    await send(instance, "development");
    await send(instance, "production");
    expect(transport.mock.calls.map(([request]) => request.origin)).toEqual([
      "https://api.sandbox.push.apple.com",
      "https://api.push.apple.com",
    ]);
    expect(transport.mock.calls[0]?.[0].headers.authorization).toBe(
      transport.mock.calls[1]?.[0].headers.authorization,
    );
    instance.close();
  });

  it("signs an ES256 provider token naming the key and team", async () => {
    const transport = vi.fn<ApnsTransport>(async () => ({ body: "", status: 200 }));

    await expect(send(client(transport))).resolves.toEqual({
      outcome: "accepted",
      status: "delivered",
    });

    const request = transport.mock.calls[0]?.[0];
    const provider = request?.headers.authorization?.replace("bearer ", "") ?? "";
    expect(decodeProtectedHeader(provider)).toEqual({ alg: "ES256", kid: "ABCDE12345" });
    expect(decodeJwt(provider).iss).toBe("TEAM123456");
  });

  it("sends an alert collapsed on its Thread and kind and expiring with the notification", async () => {
    const transport = vi.fn<ApnsTransport>(async () => ({ body: "", status: 200 }));

    await send(client(transport));

    const request = transport.mock.calls[0]?.[0];
    expect(request?.path).toBe(`/3/device/${token}`);
    expect(request?.headers["apns-topic"]).toBe("com.opensteer.mobile");
    expect(request?.headers["apns-push-type"]).toBe("alert");
    expect(request?.headers["apns-collapse-id"]).toBe(`${threadId}:request-opened`);
    expect(request?.headers["apns-expiration"]).toBe(String(expiresAt.getTime() / 1_000));
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
      aps: {
        alert: { body: "Opensteer needs you", title: "Opensteer" },
        "thread-id": `${deploymentId}:${threadId}`,
      },
      deploymentId,
      kind: "request-opened",
      threadId,
    });
  });

  it("fits a maximum preview in APNs and requests native decryption", async () => {
    const transport = vi.fn<ApnsTransport>(async () => ({ body: "", status: 200 }));
    const message = maximumPreviewMessage();
    await client(transport).send({
      apsEnvironment: "development",
      expiresAt,
      message,
      collapseKey: "osn1_" + "x".repeat(43),
      token,
    });
    const request = transport.mock.calls[0]![0];
    expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(4096);
    const payload = JSON.parse(request.body);
    expect(payload.aps).toEqual({
      alert: { body: "Opensteer needs you", title: "Opensteer" },
      sound: "default",
      "mutable-content": 1,
      "thread-id": `${message.data.deploymentId}:${message.data.threadId}`,
    });
    expect(payload.preview).toBe(message.data.preview);
  });

  it("does not expose arbitrary provider or transport text", async () => {
    const secret = "private-ciphertext";
    expect(
      JSON.stringify(
        await send(
          client(async () => {
            throw new Error(secret);
          }),
        ),
      ),
    ).not.toContain(secret);
    expect(
      JSON.stringify(
        await send(client(async () => ({ body: JSON.stringify({ reason: secret }), status: 400 }))),
      ),
    ).not.toContain(secret);
  });

  it("reuses one provider token inside its lifetime and mints a new one after", async () => {
    const transport = vi.fn<ApnsTransport>(async () => ({ body: "", status: 200 }));
    let now = new Date("2026-09-14T12:00:00.000Z");
    const instance = client(transport, () => now);

    await send(instance);
    await send(instance);
    now = new Date("2026-09-14T13:00:00.000Z");
    await send(instance);

    const providers = transport.mock.calls.map(([call]) => call.headers.authorization);
    expect(providers[0]).toBe(providers[1]);
    expect(providers[2]).not.toBe(providers[0]);
  });

  it.each([
    [410, '{"reason":"Unregistered"}', "apns:Unregistered"],
    [400, '{"reason":"BadDeviceToken"}', "apns:BadDeviceToken"],
    [400, '{"reason":"DeviceTokenNotForTopic"}', "apns:DeviceTokenNotForTopic"],
  ])("ends the registration on HTTP %i %s", async (status, body, outcome) => {
    await expect(send(client(async () => ({ body, status })))).resolves.toEqual({
      outcome,
      status: "unregistered",
    });
  });

  it("retries a throttled or broken Apple", async () => {
    await expect(
      send(client(async () => ({ body: '{"reason":"TooManyRequests"}', status: 429 }))),
    ).resolves.toMatchObject({ status: "retry" });
    await expect(
      send(client(async () => ({ body: '{"reason":"InternalServerError"}', status: 500 }))),
    ).resolves.toMatchObject({ status: "retry" });
    await expect(
      send(
        client(async () => {
          throw new Error("socket hang up");
        }),
      ),
    ).resolves.toMatchObject({ status: "retry" });
  });

  it("gives up on a message Apple will keep refusing", async () => {
    await expect(
      send(client(async () => ({ body: '{"reason":"PayloadTooLarge"}', status: 413 }))),
    ).resolves.toEqual({ outcome: "apns:413:PayloadTooLarge", status: "rejected" });
  });
});
