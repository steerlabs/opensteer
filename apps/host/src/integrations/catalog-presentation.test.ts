import { getIntegrationDefinition, integrationDefinitions } from "@opensteer/integration-catalog";
import { hostApi, type PluginRow } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { listedPluginRow, settingsCatalogEntries } from "./catalog-presentation.js";

describe("catalog presentation", () => {
  it("lists the catalog by product, popular picks first, in a shape the wire accepts", () => {
    const catalog = settingsCatalogEntries(integrationDefinitions, new Set(["linear"]));
    expect(catalog.slice(0, 2).map(({ title, product }) => ({ title, product }))).toEqual([
      {
        title: "Slack",
        product: { id: "slack", title: "Slack", category: "communication", popular: true },
      },
      {
        title: "Gmail",
        product: { id: "google-gmail", title: "Gmail", category: "communication", popular: true },
      },
    ]);
    const linear = catalog.filter(({ product }) => product?.id === "linear-mcp");
    expect(linear.map(({ title, variant, added }) => ({ title, variant, added }))).toEqual([
      { title: "Linear", variant: "MCP server", added: false },
      { title: "Linear (GraphQL API)", variant: "GraphQL API", added: true },
    ]);
    expect(catalog).toHaveLength(integrationDefinitions.length);
    expect(() =>
      hostApi["plugins.directory.get"].success.parse({
        catalog,
        requests: [],
        hasMoreRequests: false,
      }),
    ).not.toThrow();
  });

  it("names built-in rows by the listing and leaves agent-proposed ones as given", () => {
    const row = {
      target: { kind: "service", definitionId: "linear" },
      title: getIntegrationDefinition("linear")!.name,
      source: { kind: "built-in", version: null },
    } as PluginRow;
    expect(listedPluginRow(row).title).toBe("Linear (GraphQL API)");
    const proposed = { ...row, title: "My Linear", source: { kind: "proposed", version: null } };
    expect(listedPluginRow(proposed as PluginRow).title).toBe("My Linear");
    const skill = { ...row, target: { kind: "plugin", pluginId: "notes" } } as PluginRow;
    expect(listedPluginRow(skill)).toBe(skill);
  });
});
