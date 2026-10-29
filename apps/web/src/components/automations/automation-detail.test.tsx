import { describe, expect, it } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { triggerRunLifecycleSignature } from "./automation-detail.js";

describe("triggerRunLifecycleSignature", () => {
  it("ignores streaming metadata but changes with Run lifecycle state", () => {
    const snapshot = new MockHostClient({ latencyMs: 0 }).getSnapshot();
    const original = triggerRunLifecycleSignature(snapshot);
    expect(
      triggerRunLifecycleSignature({
        ...snapshot,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          unread: !thread.unread,
          updatedAt: "2026-09-12T16:01:00.000Z",
        })),
      }),
    ).toBe(original);
    expect(
      triggerRunLifecycleSignature({
        ...snapshot,
        threads: snapshot.threads.map((thread, index) =>
          index === 0 ? { ...thread, status: "failed" } : thread,
        ),
      }),
    ).not.toBe(original);
  });
});
