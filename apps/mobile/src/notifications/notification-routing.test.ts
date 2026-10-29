import { buildMobileThreadDeepLink, DeploymentIdSchema, ThreadIdSchema } from "@opensteer/core";
import { RequestIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import {
  dismissThreadNotifications,
  notificationDestination,
  shouldPresentNotification,
} from "./notification-routing.js";

const deploymentId = DeploymentIdSchema.parse("dep_0192f4a1-1111-4000-8000-000000000001");
const otherDeploymentId = DeploymentIdSchema.parse("dep_0192f4a1-1111-4000-8000-000000000002");
const threadId = ThreadIdSchema.parse("thr_0192f4a1-2222-4000-8000-000000000001");
const otherThreadId = ThreadIdSchema.parse("thr_0192f4a1-2222-4000-8000-000000000002");
const requestId = RequestIdSchema.parse("req_0192f4a1-3333-4000-8000-000000000001");

const deepLink = buildMobileThreadDeepLink({ deploymentId, requestId, threadId });

const push = (data: unknown) => ({ data });

describe("notificationDestination", () => {
  it("reads the whole destination from the link alone", () => {
    expect(
      notificationDestination(
        push({ deepLink, deploymentId, kind: "request-opened", requestId, threadId }),
      ),
    ).toEqual({ deepLink, deploymentId, requestId, threadId });
  });

  it("ignores the payload's own identifiers when they contradict the link", () => {
    expect(
      notificationDestination(
        push({
          deepLink,
          deploymentId: otherDeploymentId,
          kind: "request-opened",
          threadId: otherThreadId,
        }),
      ),
    ).toMatchObject({ deploymentId, threadId });
  });

  it("refuses a payload with no link, a link of another shape, or no data at all", () => {
    expect(notificationDestination(push({ deploymentId, threadId }))).toBeNull();
    expect(
      notificationDestination(push({ deepLink: "https://opensteer.test/threads/x" })),
    ).toBeNull();
    expect(
      notificationDestination(push({ deepLink: "com.opensteer.mobile:/deployments/nope" })),
    ).toBeNull();
    expect(notificationDestination(push(undefined))).toBeNull();
    expect(notificationDestination({})).toBeNull();
  });

  it("refuses a link whose ids are not ids", () => {
    expect(
      notificationDestination(
        push({ deepLink: `com.opensteer.mobile:/deployments/dep_nope/threads/${threadId}` }),
      ),
    ).toBeNull();
  });
});

describe("shouldPresentNotification", () => {
  it("stays quiet about the thread already on screen at its latest activity", () => {
    expect(shouldPresentNotification(push({ deepLink }), { deploymentId, threadId }, true)).toBe(
      false,
    );
  });

  it("presents everything else", () => {
    expect(shouldPresentNotification(push({ deepLink }), null, true)).toBe(true);
    expect(
      shouldPresentNotification(
        push({ deepLink }),
        { deploymentId, threadId: otherThreadId },
        true,
      ),
    ).toBe(true);
    expect(
      shouldPresentNotification(
        push({ deepLink }),
        { deploymentId: otherDeploymentId, threadId },
        true,
      ),
    ).toBe(true);
  });

  it("presents an update the open thread is scrolled away from", () => {
    expect(shouldPresentNotification(push({ deepLink }), { deploymentId, threadId }, false)).toBe(
      true,
    );
  });

  it("presents a notification it could not read rather than hiding it", () => {
    expect(
      shouldPresentNotification(push({ kind: "run-failed" }), { deploymentId, threadId }, true),
    ).toBe(true);
  });
});

describe("dismissThreadNotifications", () => {
  it("clears only what was delivered for the thread being opened", async () => {
    const dismiss = vi.fn(async (_identifier: string) => undefined);
    const otherLink = buildMobileThreadDeepLink({
      deploymentId,
      requestId: null,
      threadId: otherThreadId,
    });

    await dismissThreadNotifications({
      dismiss,
      presented: async () => [
        { identifier: "one", payload: push({ deepLink }) },
        { identifier: "two", payload: push({ deepLink: otherLink }) },
        { identifier: "three", payload: push({ kind: "run-failed" }) },
        { identifier: "four", payload: push({ deepLink }) },
      ],
      visible: { deploymentId, threadId },
    });

    expect(dismiss.mock.calls.map(([identifier]) => identifier)).toEqual(["one", "four"]);
  });
});
