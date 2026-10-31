import { maximumPreviewMessage } from "./notification-preview.test-support.js";
import { generateKeyPairSync } from "node:crypto";
import { createId } from "@opensteer/core";
import { decodeJwt } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { FcmClient } from "./fcm-client.js";
import { notificationMessage } from "./notification-message.js";

const deploymentId = createId("deployment");
const threadId = createId("thread");
const token = "fcm-token:".padEnd(64, "x");
const expiresAt = new Date("2026-09-14T12:02:00.000Z");
const now = () => new Date("2026-09-14T12:00:00.000Z");
const tokenUri = "https://oauth2.googleapis.com/token";
let privateKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
});

function accessTokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3_600 }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function client(sendResponse: () => Response | Promise<Response>) {
  const calls: { readonly body: string; readonly url: string }[] = [];
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ body: String(init?.body ?? ""), url });
    return url === tokenUri ? accessTokenResponse() : sendResponse();
  };
  return {
    calls,
    instance: new FcmClient({
      clientEmail: "push@example-project.iam.gserviceaccount.com",
      fetch: fetchStub,
      now,
      privateKeyPem,
      projectId: "example-project",
      tokenUri,
    }),
  };
}

function send(instance: FcmClient) {
  return instance.send({
    expiresAt,
    message: notificationMessage({ deploymentId, kind: "run-failed", requestId: null, threadId }),
    collapseKey: `${threadId}:run-failed`,
    token,
  });
}

describe("FcmClient", () => {
  it("exchanges a service-account assertion for an access token once", async () => {
    const { calls, instance } = client(
      () => new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }),
    );

    await expect(send(instance)).resolves.toEqual({ outcome: "accepted", status: "delivered" });
    await send(instance);

    const tokenRequests = calls.filter((call) => call.url === tokenUri);
    expect(tokenRequests).toHaveLength(1);
    const assertion = new URLSearchParams(tokenRequests[0]?.body ?? "").get("assertion") ?? "";
    expect(decodeJwt(assertion)).toMatchObject({
      aud: tokenUri,
      iss: "push@example-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
    });
  });

  it("posts a high-priority message that replaces its Thread's alert and expires with it", async () => {
    const { calls, instance } = client(
      () => new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }),
    );

    await send(instance);

    const message = calls.find((call) => call.url !== tokenUri);
    expect(message?.url).toBe(
      "https://fcm.googleapis.com/v1/projects/example-project/messages:send",
    );
    expect(JSON.parse(message?.body ?? "{}")).toEqual({
      message: {
        android: {
          notification: { channel_id: "default", tag: `${threadId}:run-failed` },
          priority: "high",
          ttl: "120s",
        },
        data: {
          deepLink: `com.opensteer.mobile:/deployments/${deploymentId}/threads/${threadId}`,
          deploymentId,
          kind: "run-failed",
          threadId,
        },
        notification: { body: "Opensteer couldn't finish", title: "Opensteer" },
        token,
      },
    });
  });

  it.each(["NOT_FOUND", "INVALID_ARGUMENT"])(
    "preserves the registration on ambiguous %s",
    async (errorCode) => {
      const { instance } = client(
        () =>
          new Response(JSON.stringify({ error: { details: [{ errorCode }], status: errorCode } }), {
            headers: { "content-type": "application/json" },
            status: 404,
          }),
      );

      await expect(send(instance)).resolves.toEqual({
        outcome: `fcm:404:${errorCode}`,
        status: "rejected",
      });
    },
  );

  it("sends maximum previews data-only within the FCM application limit", async () => {
    const { calls, instance } = client(() => new Response("{}", { status: 200 }));
    const message = maximumPreviewMessage();
    await instance.send({ expiresAt, message, collapseKey: "osn1_" + "x".repeat(43), token });
    const payload = JSON.parse(calls.find((call) => call.url !== tokenUri)!.body).message;
    const { token: target, ...application } = payload;
    expect(target).toBe(token);
    expect(Buffer.byteLength(JSON.stringify(application))).toBeLessThanOrEqual(4096);
    expect(payload.notification).toBeUndefined();
    expect(payload.android).toEqual({ priority: "high", ttl: "120s" });
    expect(payload.data.preview).toBe(message.data.preview);
  });

  it("does not treat an untyped UNREGISTERED detail as token revocation", async () => {
    const { instance } = client(
      () =>
        new Response(
          JSON.stringify({
            error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] },
          }),
          { status: 404 },
        ),
    );
    await expect(send(instance)).resolves.toEqual({
      status: "rejected",
      outcome: "fcm:404:NOT_FOUND",
    });
  });

  it("disables only a typed UNREGISTERED FCM detail", async () => {
    const { instance } = client(
      () =>
        new Response(
          JSON.stringify({
            error: {
              status: "NOT_FOUND",
              details: [
                {
                  "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                  errorCode: "UNREGISTERED",
                },
              ],
            },
          }),
          { status: 404 },
        ),
    );
    await expect(send(instance)).resolves.toEqual({
      outcome: "fcm:UNREGISTERED",
      status: "unregistered",
    });
  });

  it("does not report provider bodies or thrown payloads", async () => {
    const secret = "private-ciphertext";
    const { instance } = client(() => {
      throw new Error(secret);
    });
    expect(JSON.stringify(await send(instance))).not.toContain(secret);
    const unknown = client(
      () => new Response(JSON.stringify({ error: { status: secret } }), { status: 400 }),
    );
    expect(JSON.stringify(await send(unknown.instance))).not.toContain(secret);
  });

  it("retries a throttled or broken Google", async () => {
    const { instance } = client(
      () =>
        new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), {
          headers: { "content-type": "application/json" },
          status: 503,
        }),
    );

    await expect(send(instance)).resolves.toEqual({
      outcome: "fcm:503:UNAVAILABLE",
      status: "retry",
    });
  });
});
