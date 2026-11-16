import { describe, expect, it } from "vitest";
import { agentTools, toolsFor } from "../index.js";
import { opensteer_plugin_list } from "./plugins.js";

describe("settings tools", () => {
  it("shows every read below full-access and keeps changes behind it", () => {
    const shown = (accessMode: "approval-required" | "full-access") =>
      new Set(
        toolsFor({ kind: "run", accessMode, teamsAvailable: true, knowledge: true }).map(
          ({ name }) => name,
        ),
      );
    const readOnly = shown("approval-required");
    for (const tool of agentTools.filter((tool) => tool.callers.some((kind) => kind === "run"))) {
      if (tool.access === "settings") {
        expect(readOnly.has(tool.name), tool.name).toBe(false);
        expect(shown("full-access").has(tool.name), tool.name).toBe(true);
      }
      if (tool.access === "read") expect(readOnly.has(tool.name), tool.name).toBe(true);
    }
  });
  it("strips credentials and nested launch configuration from plugin listings", () => {
    expect(
      opensteer_plugin_list.output.parse({
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
    ).toEqual({ plugins: [{ id: "p", name: "Plugin" }] });
  });
});
