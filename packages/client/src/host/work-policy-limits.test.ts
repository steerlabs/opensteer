import { ThreadAccessModeSchema } from "@opensteer/core";
import { defaultWorkPolicy, orgModeLabel } from "@opensteer/control-plane-protocol";
import { describe, expect, it } from "vitest";
import { accessModeOptions } from "./access-modes.js";
import { workPolicyLimits } from "./work-policy-limits.js";

const notAllowed = "Your organization doesn’t allow this";

describe("work policy limits on consent and the grant editor", () => {
  it("rules nothing out without a policy", () => {
    const limits = workPolicyLimits(undefined);
    for (const mode of ThreadAccessModeSchema.options) expect(limits.mode(mode)).toBeNull();
    expect(limits.everything).toBeNull();
    expect(limits.tasks).toBeNull();
  });

  it("rules out modes above the ceiling, tasks and everything under the default policy", () => {
    const limits = workPolicyLimits(defaultWorkPolicy);
    expect(limits.mode("approval-required")).toBeNull();
    expect(limits.mode("auto-accept-edits")).toBe(notAllowed);
    expect(limits.mode("full-access")).toBe(notAllowed);
    expect(limits.tasks).toBe(notAllowed);
    expect(limits.everything).toBe(notAllowed);
  });

  it("allows everything only together with tasks", () => {
    const tasksOnly = workPolicyLimits({ ...defaultWorkPolicy, allowTasks: true });
    expect(tasksOnly.tasks).toBeNull();
    expect(tasksOnly.everything).toBe(notAllowed);
    const everything = workPolicyLimits({
      ...defaultWorkPolicy,
      allowTasks: true,
      allowEverything: true,
      externalMaxMode: "full-access",
    });
    expect(everything.everything).toBeNull();
    expect(everything.mode("full-access")).toBeNull();
    expect(workPolicyLimits({ ...defaultWorkPolicy, allowEverything: true }).everything).toBe(
      notAllowed,
    );
  });

  it("names each mode the way the apps' mode choices do", () => {
    for (const option of accessModeOptions) expect(orgModeLabel(option.mode)).toBe(option.label);
  });
});
