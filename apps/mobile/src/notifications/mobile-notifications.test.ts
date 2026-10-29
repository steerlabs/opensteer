import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { buildMobileThreadDeepLink, DeploymentIdSchema, ThreadIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { MobileNotifications } from "./mobile-notifications.js";
import { createMockNotificationPort, type MobileNotificationPort } from "./notification-port.js";
import type { NotificationData, VisibleThread } from "./notification-routing.js";
import { PushRegistration } from "./push-registration.js";

const deploymentId = DeploymentIdSchema.parse("dep_0192f4a1-1111-4000-8000-000000000001");
const threadId = ThreadIdSchema.parse("thr_0192f4a1-2222-4000-8000-000000000001");
const otherThreadId = ThreadIdSchema.parse("thr_0192f4a1-2222-4000-8000-000000000002");
const visible: VisibleThread = { deploymentId, threadId };

function open() {
  const cleared: VisibleThread[] = [];
  let decide: ((payload: NotificationData) => boolean) | null = null;
  const port: MobileNotificationPort = {
    ...createMockNotificationPort({
      permissions: {
        current: async () => ({ canAskAgain: false, granted: true }),
        request: async () => ({ canAskAgain: false, granted: true }),
      },
    }),
    clearThread: async (thread) => {
      cleared.push(thread);
    },
    presentWhen: (rule) => {
      decide = rule;
    },
  };
  let seed = 3;
  const registration = new PushRegistration({
    accountConfigured: true,
    filePath: "/private/notifications.json",
    permissions: port.permissions,
    platform: "ios",
    privateFiles: new MemoryPrivateFilesystem(),
    randomBytes: (size) => new Uint8Array(size).map(() => (seed = (seed * 31 + 7) % 251)),
    // An Account with room, so these tests are about presentation only.
    registry: { register: async (_id, request) => request, unregister: async () => undefined },
    signedInSubject: async () => "acct_0192f4a1-0000-4000-8000-000000000001",
    tokens: port.tokens,
  });
  const notifications = new MobileNotifications({ port, registration });
  return {
    cleared,
    notifications,
    present: (thread: string) =>
      decide?.({
        data: {
          deepLink: buildMobileThreadDeepLink({
            deploymentId,
            requestId: null,
            threadId: ThreadIdSchema.parse(thread),
          }),
        },
      }),
    registration,
  };
}

describe("MobileNotifications", () => {
  it("stays quiet about the Thread being read and clears what was delivered for it", async () => {
    const fixture = open();
    await fixture.notifications.start();

    const leave = fixture.notifications.enterThread(visible);

    expect(fixture.cleared).toEqual([visible]);
    expect(fixture.notifications.visibleThread()).toEqual(visible);
    // Opening it says nothing about where in it the reader is, so an alert
    // still shows until the transcript reports that it is at its latest.
    expect(fixture.present(threadId)).toBe(true);
    fixture.notifications.readingLatest(visible, true);
    expect(fixture.present(threadId)).toBe(false);
    expect(fixture.present(otherThreadId)).toBe(true);

    leave();

    expect(fixture.notifications.visibleThread()).toBeNull();
    expect(fixture.present(threadId)).toBe(true);
  });

  it("lets the Thread now on screen keep its place when an older one leaves", async () => {
    const fixture = open();
    await fixture.notifications.start();
    const leaveFirst = fixture.notifications.enterThread(visible);
    const second: VisibleThread = { deploymentId, threadId: otherThreadId };
    fixture.notifications.enterThread(second);

    leaveFirst();

    expect(fixture.notifications.visibleThread()).toEqual(second);
  });

  it("ignores a late reading position from a pane that is no longer visible", async () => {
    const fixture = open();
    await fixture.notifications.start();
    fixture.notifications.enterThread(visible);
    fixture.notifications.readingLatest(visible, true);

    const second: VisibleThread = { deploymentId, threadId: otherThreadId };
    fixture.notifications.enterThread(second);
    fixture.notifications.readingLatest(second, false);
    fixture.notifications.readingLatest(visible, true);

    expect(fixture.present(otherThreadId)).toBe(true);
  });
});
