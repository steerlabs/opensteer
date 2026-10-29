import {
  IntegrationDefinitionSchema,
  type IntegrationDefinition,
} from "@opensteer/integration-core";
import { apiKeyOpenApiPreset, bearerApiKey, secretInput } from "./preset-helpers.js";

const presets: readonly IntegrationDefinition[] = [
  apiKeyOpenApiPreset({
    description:
      "Files, comments, components, variables, projects, and webhooks through Figma REST.",
    healthCheck: { operationId: "getMe" },
    id: "figma-rest",
    inputs: [secretInput("Personal access token")],
    name: "Figma REST",
    placements: [{ carrier: "header", name: "X-Figma-Token", variable: "apiKey" }],
    provider: "figma",
    setupUrl: "https://www.figma.com/developers/api#access-tokens",
    specUrl:
      "https://raw.githubusercontent.com/figma/rest-api-spec/refs/heads/main/openapi/openapi.yaml",
  }),
  apiKeyOpenApiPreset({
    description: "Payments, subscriptions, customers, invoices, and billing through Stripe REST.",
    healthCheck: { operationId: "GetAccount" },
    id: "stripe-rest",
    inputs: [secretInput("Restricted API key")],
    name: "Stripe REST",
    placements: bearerApiKey,
    provider: "stripe",
    setupUrl: "https://dashboard.stripe.com/apikeys",
    specUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  }),
  apiKeyOpenApiPreset({
    description:
      "Deployments, projects, domains, teams, and edge configuration through Vercel REST.",
    healthCheck: { operationId: "getAuthUser" },
    id: "vercel-rest",
    inputs: [secretInput("Access token")],
    name: "Vercel REST",
    placements: bearerApiKey,
    provider: "vercel",
    setupUrl: "https://vercel.com/account/settings/tokens",
    specUrl: "https://openapi.vercel.sh",
  }),
  apiKeyOpenApiPreset({
    description: "Projects, branches, endpoints, databases, and roles through the Neon API.",
    healthCheck: { operationId: "listProjects" },
    id: "neon-rest",
    inputs: [secretInput("API key")],
    name: "Neon REST",
    placements: bearerApiKey,
    provider: "neon",
    setupUrl: "https://console.neon.tech/app/settings/api-keys",
    specUrl: "https://neon.tech/api_spec/release/v2.json",
  }),
  apiKeyOpenApiPreset({
    description: "Models, responses, files, vector stores, and fine-tuning through the OpenAI API.",
    healthCheck: { operationId: "listModels" },
    id: "openai-rest",
    inputs: [secretInput("API key")],
    name: "OpenAI API",
    placements: bearerApiKey,
    provider: "openai",
    setupUrl: "https://platform.openai.com/api-keys",
    specUrl: "https://app.stainless.com/api/spec/documented/openai/openapi.documented.yml",
  }),
  apiKeyOpenApiPreset({
    description: "Issues, projects, releases, events, and performance data through Sentry REST.",
    healthCheck: { operationId: "listOrganizations" },
    id: "sentry-rest",
    inputs: [secretInput("Auth token")],
    name: "Sentry REST",
    placements: bearerApiKey,
    provider: "sentry",
    setupUrl: "https://sentry.io/settings/account/api/auth-tokens/",
    specUrl:
      "https://raw.githubusercontent.com/getsentry/sentry-api-schema/main/openapi-derefed.json",
  }),
  apiKeyOpenApiPreset({
    description:
      "Events, feature flags, insights, dashboards, and project analytics through PostHog REST.",
    healthCheck: { method: "get", path: "/api/organizations/" },
    id: "posthog-rest",
    inputs: [secretInput("Personal API key")],
    name: "PostHog REST",
    placements: bearerApiKey,
    provider: "posthog",
    setupUrl: "https://app.posthog.com/settings/user-api-keys",
    specUrl: "https://us.posthog.com/api/schema/",
  }),
  apiKeyOpenApiPreset({
    baseUrl: "https://api.exa.ai",
    description: "Web search, similar pages, content retrieval, and answers through Exa.",
    healthCheck: { args: { numResults: 1, query: "Opensteer" }, operationId: "search" },
    id: "exa-rest",
    inputs: [secretInput("API key")],
    name: "Exa Search",
    placements: [{ carrier: "header", name: "x-api-key", variable: "apiKey" }],
    provider: "exa",
    setupUrl: "https://dashboard.exa.ai/api-keys",
    specUrl:
      "https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-openapi-spec.yaml",
  }),
  apiKeyOpenApiPreset({
    description: "Websets, searches, enrichments, monitors, and webhooks through Exa.",
    healthCheck: { operationId: "websets-list" },
    id: "exa-websets-rest",
    inputs: [secretInput("API key")],
    name: "Exa Websets",
    placements: [{ carrier: "header", name: "x-api-key", variable: "apiKey" }],
    provider: "exa",
    setupUrl: "https://dashboard.exa.ai/api-keys",
    specUrl:
      "https://raw.githubusercontent.com/exa-labs/openapi-spec/refs/heads/master/exa-websets-spec.yaml",
  }),
  apiKeyOpenApiPreset({
    description: "Tasks, projects, teams, portfolios, and workspace management through Asana REST.",
    healthCheck: { args: { user_gid: "me" }, operationId: "getUser" },
    id: "asana-rest",
    inputs: [secretInput("Personal access token")],
    name: "Asana REST",
    placements: bearerApiKey,
    provider: "asana",
    setupUrl: "https://app.asana.com/0/my-apps",
    specUrl:
      "https://raw.githubusercontent.com/APIs-guru/openapi-directory/main/APIs/asana.com/1.0/openapi.yaml",
  }),
  apiKeyOpenApiPreset({
    description: "SMS, voice, calls, recordings, and account resources through Twilio REST.",
    healthCheck: { operationId: "ListAccount" },
    id: "twilio-rest",
    inputs: [secretInput("Account SID", "accountSid"), secretInput("Auth token", "authToken")],
    name: "Twilio REST",
    placements: [
      {
        carrier: "header",
        encoding: "base64",
        name: "Authorization",
        prefix: "Basic ",
        separator: ":",
        variables: ["accountSid", "authToken"],
      },
    ],
    provider: "twilio",
    setupUrl: "https://console.twilio.com/",
    specUrl:
      "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json",
  }),
  apiKeyOpenApiPreset({
    description:
      "Droplets, Kubernetes, databases, networking, registries, and App Platform through DigitalOcean.",
    healthCheck: {
      displayNamePath: "account.email",
      identityPath: "account.uuid",
      operationId: "account_get",
    },
    id: "digitalocean-rest",
    inputs: [secretInput("Personal access token")],
    name: "DigitalOcean REST",
    placements: bearerApiKey,
    provider: "digitalocean",
    setupUrl: "https://cloud.digitalocean.com/account/api/tokens",
    specUrl:
      "https://api-engineering.nyc3.cdn.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml",
  }),
  apiKeyOpenApiPreset({
    description: "Vals, runs, blobs, and email or web endpoints through the Val Town API.",
    healthCheck: { operationId: "meGet" },
    id: "val-town-rest",
    inputs: [secretInput("API token")],
    name: "Val Town REST",
    placements: bearerApiKey,
    provider: "val-town",
    setupUrl: "https://www.val.town/settings/api",
    specUrl: "https://api.val.town/openapi.json",
  }),
  apiKeyOpenApiPreset({
    description: "Scrape, crawl, search, map, and extract web content through Firecrawl v2.",
    healthCheck: { args: { url: "https://example.com" }, operationId: "scrapeAndExtractFromUrl" },
    id: "firecrawl-rest",
    inputs: [secretInput("API key")],
    name: "Firecrawl API",
    placements: bearerApiKey,
    provider: "firecrawl",
    setupUrl: "https://www.firecrawl.dev/app/api-keys",
    specUrl:
      "https://raw.githubusercontent.com/firecrawl/firecrawl-docs/main/v1/api-reference/v2-openapi.json",
  }),
];

