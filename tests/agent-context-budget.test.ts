import { expect, it } from "vitest";
import { platformGuideForRun } from "../packages/agent-tools/src/catalog.js";
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
  await expect(`${JSON.stringify(metrics, null, 2)}\n`).toMatchFileSnapshot(
    "./agent-context-budget.json",
  );
});
