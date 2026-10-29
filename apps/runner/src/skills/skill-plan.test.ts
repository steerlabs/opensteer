import { describe, expect, it } from "vitest";
import { resolveSkillPlan } from "./skill-plan.js";

const bundled = [{ name: "opensteer-threads", path: "/runner/skills/opensteer-threads" }];

describe("resolveSkillPlan", () => {
  it("lets the Workspace layer shadow the integration layer by name", () => {
    const plan = resolveSkillPlan({
      bundled: [],
      integration: [{ name: "research", path: "/state/integration/research" }],
      workspace: [{ name: "research", path: "/workspace/skills/research" }],
    });

    expect(plan?.skills).toEqual([{ name: "research", path: "/workspace/skills/research" }]);
  });

  it("lets the integration and Workspace layers shadow bundled skills by name", () => {
    const plan = resolveSkillPlan({
      bundled: [
        { name: "shadowed-by-integration", path: "/runner/skills/one" },
        { name: "shadowed-by-workspace", path: "/runner/skills/two" },
        { name: "kept", path: "/runner/skills/three" },
      ],
      integration: [{ name: "shadowed-by-integration", path: "/state/integration/one" }],
      workspace: [{ name: "shadowed-by-workspace", path: "/workspace/skills/two" }],
    });

    expect(plan?.skills).toEqual([
      { name: "kept", path: "/runner/skills/three" },
      { name: "shadowed-by-integration", path: "/state/integration/one" },
      { name: "shadowed-by-workspace", path: "/workspace/skills/two" },
    ]);
  });

  it("rejects a duplicate name inside the bundled layer", () => {
    expect(() =>
      resolveSkillPlan({
        bundled: [...bundled, { name: "opensteer-threads", path: "/runner/skills/other" }],
        integration: [],
        workspace: [],
      }),
    ).toThrow("Duplicate Opensteer bundled Agent Skill name opensteer-threads");
  });

  it("rejects a duplicate name inside the integration layer", () => {
    expect(() =>
      resolveSkillPlan({
        bundled: [],
        integration: [
          { name: "research", path: "/state/integration/a/research" },
          { name: "research", path: "/state/integration/b/research" },
        ],
        workspace: [],
      }),
    ).toThrow("Duplicate integration Agent Skill name research");
  });

  it("rejects an integration skill that claims the reserved Opensteer prefix", () => {
    expect(() =>
      resolveSkillPlan({
        bundled,
        integration: [{ name: "opensteer-threads", path: "/state/integration/opensteer-threads" }],
        workspace: [],
      }),
    ).toThrow("reserved for Opensteer");
  });
});
