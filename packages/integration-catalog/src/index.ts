import type { IntegrationDefinition } from "@opensteer/integration-core";
import { discordIntegration } from "./definitions/discord.js";
import { computerAppIntegrations } from "./definitions/computer-apps.js";
import { githubIntegration } from "./definitions/github.js";
import { googleIntegrations } from "./definitions/google.js";
import { graphqlPresetIntegrations } from "./definitions/graphql-presets.js";
import { linearIntegration } from "./definitions/linear.js";
import { mcpPresetIntegrations } from "./definitions/mcp-presets.js";
import { microsoftIntegrations } from "./definitions/microsoft.js";
import { notionIntegration } from "./definitions/notion.js";
import { openApiPresetIntegrations } from "./definitions/openapi-presets.js";
import { resendIntegration } from "./definitions/resend.js";
import { slackIntegration } from "./definitions/slack.js";

export { discordIntegration } from "./definitions/discord.js";
export { computerAppIntegrations } from "./definitions/computer-apps.js";
export { githubIntegration } from "./definitions/github.js";
export { googleIntegrations } from "./definitions/google.js";
export { graphqlPresetIntegrations } from "./definitions/graphql-presets.js";
export { linearIntegration } from "./definitions/linear.js";
export { mcpPresetIntegrations } from "./definitions/mcp-presets.js";
export { microsoftIntegrations } from "./definitions/microsoft.js";
export { notionIntegration } from "./definitions/notion.js";
export { openApiPresetIntegrations } from "./definitions/openapi-presets.js";
export { resendIntegration } from "./definitions/resend.js";
export { slackIntegration } from "./definitions/slack.js";

export const integrationDefinitions: readonly IntegrationDefinition[] = [
  ...computerAppIntegrations,
  ...googleIntegrations,
  slackIntegration,
  githubIntegration,
  discordIntegration,
  resendIntegration,
  linearIntegration,
  notionIntegration,
  ...microsoftIntegrations,
  ...openApiPresetIntegrations,
  ...graphqlPresetIntegrations,
  ...mcpPresetIntegrations,
];

const definitionsById = new Map(
  integrationDefinitions.map((definition) => [definition.id, definition]),
);

export function getIntegrationDefinition(id: string): IntegrationDefinition | undefined {
  return definitionsById.get(id);
}
