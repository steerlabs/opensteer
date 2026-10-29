import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  agentCapabilityProfiles,
  platformGuideForRun,
} from "../packages/agent-tools/src/catalog.js";
import { skillsForCapabilityProfile } from "../packages/agent-tools/src/skills.js";
import { renderHarnessSkillCatalog } from "../packages/harness/src/skill-catalog.js";
import { measureMcpContext } from "../apps/host/src/agents/agent-context-budget.test-support.js";

// Failure modes: a registration is missed, instructions drift, a profile/role is
// omitted, or local paths make the byte budget depend on the checkout location.
it("matches the model-visible context byte budget", async () => {
  const metrics: Record<string, number> = {};
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const skillRoot = resolve(import.meta.dirname, "../apps/runner/agent-skills/skills");
  for (const { id } of agentCapabilityProfiles) {
    for (const [server, context] of Object.entries(await measureMcpContext(id))) {
      metrics[`${server}.${id}.toolsJsonBytes`] = bytes(context.toolsJson);
      metrics[`${server}.${id}.instructionsBytes`] = bytes(context.instructions);
    }
    for (const role of ["conversation", "work"] as const) {
      metrics[`runGuide.${id}.${role}.bytes`] = bytes(
        platformGuideForRun({ capabilityProfileId: id, role }),
      );
    }
    const catalog = await renderHarnessSkillCatalog({
      skills: skillsForCapabilityProfile(id).map(({ name }) => ({
        name,
        path: resolve(skillRoot, name),
      })),
    });
    // The renderer reads real shipped metadata; only the machine-specific path
    // prefix is replaced with the same absolute fixture path on every platform.
    metrics[`skillsIndex.${id}.bytes`] = bytes(
      (catalog ?? "").replaceAll(skillRoot, "/opensteer/skills"),
    );
  }
  await expect(`${JSON.stringify(metrics, null, 2)}\n`).toMatchFileSnapshot(
    "./agent-context-budget.json",
  );
});
