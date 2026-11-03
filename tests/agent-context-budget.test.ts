import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { opensteerAgentSkillNames } from "../packages/agent-tools/src/skills.js";
import { renderHarnessSkillCatalog } from "../packages/harness/src/skill-catalog.js";
import { loadAgentSkillBundle, planAgentSkills } from "../apps/runner/src/skills/agent-skills.js";
import { expect, it } from "vitest";
import { platformGuideForRun } from "../packages/agent-tools/src/guides.js";
import { measureMcpContext } from "../apps/host/src/agents/agent-context-budget.test-support.js";

it("matches the caller-visible MCP context byte budget", async () => {
  const metrics: Record<string, number> = {};
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  for (const kind of ["run", "program", "connection"] as const) {
    const context = await measureMcpContext(kind);
    metrics[`opensteer.${kind}.toolsJsonBytes`] = bytes(context.toolsJson);
    metrics[`opensteer.${kind}.instructionsBytes`] = bytes(context.instructions);
  }
  for (const role of ["conversation", "work"] as const) {
    for (const reach of ["user", "workspace", "lineage"] as const) {
      metrics[`runGuide.${role}.${reach}.bytes`] = bytes(platformGuideForRun({ role, reach }));
    }
  }
  const bundle = await loadAgentSkillBundle(
    fileURLToPath(new URL("../apps/runner/agent-skills", import.meta.url)),
  );
  const catalog = await renderHarnessSkillCatalog({
    skills: planAgentSkills(bundle, opensteerAgentSkillNames),
  });
  metrics["bundledSkills.catalogBytes"] = bytes(
    catalog!.replaceAll(bundle.rootPath, "<bundled-skills>"),
  );
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
