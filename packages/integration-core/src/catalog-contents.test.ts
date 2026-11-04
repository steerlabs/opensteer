import { expect, it } from "vitest";
import { IntegrationDefinitionSchema } from "./adapter.js";
import { catalogContents } from "./catalog.js";

it("projects declared operations and consent scopes without provider discovery", () => {
  const definition = IntegrationDefinitionSchema.parse({
    adapter: "openapi",
    id: "mail",
    name: "Mail",
    provider: "mail",
    description: "Read mail",
    config: { operationFilter: { include: [{ operationId: ["messages/list"] }] } },
    authMethods: [
      {
        id: "key",
        kind: "api-key",
        label: "Mail key",
        inputs: [{ label: "Key", secret: true, variable: "apiKey" }],
        placements: [{ carrier: "header", name: "Authorization", variable: "apiKey" }],
      },
    ],
  });
  expect(catalogContents(definition)).toEqual({
    contents: [{ name: "messages/list", kind: "tool" }],
    access: ["Mail key"],
  });
  expect(catalogContents({ ...definition, config: {} }).contents).toEqual([
    { name: "Mail tools (provider-discovered)", kind: "tool" },
  ]);
});
