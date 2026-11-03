import { describe, expect, it } from "vitest";
import { createId } from "./ids.js";
import {
  lineageCompatibleForReuse,
  threadInReach,
  threadReachScope,
  type ReachThread,
  type ThreadReachScope,
} from "./thread-authority.js";

const main = createId("workspace");
const project = createId("workspace");
const otherProject = createId("workspace");
const root = createId("thread");
const thread = (overrides: Partial<ReachThread> = {}): ReachThread => ({
  inheritsMain: false,
  specialistId: null,
  workspaceId: project,
  lineageRootThreadId: root,
  ...overrides,
});

describe("consent reach", () => {
  it("gives Main's delegated workers their root's reach across the person's Workspaces", () => {
    const worker = thread({ inheritsMain: true });
    expect(threadReachScope(worker)).toEqual({ kind: "user" });
    expect(threadInReach(worker, thread({ workspaceId: otherProject }))).toBe(true);
  });

  it("keeps Project workers and shared conversations in the owner's Main within their Workspace", () => {
    for (const workspaceId of [project, main]) {
      const worker = thread({ workspaceId });
      expect(threadReachScope(worker)).toEqual({ kind: "workspace", workspaceId });
      expect(threadInReach(worker, thread({ workspaceId }))).toBe(true);
      expect(threadInReach(worker, thread({ workspaceId: otherProject }))).toBe(false);
    }
  });

  it("keeps specialists in their lineage even when their root inherits Main", () => {
    const specialist = thread({ inheritsMain: true, specialistId: "invoices" });
    expect(threadReachScope(specialist)).toEqual({ kind: "lineage", lineageRootThreadId: root });
    expect(threadInReach(specialist, thread({ workspaceId: main }))).toBe(true);
    expect(threadInReach(specialist, thread({ lineageRootThreadId: createId("thread") }))).toBe(
      false,
    );
  });

  it("checks an explicitly approved connection scope without inventing a Thread lineage", () => {
    const approved: ThreadReachScope = { kind: "workspace", workspaceId: project };
    expect(threadInReach(approved, thread())).toBe(true);
    expect(threadInReach(approved, thread({ workspaceId: otherProject }))).toBe(false);
    expect(threadInReach({ kind: "user" }, thread({ workspaceId: otherProject }))).toBe(true);
    expect(threadInReach({ kind: "lineage", lineageRootThreadId: root }, thread())).toBe(true);
    expect(
      threadInReach(
        { kind: "lineage", lineageRootThreadId: root },
        thread({ lineageRootThreadId: createId("thread") }),
      ),
    ).toBe(false);
  });

  it("refuses reuse that would borrow Main inheritance or escape a specialist binding", () => {
    expect(lineageCompatibleForReuse(thread(), thread({ inheritsMain: true }))).toBe(false);
    expect(lineageCompatibleForReuse(thread({ inheritsMain: true }), thread())).toBe(true);
    expect(lineageCompatibleForReuse(thread(), thread())).toBe(true);
    expect(
      lineageCompatibleForReuse(thread({ inheritsMain: true }), thread({ inheritsMain: true })),
    ).toBe(true);
    const specialist = thread({ specialistId: "invoices" });
    expect(lineageCompatibleForReuse(specialist, thread())).toBe(false);
    expect(lineageCompatibleForReuse(specialist, thread({ specialistId: "calendar" }))).toBe(false);
    expect(lineageCompatibleForReuse(specialist, specialist)).toBe(true);
  });
});
