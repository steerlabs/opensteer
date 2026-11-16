import type { IntegrationDefinition } from "@opensteer/integration-core/adapter";
import { discordIntegration } from "./definitions/discord.js";
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

/** Service integration presets: providers reached over the internet, in catalog order. */
export const serviceDefinitions: readonly IntegrationDefinition[] = [
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

export {
  catalogCategories,
  catalogPresentation,
  catalogProducts,
  type CatalogCategory,
  type CatalogPresentation,
} from "./listing.js";
