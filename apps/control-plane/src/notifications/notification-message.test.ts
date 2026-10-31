import { createId, parseMobileThreadDeepLink } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { notificationCollapseId, notificationMessage } from "./notification-message.js";

const deploymentId = createId("deployment");
const threadId = createId("thread");
const requestId = createId("request");
const messageId = createId("message");

describe("notificationMessage", () => {
  it("carries a deep link the phone's own parser accepts", () => {
    const message = notificationMessage({
      deploymentId,
      kind: "request-opened",
      requestId,
      threadId,
    });

    expect(parseMobileThreadDeepLink(message.data.deepLink)).toEqual({
      deploymentId,
      requestId,
      threadId,
    });
    expect(message.data).toEqual({
      deepLink: message.data.deepLink,
      deploymentId,
      kind: "request-opened",
      requestId,
      threadId,
    });
  });

  it("carries nothing but identifiers", () => {
    const serialized = JSON.stringify(
      notificationMessage({ deploymentId, kind: "request-opened", requestId, threadId }),
    );

    for (const value of [deploymentId, threadId, requestId]) {
      expect(serialized).toContain(value);
    }
    expect(serialized).not.toMatch(/workspace|prompt|token|email|@/iu);
  });

  it.each([
    ["reply-published", "Opensteer replied", { messageId }],
    ["request-opened", "Opensteer needs you", { requestId }],
    ["run-failed", "Opensteer couldn't finish", {}],
    ["report-published", "An agent shared an update", { messageId }],
    ["run-completed", "A run finished", {}],
    ["run-interrupted", "A run was stopped", {}],
  ] as const)("phrases %s and lands on what it names", (kind, body, anchor) => {
    // A Host that sends a stray identifier beside the one its kind names must
    // not move the tap, or make a link that cannot be built at all.
    const message = notificationMessage({
      deploymentId,
      kind,
      messageId: kind === "request-opened" ? null : messageId,
      requestId: kind === "request-opened" ? requestId : null,
      threadId,
    });
    const stray = notificationMessage({ deploymentId, kind, messageId, requestId, threadId });

    for (const phone of [message, stray]) {
      expect(phone).toMatchObject({ body, title: "Opensteer" });
      expect(parseMobileThreadDeepLink(phone.data.deepLink)).toEqual({
        deploymentId,
        requestId: null,
        threadId,
        ...anchor,
      });
    }
  });
});

it("uses bounded deployment-qualified replacement identities and separates Requests", () => {
  const input = {
    deploymentId,
    threadId,
    kind: "request-opened" as const,
    requestId,
    notificationId: createId("notification"),
  };
  const first = notificationCollapseId(input);
  expect(first).toMatch(/^osn1_[A-Za-z0-9_-]{43}$/u);
  expect(first.length).toBe(48);
  expect(notificationCollapseId({ ...input, notificationId: createId("notification") })).toBe(
    first,
  );
  expect(notificationCollapseId({ ...input, requestId: createId("request") })).not.toBe(first);
  expect(notificationCollapseId({ ...input, deploymentId: createId("deployment") })).not.toBe(
    first,
  );
  expect(notificationCollapseId({ ...input, requestId: null })).not.toBe(
    notificationCollapseId({ ...input, requestId: null, notificationId: createId("notification") }),
  );
  expect(notificationCollapseId({ ...input, kind: "reply-published" })).toBe(
    notificationCollapseId({
      ...input,
      kind: "reply-published",
      notificationId: createId("notification"),
      requestId: null,
    }),
  );
});
