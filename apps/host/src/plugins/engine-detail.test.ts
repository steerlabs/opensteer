import { expect, test } from "vitest";
import { pluginStaleRunText } from "@opensteer/protocol";
import {
  agentScheduledRun,
  agentWorkflowRun,
  detailPreview,
  detailSection,
} from "./engine-detail.js";

test("an agent reads a stale run as a plain sentence that says what to do", () => {
  expect(agentWorkflowRun({ status: "errored", error: "stale" })).toEqual({
    status: "errored",
    error: pluginStaleRunText.workflow,
  });
  expect(agentWorkflowRun({ status: "errored", error: "execution" })).toEqual({
    status: "errored",
    error: "execution",
  });
  expect(agentScheduledRun({ status: "failed", failure: "stale" })).toEqual({
    status: "failed",
    failure: pluginStaleRunText.schedule,
  });
});

test("large tool, skill and version inventories cross IPC only as previews or pages", () => {
  const items = Array.from({ length: 600 }, (_, index) => ({
    name: `tool_${String(index).padStart(4, "0")}`,
    description: "d".repeat(5000),
    inputSchema: { description: "s".repeat(5000) },
    readOnly: true,
  }));
  const raw = {
    plugin: {
      id: "app_fixture",
      name: "Fixture",
      slug: "fixture",
      activeVersion: "dpl_fixture",
      requirements: { accounts: {} },
    },
    tools: { version: "dpl_fixture", items },
    skills: {
      app: { id: "app_fixture", name: "Fixture", slug: "fixture" },
      version: "dpl_fixture",
      revision: "fixture",
      skills: items,
    },
    versions: Array.from({ length: 600 }, (_, index) => ({
      id: `dpl_${index}`,
      createdAt: new Date(index).toISOString(),
      irrelevant: "v".repeat(5000),
    })),
    links: [],
    readiness: {},
    schedules: [],
    webhooks: [],
    workflows: [],
    hasPage: false,
  };
  expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(2 * 1024 * 1024);
  const preview = detailPreview(raw);
  expect(preview).toMatchObject({ toolCount: 600, skillCount: 600, versionCount: 600 });
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(50000);
  for (const section of ["tools", "skills", "versions"] as const) {
    let cursor: string | undefined;
    const names: string[] = [];
    do {
      const page = detailSection(raw, section, cursor);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(150000);
      names.push(...page.items.map((item) => ("name" in item ? String(item.name) : item.id)));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    expect(names).toHaveLength(600);
    expect(new Set(names).size).toBe(names.length);
  }
});
