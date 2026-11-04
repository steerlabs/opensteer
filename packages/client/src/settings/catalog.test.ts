import type { PluginRow } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  pluginCatalogCategories,
  pluginCatalogMatches,
  pluginCatalogProducts,
  pluginCatalogToAdd,
  remoteMcpSlug,
  type PluginCatalogEntry,
} from "./catalog.js";

const entry = (
  definitionId: string,
  product?: PluginCatalogEntry["product"],
  variant?: string,
): PluginCatalogEntry => ({
  definitionId,
  title: definitionId,
  description: `${definitionId} description`,
  added: false,
  ...(product ? { product } : {}),
  ...(variant ? { variant } : {}),
});
const linear = { id: "linear-mcp", title: "Linear", category: "developer", popular: true };

describe("plugin catalog", () => {
  it("offers each product once, default way in first, and an unlisted entry on its own", () => {
    const products = pluginCatalogProducts([
      entry("linear", linear, "GraphQL API"),
      entry("linear-mcp", linear, "MCP server"),
      entry("from-an-older-host"),
    ]);
    expect(products.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "linear-mcp", title: "Linear" },
      { id: "from-an-older-host", title: "from-an-older-host" },
    ]);
    expect(products[0]!.variants.map(({ definitionId }) => definitionId)).toEqual([
      "linear-mcp",
      "linear",
    ]);
    expect(products[0]!.description).toBe("linear-mcp description");
    expect(pluginCatalogCategories(products)).toEqual([
      { id: "developer", label: "Developer tools" },
    ]);
  });

  it("leaves out a product once any way into it is already the person's", () => {
    const products = pluginCatalogProducts([
      entry("linear-mcp", linear),
      entry("linear", linear),
      entry("slack", { id: "slack", title: "Slack", category: "communication", popular: true }),
    ]);
    const row = { target: { kind: "service", definitionId: "linear" } } as PluginRow;
    expect(pluginCatalogToAdd(products, [row]).map(({ id }) => id)).toEqual(["slack"]);
  });

  it("finds a product by name, words in its description or its category", () => {
    const [product] = pluginCatalogProducts([entry("linear-mcp", linear)]);
    expect(pluginCatalogMatches(product!, "  LIN ")).toBe(true);
    expect(pluginCatalogMatches(product!, "developer tools")).toBe(true);
    expect(pluginCatalogMatches(product!, "description")).toBe(true);
    expect(pluginCatalogMatches(product!, "slack")).toBe(false);
  });

  it("names a remote MCP server with a slug the Host accepts", () => {
    expect(remoteMcpSlug("  My CRM! ")).toBe("my-crm");
    expect(remoteMcpSlug("Café — Ops")).toBe("caf-ops");
    expect(remoteMcpSlug("!!!")).toBe("mcp-server");
    expect(remoteMcpSlug(`${"a".repeat(63)} b`)).toMatch(/^a{63}$/u);
  });
});