const spotifyCapabilities = {
  "spotify.library": {
    scopes: [
      "playlist-read-private",
      "playlist-modify-private",
      "playlist-modify-public",
      "user-library-read",
      "user-library-modify",
      "user-read-email",
      "user-read-private",
    ],
  },
} as const;

const spotify = IntegrationDefinitionSchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "oauth",
      kind: "oauth",
      label: "Connect Spotify",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "accessToken" },
      ],
      oauth: {
        authorizationUrl: "https://accounts.spotify.com/authorize",
        clientAuth: "basic",
        identity: {
          accountIdentifierPath: "email",
          displayNamePath: "display_name",
          identityPath: "id",
          source: "userinfo",
          userinfoUrl: "https://api.spotify.com/v1/me",
        },
        scopeSeparator: " ",
        scopes: spotifyCapabilities["spotify.library"].scopes,
        tokenUrl: "https://accounts.spotify.com/api/token",
        usesPkce: true,
      },
    },
  ],
  config: {
    healthCheck: {
      accountIdentifierPath: "email",
      displayNamePath: "display_name",
      identityPath: "id",
      operationId: "get-current-users-profile",
    },
    specUrl:
      "https://raw.githubusercontent.com/sonallux/spotify-web-api/refs/heads/main/official-spotify-open-api.yml",
  },
  description: "Tracks, albums, playlists, saved library content, and playback through Spotify.",
  id: "spotify-rest",
  name: "Spotify Web API",
  provider: "spotify",
  setupUrl: "https://developer.spotify.com/dashboard",
});

export const openApiPresetIntegrations: readonly IntegrationDefinition[] = [...presets, spotify];
