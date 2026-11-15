import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  OpensteerAgentSkillNameSchema,
  opensteerAgentSkillNames,
} from "../packages/agent-tools/src/skills.js";
import type { RunToolCapabilities } from "../packages/agent-tools/src/registry.js";
import { renderHarnessSkillCatalog } from "../packages/harness/src/skill-catalog.js";
import { loadAgentSkillBundle, planAgentSkills } from "../apps/runner/src/skills/agent-skills.js";
import { expect, it } from "vitest";
import {
  platformGuideForRun,
  platformGuideSectionsForRun,
} from "../packages/agent-tools/src/guides.js";
import { agentToolsPlanForRun } from "../apps/host/src/agents/agent-tools-plan.js";
import { measureMcpContext } from "../apps/host/src/agents/agent-context-budget.test-support.js";

const all: RunToolCapabilities = { tabs: true, pages: true, computerUse: true, apps: true };
const none: RunToolCapabilities = { tabs: false, pages: false, computerUse: false, apps: false };
// Each mirrors a Run the Host plans: a limited Codex Run cannot run Browser Harness.
const runPlans = {
  "full-access": { accessMode: "full-access", capabilities: all, personalContext: true },
  limited: { accessMode: "auto", capabilities: all, personalContext: true },
  "limited-codex": {
    accessMode: "auto",
    capabilities: { ...all, pages: false },
    personalContext: true,
  },
  "no-personal-context": { accessMode: "full-access", capabilities: none, personalContext: false },
} as const;
// Codex middle-truncates an entry beyond about 4,000 bytes; leave margin so no section is cut.
const codexEntryBytes = 3_500;
const capabilityTools = {
  tabs: ["tab_list", "tab_open", "tab_close", "tab_organize", "tab_group_update", "person_show"],
  computerUse: ["computer_use"],
  apps: ["app_publish", "app_list", "app_start", "app_stop", "app_delete"],
} as const;
const capabilityHeadings = {
  tabs: "Tabs:\n",
  pages: "openPage(tabId)",
  computerUse: "Computer use:\n",
  apps: "Apps:\n",
} as const;

it("matches the caller-visible MCP context byte budget", async () => {
  const metrics: Record<string, number> = {};
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const listed: Record<string, { name: string }[]> = {};
  for (const kind of ["run", "program", "connection"] as const) {
    const context = await measureMcpContext(kind);
    listed[kind] = JSON.parse(context.toolsJson) as { name: string }[];
    metrics[`opensteer.${kind}.toolsJsonBytes`] = bytes(context.toolsJson);
    metrics[`opensteer.${kind}.instructionsBytes`] = bytes(context.instructions);
  }
  for (const purpose of ["task", "background-job", "voice"] as const) {
    for (const personalContext of [true, false])
      metrics[`runGuide.${purpose}.personalContext.${personalContext}.bytes`] = bytes(
        platformGuideForRun({ purpose, capabilities: all, personalContext }),
      );
  }
  const bundle = await loadAgentSkillBundle(
    fileURLToPath(new URL("../apps/runner/agent-skills", import.meta.url)),
  );
  const skillCatalog = async (names: readonly (typeof opensteerAgentSkillNames)[number][]) =>
    (await renderHarnessSkillCatalog({ skills: planAgentSkills(bundle, names) }))!.replaceAll(
      bundle.rootPath,
      "<bundled-skills>",
    );
  // What one Run is actually sent: its plan's guide and skills, and the
  // production listTools entries its engine is told to enable.
  for (const [name, run] of Object.entries(runPlans)) {
    const plan = agentToolsPlanForRun({
      url: "http://localhost/mcp",
      token: "budget",
      purpose: "task",
      ...run,
    });
    const advertised = listed.run!.filter((tool) => plan.tools.includes(tool.name));
    expect(advertised.map((tool) => tool.name)).toEqual(plan.tools);
    metrics[`runPlan.${name}.injectedTextBytes`] =
      bytes(plan.instructions) +
      bytes(
        await skillCatalog(plan.skills.map((skill) => OpensteerAgentSkillNameSchema.parse(skill))),
      );
    metrics[`runPlan.${name}.advertisedSchemaBytes`] = bytes(JSON.stringify(advertised));

    const sections = platformGuideSectionsForRun({ purpose: "task", ...run });
    expect(sections.join("\n\n")).toBe(plan.instructions);
    for (const section of sections) expect(bytes(section)).toBeLessThan(codexEntryBytes);
    for (const capability of Object.keys(capabilityHeadings) as (keyof RunToolCapabilities)[]) {
      expect(plan.instructions.includes(capabilityHeadings[capability])).toBe(
        run.capabilities[capability],
      );
      if (capability !== "pages")
        for (const tool of capabilityTools[capability])
          expect(plan.tools.includes(tool)).toBe(run.capabilities[capability]);
    }
    expect(plan.skills.includes("opensteer:browser")).toBe(run.capabilities.pages);
    expect(plan.skills.includes("opensteer:computer-use")).toBe(run.capabilities.computerUse);
  }
  metrics["bundledSkills.catalogBytes"] = bytes(await skillCatalog(opensteerAgentSkillNames));
  metrics["bundledSkills.bodyBytes"] = 0;
  metrics["bundledSkills.referenceBytes"] = 0;
  metrics["bundledSkills.openaiMetadataBytes"] = 0;
  for (const path of Object.values(bundle.paths)) {
    metrics["bundledSkills.bodyBytes"] += bytes(await readFile(join(path, "SKILL.md"), "utf8"));
    metrics["bundledSkills.openaiMetadataBytes"] += bytes(
      await readFile(join(path, "agents/openai.yaml"), "utf8"),
    );
    for (const file of await readdir(join(path, "references"))) {
      if (file.endsWith(".md"))
        metrics["bundledSkills.referenceBytes"] += bytes(
          await readFile(join(path, "references", file), "utf8"),
        );
    }
  }
  await expect(`${JSON.stringify(metrics, null, 2)}\n`).toMatchFileSnapshot(
    "./agent-context-budget.json",
  );
});
