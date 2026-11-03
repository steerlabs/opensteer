import { describe, expect, it } from "vitest";
import { agentTools } from "./index.js";

const names = [
  "project_write",
  "settings_read",
  "settings_write",
  "computer_list",
  "computer_write",
  "integration_manage",
  "channel_manage",
  "plugin_manage",
  "browser_profile_write",
] as const;
describe("administration tools", () => {
  it.each(names)("registers %s for Runs and connections", (name) => {
    const tool = agentTools.find((tool) => tool.name === name);
    expect(tool).toBeDefined();
    expect(tool?.callers).toContain("run");
    expect(tool?.callers).toContain("connection");
    expect(tool?.access).toBe(
      name === "settings_read" || name === "computer_list" ? "read" : "settings",
    );
  });
  it("never exposes specialist creation or binding", () => {
    const tool = agentTools.find((tool) => tool.name === "plugin_manage");
    expect(tool?.input.safeParse({ action: "add_specialist" }).success).toBe(false);
    expect(tool?.input.safeParse({ action: "bind" }).success).toBe(false);
  });
  it("strips credentials and nested launch configuration", () => {
    const tool = agentTools.find((tool) => tool.name === "plugin_manage");
    expect(
      tool?.output.parse({
        ok: true,
        plugins: [
          {
            id: "p",
            name: "Plugin",
            config: { token: "secret" },
            versions: [{ env: { SECRET: "secret" } }],
          },
        ],
        token: "secret",
      }),
    ).toEqual({ ok: true, plugins: [{ id: "p", name: "Plugin" }] });
  });
});
