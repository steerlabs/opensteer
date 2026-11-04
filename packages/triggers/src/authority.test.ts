import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { triggerAccess, type AuthorityThread } from "./authority.js";

const workspaceId = createId("workspace");
const lineageRootThreadId = createId("thread");
const actor = (overrides: Partial<AuthorityThread> = {}): AuthorityThread => ({
  accessMode: "full-access",
  inheritsMain: false,
  specialistId: null,
  workspaceId,
  lineageRootThreadId,
  ...overrides,
});

describe("trigger consent authority", () => {
  it("lets Main workers define across Workspaces and Project workers define locally", () => {
    const elsewhere = actor({ workspaceId: createId("workspace") });
    expect(triggerAccess(actor({ inheritsMain: true }), elsewhere)).toBe("define");
    expect(triggerAccess(actor(), elsewhere)).toBe("none");
    expect(triggerAccess(actor(), actor())).toBe("define");
  });
  it("does not let shared channel conversations reach unrelated Projects", () => {
    expect(triggerAccess(actor(), actor({ workspaceId: createId("workspace") }))).toBe("none");
  });
  it("keeps specialists inside their registration and lineage", () => {
    const specialist = actor({ inheritsMain: true, specialistId: "invoices" });
    expect(triggerAccess(specialist, actor())).toBe("none");
    expect(triggerAccess(specialist, specialist)).toBe("define");
    expect(
      triggerAccess(specialist, { ...specialist, lineageRootThreadId: createId("thread") }),
    ).toBe("none");
  });
  it("preserves the actor's access mode ceiling", () => {
    expect(triggerAccess(actor({ accessMode: "approval-required" }), actor())).toBe("see");
    expect(
      triggerAccess(actor({ accessMode: "auto" }), actor({ accessMode: "approval-required" })),
    ).toBe("control");
  });
});
