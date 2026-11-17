import {
  buildMobileThreadDeepLink,
  buildMobileNeedsYouDeepLink,
  DeploymentIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  TeamNoticeIdSchema,
  teamPageAppLink,
  ThreadIdSchema,
} from "@opensteer/core";
import { teamNotificationDeepLink } from "@opensteer/control-plane-protocol";
import { RequestIdSchema } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import {
  dismissThreadNotifications,
  notificationThread,
  shouldPresentNotification,
} from "./notification-routing.js";

const deploymentId = DeploymentIdSchema.parse("dep_0192f4a1-1111-4000-8000-000000000001");
const otherDeploymentId = DeploymentIdSchema.parse("dep_0192f4a1-1111-4000-8000-000000000002");
const threadId = ThreadIdSchema.parse("thr_0192f4a1-2222-4000-8000-000000000001");
const otherThreadId = ThreadIdSchema.parse("thr_0192f4a1-2222-4000-8000-000000000002");
const requestId = RequestIdSchema.parse("req_0192f4a1-3333-4000-8000-000000000001");

const deepLink = buildMobileThreadDeepLink({ deploymentId, requestId, threadId });

const push = (data: unknown) => ({ data });

describe("notificationThread", () => {
  it("opens a teammate's ask in the task it waits in, and one without a task in Needs you", async () => {
    const inTask = buildMobileThreadDeepLink({ deploymentId, requestId: null, threadId });
    expect(notificationThread(push({ deepLink: inTask, kind: "team-ask" }))).toMatchObject({
      deploymentId,
      requestId: null,
      threadId,
    });
    const payload = push({
      deepLink: buildMobileNeedsYouDeepLink(deploymentId),
      threadId,
      deploymentId: otherDeploymentId,
    });
    expect(notificationThread(payload)).toBeNull();
    expect(shouldPresentNotification(payload, { deploymentId, threadId }, true)).toBe(true);
    const dismiss = vi.fn();
    await dismissThreadNotifications({
      dismiss,
      presented: async () => [{ identifier: "consent", payload }],
      visible: { deploymentId, threadId },
    });
    expect(dismiss).not.toHaveBeenCalled();
  });
  it("reads the whole destination from the link alone", () => {
    expect(
      notificationThread(
        push({ deepLink, deploymentId, kind: "request-opened", requestId, threadId }),
      ),
    ).toEqual({ deploymentId, requestId, threadId });
  });

  it("ignores the payload's own identifiers when they contradict the link", () => {
    expect(
      notificationThread(
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
    expect(notificationThread(push({ deploymentId, threadId }))).toBeNull();
    expect(notificationThread(push({ deepLink: "https://opensteer.test/threads/x" }))).toBeNull();
    expect(
      notificationThread(push({ deepLink: "com.opensteer.mobile:/deployments/nope" })),
    ).toBeNull();
    expect(notificationThread(push(undefined))).toBeNull();
    expect(notificationThread({})).toBeNull();
  });

  it("refuses a link whose ids are not ids", () => {
    expect(
      notificationThread(
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

describe("a team's notifications", () => {
  const origin = "https://chat.acme.example";
  const channelId = TeamChannelIdSchema.parse("tch_0192f4a1-6666-4000-8000-000000000006");
  const teamId = DeploymentIdSchema.parse("dep_0192f4a1-5555-4000-8000-000000000005");
  // The links exactly as the team's push publication writes them.
  const message = teamNotificationDeepLink({
    kind: "team-message",
    origin,
    teamId,
    channelId,
    messageId: TeamMessageIdSchema.parse("42"),
  });
  const notice = teamNotificationDeepLink({
    kind: "team-notice",
    origin,
    teamId,
    noticeId: TeamNoticeIdSchema.parse("tnt_0192f4a1-7777-4000-8000-000000000007"),
  });

  it("names the team page alone, whatever the payload says beside it", () => {
    for (const link of [message, notice])
      expect(
        notificationThread(push({ deepLink: link, deploymentId, threadId, kind: "x" })),
      ).toBeNull();
    expect(
      notificationThread(
        push({
          deepLink: teamPageAppLink({ origin, target: { kind: "channel", channelId } }, "desktop"),
        }),
      ),
    ).toBeNull();
  });

  it("is presented over an open thread and never cleared by opening one", async () => {
    const visible = { deploymentId, threadId };
    expect(shouldPresentNotification(push({ deepLink: message }), visible, true)).toBe(true);
    const dismiss = vi.fn(async () => undefined);
    await dismissThreadNotifications({
      dismiss,
      presented: async () => [
        { identifier: "team", payload: push({ deepLink: message }) },
        { identifier: "thread", payload: push({ deepLink }) },
      ],
      visible,
    });
    expect(dismiss.mock.calls).toEqual([["thread"]]);
  });
});
