import { IntegrationDefinitionSchema } from "@opensteer/integration-core";

const notionSpec = {
  openapi: "3.1.0",
  info: { title: "Notion API", version: "2022-06-28" },
  servers: [{ url: "https://api.notion.com/v1" }],
  paths: {
    "/users/me": {
      get: { operationId: "retrieve-bot-user", responses: { "200": { description: "Bot user" } } },
    },
    "/search": {
      post: {
        operationId: "search",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Search results" } },
      },
    },
    "/pages/{page_id}": {
      parameters: [{ name: "page_id", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "retrieve-page", responses: { "200": { description: "Page" } } },
      patch: {
        operationId: "update-page",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "Updated page" } },
      },
    },
    "/pages": {
      post: {
        operationId: "create-page",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "Created page" } },
      },
    },
  },
} as const;

export const notionIntegration = IntegrationDefinitionSchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "api-key",
      kind: "api-key",
      label: "Notion integration token",
      inputs: [{ label: "Internal integration secret", secret: true, variable: "apiKey" }],
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
        { carrier: "header", name: "Notion-Version", literal: "2022-06-28" },
      ],
    },
  ],
  config: {
    inline: notionSpec,
    healthCheck: { operationId: "retrieve-bot-user", identityPath: "id", displayNamePath: "name" },
    readOnlyOperationIds: ["search"],
  },
  description: "Search, read, create, and update Notion pages with an internal integration.",
  id: "notion",
  name: "Notion REST",
  provider: "notion",
  setupUrl: "https://www.notion.so/profile/integrations",
});
