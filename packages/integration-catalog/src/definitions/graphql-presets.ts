import type { IntegrationDefinition } from "@opensteer/integration-core";
import {
  apiKeyGraphqlPreset,
  bearerApiKey,
  publicGraphqlPreset,
  secretInput,
} from "./preset-helpers.js";

export const graphqlPresetIntegrations: readonly IntegrationDefinition[] = [
  apiKeyGraphqlPreset({
    description:
      "Repositories, issues, pull requests, discussions, projects, and users through GitHub GraphQL.",
    endpoint: "https://api.github.com/graphql",
    healthCheck: {
      displayNamePath: "data.viewer.login",
      identityPath: "data.viewer.id",
      query: "query OpensteerGitHubHealth { viewer { id login } }",
    },
    id: "github-graphql",
    inputs: [secretInput("Fine-grained personal access token")],
    name: "GitHub GraphQL",
    placements: bearerApiKey,
    provider: "github",
    setupUrl: "https://github.com/settings/personal-access-tokens/new",
  }),
  apiKeyGraphqlPreset({
    description: "Projects, merge requests, pipelines, groups, and users through GitLab GraphQL.",
    endpoint: "https://gitlab.com/api/graphql",
    healthCheck: {
      displayNamePath: "data.currentUser.username",
      identityPath: "data.currentUser.id",
      query: "query OpensteerGitLabHealth { currentUser { id username } }",
    },
    id: "gitlab-graphql",
    inputs: [secretInput("Personal access token")],
    name: "GitLab GraphQL",
    placements: bearerApiKey,
    provider: "gitlab",
    setupUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
  }),
  apiKeyGraphqlPreset({
    description: "Boards, items, columns, workspaces, and automation through Monday.com GraphQL.",
    endpoint: "https://api.monday.com/v2",
    healthCheck: {
      displayNamePath: "data.me.name",
      identityPath: "data.me.id",
      query: "query OpensteerMondayHealth { me { id name account { id } } }",
      tenantPath: "data.me.account.id",
    },
    id: "monday-graphql",
    inputs: [secretInput("Personal API token")],
    name: "Monday.com GraphQL",
    placements: [{ carrier: "header", name: "Authorization", variable: "apiKey" }],
    provider: "monday",
    setupUrl: "https://developer.monday.com/api-reference/docs/authentication",
  }),
  publicGraphqlPreset({
    description: "Public anime, manga, staff, characters, and media lists through AniList GraphQL.",
    endpoint: "https://graphql.anilist.co",
    id: "anilist-graphql",
    name: "AniList GraphQL",
    provider: "anilist",
  }),
];
