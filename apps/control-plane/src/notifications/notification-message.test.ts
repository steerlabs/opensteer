import { createId, parseMobileThreadDeepLink } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { notificationMessage } from "./notification-message.js";

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
    ["request-opened", "Opensteer needs your approval", { requestId }],
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
