import { describe, expect, it } from "vitest";
import { catalogPresentation, catalogProducts, integrationDefinitions } from "./index.js";

describe("catalog listing", () => {
  it("lists every definition exactly once, under one product", () => {
    const listed = catalogProducts.flatMap(({ definitionIds }) => definitionIds);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(integrationDefinitions.map(({ id }) => id).sort());
    const names = catalogProducts.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names each way into a product apart, keeping the product's name for its default", () => {
    const linear = integrationDefinitions.filter(({ id }) => id.startsWith("linear"));
    expect(linear.map((definition) => catalogPresentation(definition))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productId: "linear-mcp",
          title: "Linear",
          variant: "MCP server",
        }),
        expect.objectContaining({
          productId: "linear-mcp",
          title: "Linear (GraphQL API)",
          variant: "GraphQL API",
        }),
      ]),
    );
    for (const { definitionIds } of catalogProducts) {
      const titles = definitionIds.map(
        (id) => catalogPresentation(integrationDefinitions.find((d) => d.id === id)!)?.title,
      );
      expect(new Set(titles).size, definitionIds.join()).toBe(definitionIds.length);
    }
    expect(catalogPresentation({ adapter: "mcp", id: "agent-proposed" })).toBeNull();
  });

  it("keeps apps on a person's devices in their own category", () => {
    for (const definition of integrationDefinitions)
      expect(catalogPresentation(definition)?.category === "devices", definition.id).toBe(
        definition.adapter === "computer",
      );
  });
});
