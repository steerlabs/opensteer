import { describe, expect, it } from "vitest";
import { createId } from "./ids.js";
import { HumanRootSchema, ProjectAuthoritySchema } from "./work-authority.js";
import { projectRequestAudience } from "./project-request-audience.js";

const origin = HumanRootSchema.parse({
  userId: createId("user"),
  initiatorGeneration: 2,
  membershipGeneration: 3,
  originConnectionId: null,
});
const authority = {
  version: 1,
  principal: {
    kind: "project",
    workspaceId: createId("workspace"),
    principalId: "principal:project:test",
  },
  origin,
};

describe("Project work authority", () => {
  it("accepts exact human roots and unattended authority, never partial or human-shaped envelopes", () => {
    expect(ProjectAuthoritySchema.parse(authority)).toEqual(authority);
    expect(ProjectAuthoritySchema.parse({ ...authority, origin: null }).origin).toBeNull();
    for (const key of Object.keys(origin)) {
      expect(
        ProjectAuthoritySchema.safeParse({
          ...authority,
          origin: Object.fromEntries(Object.entries(origin).filter(([field]) => field !== key)),
        }).success,
      ).toBe(false);
    }
    for (const extra of [
      { requestedBy: origin.userId },
      { userId: origin.userId },
      { origin: { ...origin, initiatorGeneration: 0 } },
      { origin: { ...origin, membershipGeneration: Number.MAX_SAFE_INTEGER + 1 } },
    ])
      expect(ProjectAuthoritySchema.safeParse({ ...authority, ...extra }).success).toBe(false);
  });

  it("routes human roots only to their requester and refuses unsupported or managerless work", () => {
    for (const requestClass of ["question", "harness-approval"] as const) {
      for (const eligibleManagerCount of [0, 1, 3]) {
        expect(projectRequestAudience({ origin, requestClass, eligibleManagerCount })).toEqual({
          state: "ready",
          requiredActor: "requester",
        });
        expect(
          projectRequestAudience({ origin: null, requestClass, eligibleManagerCount }),
        ).toEqual(
          eligibleManagerCount
            ? { state: "ready", requiredActor: "workspace-owner" }
            : { state: "refused", reason: "no-eligible-manager" },
        );
      }
    }
    for (const root of [origin, null])
      expect(
        projectRequestAudience({
          origin: root,
          requestClass: "unsupported",
          eligibleManagerCount: 3,
        }),
      ).toEqual({ state: "refused", reason: "unsupported-request-kind" });
  });
});
