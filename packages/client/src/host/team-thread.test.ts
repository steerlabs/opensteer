import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "./client.js";
import { threadActivity } from "./thread-activity.js";
import {
  composerRuntimeNotice,
  requestAnswerNote,
  requestAnswerRefusalText,
  requestOutcomeLine,
  requestWaitLines,
  taskStarterLine,
  taskStoppedText,
} from "./team-thread.js";

const place = { project: "Support", team: "Acme" };
const requestId = createId("request");
const at = "2026-11-10T10:42:00.000Z";

describe("a shared task's facts, in words", () => {
  it("never says a shared task waits for the reader when its Host says whom it waits on", () => {
    const thread = { id: createId("thread"), status: "waiting" as const };
    const input = { entries: [], runQueue: [] };
    expect(threadActivity({ ...input, thread })).toBe("waiting_for_you");
    expect(
      threadActivity({ ...input, thread: { ...thread, requestWaits: { items: [], total: 1 } } }),
    ).toBe("waiting");
  });

  it("names the starter, and the reader as you", () => {
    const userId = createId("user");
    expect(taskStarterLine({ kind: "person", userId, name: "Maya Chen" }, userId)).toBe(
      "Started by you",
    );
    expect(taskStarterLine({ kind: "person", userId, name: "Maya Chen" }, null)).toBe(
      "Started by Maya Chen",
    );
  });

  it("names a departed starter only when the Host gives the name", () => {
    expect(
      taskStoppedText({ reason: "membership-revoked", starterName: "Sam Lee" }, place).short,
    ).toBe("Stopped · Sam Lee is no longer in Acme");
    expect(taskStoppedText({ reason: "membership-revoked" }, place).short).not.toContain("Sam");
  });

  it("says how many waits the Host's window left out, and leaves out the one the reader answers", () => {
    const wait = (name: string) => ({
      requestId,
      class: "question" as const,
      since: at,
      waitingOn: { kind: "person" as const, name },
    });
    expect(requestWaitLines({ items: [wait("Maya Chen")], total: 40 }, "Support")).toEqual([
      "Waiting for Maya Chen to answer.",
      "39 more waiting.",
    ]);
    expect(requestWaitLines({ items: [], total: 0 }, "Support")).toEqual([]);
    expect(
      requestWaitLines({ items: [wait("Maya Chen")], total: 1 }, "Support", new Set([requestId])),
    ).toEqual([]);
  });

  it("names the departed person on a cancellation only when the Host captured it", () => {
    const cancelled = { requestId, status: "cancelled" as const, at };
    expect(
      requestOutcomeLine(
        { ...cancelled, reason: "membership-revoked", cancelledFor: { name: "Sam Lee" } },
        place,
      ),
    ).toBe("Cancelled: Sam Lee is no longer in Acme. The task stopped.");
    expect(requestOutcomeLine({ ...cancelled, reason: "membership-revoked" }, place)).not.toContain(
      "Sam",
    );
  });

  it("explains why the reader is asked only when the Host allows them to answer", () => {
    const managers = { kind: "managers" as const };
    expect(requestAnswerNote({ answer: { allowed: true }, waitingOn: managers }, "Support")).toBe(
      "Any manager of Support can answer.",
    );
    expect(
      requestAnswerNote(
        { answer: { allowed: false, reason: "manager-only" }, waitingOn: managers },
        "Support",
      ),
    ).toBeNull();
    expect(requestAnswerNote({ waitingOn: managers }, "Support")).toBeNull();
  });

  it("reads an answer that lost to an earlier one from the Host's reason", () => {
    const lost = new HostClientRequestError({
      code: "conflict",
      message: "Already answered.",
      reason: "request-already-settled",
      status: 409,
    });
    expect(requestAnswerRefusalText(lost)).toContain("answered first");
    expect(requestAnswerRefusalText(new Error("offline"))).toBeNull();
  });

  it("offers settings only to a manager, and says nothing without a runtime", () => {
    const missing = { state: "unavailable", reason: "not-configured" } as const;
    expect(composerRuntimeNotice(missing, { ...place, canChange: true })?.settings).toBe(true);
    expect(composerRuntimeNotice(missing, { ...place, canChange: false })?.settings).toBe(false);
    expect(composerRuntimeNotice(undefined, { ...place, canChange: false })).toBeNull();
    expect(composerRuntimeNotice({ state: "ready" }, { ...place, canChange: false })).toBeNull();
  });
});
