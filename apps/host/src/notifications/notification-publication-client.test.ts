import { createId } from "@opensteer/core";
import type { NotificationPublication } from "@opensteer/database";
import { describe, expect, it } from "vitest";
import {
  NotificationPublicationClient,
  type NotificationPublicationTarget,
} from "./notification-publication-client.js";

const deploymentId = createId("deployment");
const hostInstanceId = createId("hostInstance");
const accountId = `acct_${crypto.randomUUID()}`;
const target: NotificationPublicationTarget = {
  controlApiOrigin: new URL("https://accounts.opensteer.invalid"),
  hostCredential: `osc_${"a".repeat(43)}`,
};

function entry(overrides: Partial<NotificationPublication> = {}): NotificationPublication {
  return {
    eventId: createId("event"),
    expiresAt: new Date("2026-09-14T12:15:00.000Z"),
    id: createId("notification"),
    kind: "request-opened",
    messageId: null,
    occurredAt: new Date("2026-09-14T12:00:00.000Z"),
    requestId: createId("request"),
    runId: null,
    sequence: "42",
    threadId: createId("thread"),
    userId: createId("user"),
    workspaceId: createId("workspace"),
    ...overrides,
  };
}

function acknowledgement(notificationId: string): Response {
  return new Response(JSON.stringify({ accepted: true, deliveries: 1, notificationId }), {
    headers: { "content-type": "application/json" },
    status: 202,
  });
}

function clientAnswering(response: () => Response): NotificationPublicationClient {
  return new NotificationPublicationClient({
    deploymentId,
    fetch: async () => response(),
    hostInstanceId,
    target: async () => target,
  });
}

describe("NotificationPublicationClient", () => {
  it("posts identifiers and the audience to the Account, and nothing else", async () => {
    const published = entry({
      kind: "reply-published",
      messageId: createId("message"),
      requestId: null,
      runId: createId("run"),
    });
    const calls: { readonly body: string; readonly init: RequestInit; readonly url: string }[] = [];
    const client = new NotificationPublicationClient({
      deploymentId,
      fetch: async (input, init) => {
        calls.push({ body: String(init?.body ?? ""), init: init ?? {}, url: input.toString() });
        return acknowledgement(published.id);
      },
      hostInstanceId,
      target: async () => target,
    });

    await client.publish({
      entry: published,
      recipientAccountIds: [accountId],
      signal: new AbortController().signal,
    });

    expect(calls[0]?.url).toBe("https://accounts.opensteer.invalid/v1/host/notifications");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      `Bearer ${target.hostCredential}`,
    );
    // No title, body, Thread name or person: those stay on this Deployment.
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      deploymentId,
      eventId: published.eventId,
      expiresAt: "2026-09-14T12:15:00.000Z",
      hostInstanceId,
      kind: "reply-published",
      messageId: published.messageId,
      notificationId: published.id,
      occurredAt: "2026-09-14T12:00:00.000Z",
      recipientAccountIds: [accountId],
      requestId: null,
      runId: published.runId,
      schemaVersion: 1,
      sequence: "42",
      threadId: published.threadId,
      workspaceId: published.workspaceId,
    });
  });

  it("omits the message for a notification that names none", async () => {
    const published = entry();
    let body: unknown;
    const client = new NotificationPublicationClient({
      deploymentId,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body ?? "{}"));
        return acknowledgement(published.id);
      },
      hostInstanceId,
      target: async () => target,
    });

    await client.publish({
      entry: published,
      recipientAccountIds: [accountId],
      signal: new AbortController().signal,
    });

    expect(body).not.toHaveProperty("messageId");
    expect(body).toMatchObject({ kind: "request-opened", requestId: published.requestId });
  });

  it.each([400, 401, 403, 404, 409, 302])("does not retry HTTP %i", async (status) => {
    await expect(
      clientAnswering(() => new Response("", { status })).publish({
        entry: entry(),
        recipientAccountIds: [accountId],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: `Notification publication API returned HTTP ${status}`,
    });
  });
  it.each([429, 500, 503])("retries HTTP %i", async (status) => {
    await expect(
      clientAnswering(() => new Response("", { status })).publish({
        entry: entry(),
        recipientAccountIds: [accountId],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: "retry",
      reason: `Notification publication API returned HTTP ${status}`,
    });
  });
  it("does not retry an invalid acknowledgement", async () => {
    await expect(
      clientAnswering(() => acknowledgement(createId("notification"))).publish({
        entry: entry(),
        recipientAccountIds: [accountId],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "Notification publication API returned an invalid acknowledgement",
    });
  });
  it("warns when the Account has no push configured", async () => {
    const client = clientAnswering(
      () =>
        new Response(JSON.stringify({ error: { reason: "push-not-configured" } }), { status: 404 }),
    );
    await expect(
      client.publish({
        entry: entry(),
        recipientAccountIds: [accountId],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "push-not-configured" });
  });
  it("quietly skips a Host with no Account channel", async () => {
    const client = new NotificationPublicationClient({
      deploymentId,
      hostInstanceId,
      target: async () => null,
      fetch: async () => {
        throw new Error("must not be called");
      },
    });
    await expect(
      client.publish({
        entry: entry(),
        recipientAccountIds: [accountId],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "no-target" });
  });
});
