import { describe, expect, it } from "vitest";
import { resolveSkillPlan } from "./skill-plan.js";
const skill = (plugin: string | null, path: string) => ({
  plugin,
  localName: "research",
  fullName: plugin ? `${plugin}:research` : "research",
  path,
});
describe("resolveSkillPlan", () => {
  it("retains two plugins and a loose skill with the same local name", () => {
    const skills = [skill("one", "/one"), skill("two", "/two"), skill(null, "/loose")];
    expect(
      resolveSkillPlan({
        bundled: [skills[0]!],
        integration: [skills[1]!],
        workspace: [skills[2]!],
      })?.skills,
    ).toEqual(skills);
  });
  it("rejects duplicate full names across layers with both paths", () => {
    expect(() =>
      resolveSkillPlan({
        bundled: [skill("one", "/first")],
        integration: [skill("one", "/second")],
        workspace: [],
      }),
    ).toThrow("Duplicate Agent Skill full name one:research: /first and /second");
  });
  it("rejects duplicate loose names and colons in local names", () => {
    expect(() =>
      resolveSkillPlan({
        bundled: [],
        integration: [],
        workspace: [skill(null, "/first"), skill(null, "/second")],
      }),
    ).toThrow("Duplicate");
    expect(() =>
      resolveSkillPlan({
        bundled: [],
        integration: [],
        workspace: [{ ...skill(null, "/first"), localName: "one:research" }],
      }),
    ).toThrow("Invalid");
  });
});
