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
          collapse_key: `${threadId}:run-failed`,
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

  it.each(["UNREGISTERED", "NOT_FOUND", "INVALID_ARGUMENT"])(
    "ends the registration on %s",
    async (errorCode) => {
      const { instance } = client(
        () =>
          new Response(JSON.stringify({ error: { details: [{ errorCode }], status: errorCode } }), {
            headers: { "content-type": "application/json" },
            status: 404,
          }),
      );

      await expect(send(instance)).resolves.toEqual({
        outcome: `fcm:${errorCode}`,
        status: "unregistered",
      });
    },
  );

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
