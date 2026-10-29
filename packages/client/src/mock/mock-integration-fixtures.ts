import { RunnerIdSchema, type UserId } from "@opensteer/core";
import {
  IntegrationDefinitionSummarySchema,
  IntegrationInstallManifestSummarySchema,
  bearerAccessTokenPlacement,
  createIntegrationId,
  integrationApplicationSourceUnavailableDetail,
  integrationCredentialRejectedDetail,
  type IntegrationCatalogEntry,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationDefinitionSummary,
  type IntegrationGrant,
  type IntegrationOAuthApplicationSource,
  type IntegrationPlatformDashboard,
  type IntegrationProviderApplication,
  type IntegrationProviderAuthorization,
  type IntegrationProviderManifest,
  type IntegrationServerId,
} from "@opensteer/integration-core";

const mockIntegrationBrokerIssuer = "https://accounts.opensteer.example";
const mockIntegrationCallbackOrigin = "https://opensteer.example.test";
export const mockHostedOAuthDisclosure =
  "Opensteer's hosted OAuth service briefly processes authorization credentials to connect and refresh this account. The credentials are stored by this Opensteer, and integration data goes directly between this Opensteer and the provider. Use your own OAuth app to remove that hosted dependency.";

type MockInstallationEntry = IntegrationPlatformDashboard["installations"][number];
type MockMcpConnection = IntegrationPlatformDashboard["connections"][number];

export interface MockIntegrationAttempt {
  readonly definitionId: string;
  readonly provider: string;
  readonly source?: IntegrationOAuthApplicationSource;
}

interface MockIntegrationState {
  applications: IntegrationProviderApplication[];
  callbackUrls: Record<string, string>;
  catalog: IntegrationCatalogEntry[];
  connections: IntegrationConnectionSummary[];
  grants: IntegrationGrant[];
  installations: MockInstallationEntry[];
  mcpConnections: MockMcpConnection[];
  providerAuthorizations: Record<string, IntegrationProviderAuthorization>;
  providers: IntegrationProviderManifest[];
}

interface MockToolSeed {
  readonly description: string;
  readonly name: string;
  readonly title: string;
}

interface MockSkillSeed {
  readonly description: string;
  readonly name: string;
}

export function mockIntegrationDigest(seed: string): string {
  return `${seed}${"-0".repeat(43)}`.replaceAll(/[^A-Za-z0-9_-]/g, "-").slice(0, 43);
}

export function mockIntegrationCallbackUrl(provider: string): string {
  return `${mockIntegrationCallbackOrigin}/v1/integrations/oauth/callback/${provider}`;
}

/** The Mac this preview's deployment runs on, which is where Messages is on. */
export const mockMessagesRunnerId = RunnerIdSchema.parse(
  "rnr_11111111-1111-4111-8111-111111111111",
);

/**
 * A second Mac that has Messages on and is away, so the preview carries the
 * third thing an app row can be: a connection that stands, on a computer that
 * cannot act on a change until it is back.
 */
export const mockMessagesAwayRunnerId = RunnerIdSchema.parse(
  "rnr_44444444-4444-4444-8444-444444444444",
);

const mockGithubDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "github-app",
      kind: "oauth",
      label: "Authorize GitHub App",
      placements: [bearerAccessTokenPlacement],
      oauth: {
        authorizationUrl: "https://github.com/login/oauth/authorize",
        clientAuth: "body",
        identity: {
          displayNamePath: "login",
          identityPath: "id",
          source: "userinfo",
          userinfoUrl: "https://api.github.com/user",
        },
        scopeSeparator: " ",
        scopes: ["read:user", "repo"],
        tokenUrl: "https://github.com/login/oauth/access_token",
        usesPkce: true,
      },
    },
  ],
  description: "Work with repositories, issues, pull requests, and the signed-in GitHub identity.",
  hostedOAuth: {
    providerApplicationRevision: 3,
    qualification: { authorizationCodeExchange: true, refresh: true },
  },
  id: "github",
  name: "GitHub REST",
  provider: "github",
  setupUrl: "https://github.com/settings/apps/new",
});

const mockLinearDefinition = IntegrationDefinitionSummarySchema.parse({
  apiKey: { destinations: ["https://api.linear.app"], check: true },
  adapter: "graphql",
  authMethods: [
    {
      id: "api-key",
      kind: "api-key",
      label: "Linear personal API key",
      inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
      placements: [{ carrier: "header", name: "Authorization", variable: "apiKey" }],
    },
  ],
  description: "Read and update Linear issues, projects, teams, and comments.",
  id: "linear",
  name: "Linear GraphQL",
  provider: "linear",
  setupUrl: "https://linear.app/settings/api",
});

const mockNotionDefinition = IntegrationDefinitionSummarySchema.parse({
  apiKey: { destinations: ["https://api.notion.com"], check: true },
  adapter: "openapi",
  authMethods: [
    {
      id: "notion-oauth",
      kind: "oauth",
      label: "Authorize Notion",
      placements: [bearerAccessTokenPlacement],
      oauth: {
        authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
        clientAuth: "basic",
        identity: {
          displayNamePath: "name",
          identityPath: "id",
          source: "userinfo",
          userinfoUrl: "https://api.notion.com/v1/users/me",
        },
        scopeSeparator: " ",
        scopes: [],
        tokenUrl: "https://api.notion.com/v1/oauth/token",
        usesPkce: true,
      },
    },
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
  description: "Search, read, create, and update Notion pages with one authorized workspace.",
  id: "notion",
  name: "Notion",
  provider: "notion",
  setupUrl: "https://www.notion.so/my-integrations",
});

/**
 * Notion as the catalog projects it: the catalog never loads the document, so
 * only the installed snapshot can disclose which hosts receive a key.
 */
const mockNotionCatalogDefinition = IntegrationDefinitionSummarySchema.parse({
  ...mockNotionDefinition,
  apiKey: null,
});

const mockSlackDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "oauth",
      kind: "oauth",
      label: "Install Slack app",
      placements: [bearerAccessTokenPlacement],
      oauth: {
        authorizationUrl: "https://slack.com/oauth/v2/authorize",
        clientAuth: "body",
        identity: {
          displayNamePath: "team.name",
          identityPath: "bot_user_id",
          source: "token-response",
          tenantPath: "team.id",
        },
        scopeSeparator: ",",
        scopes: ["channels:history", "chat:write", "users:read"],
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        usesPkce: false,
      },
    },
  ],
  description: "Read conversations and post messages in Slack workspaces.",
  id: "slack",
  name: "Slack",
  provider: "slack",
  setupUrl: "https://api.slack.com/apps",
});

const mockResendDefinition = IntegrationDefinitionSummarySchema.parse({
  apiKey: { destinations: ["https://api.resend.com"], check: true },
  adapter: "openapi",
  authMethods: [
    {
      id: "api-key",
      kind: "api-key",
      label: "Resend API key",
      inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
      ],
    },
  ],
  description: "Send transactional email and inspect sending domains through Resend.",
  id: "resend",
  name: "Resend REST",
  provider: "resend",
  setupUrl: "https://resend.com/api-keys",
});

/** Resend as the catalog projects it, before installing resolves its document. */
const mockResendCatalogDefinition = IntegrationDefinitionSummarySchema.parse({
  ...mockResendDefinition,
  apiKey: null,
});

/**
 * The one app on a computer this preview ships. It carries the public
 * projection a computer definition's `config` produces, so the picker, the
 * access control and the Apps block read the words the catalog actually
 * declares rather than words the UI invented.
 */
export const mockMessagesDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "computer",
  authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
  computerApp: {
    accessLabels: { read: "Read only", readWrite: "Read and send" },
    accessLevels: ["read", "read-write"],
    operations: [
      { name: "list_conversations", effect: "read" },
      { name: "read_messages", effect: "read" },
      { name: "send_message", effect: "write" },
    ],
    accessSummaries: {
      read: "Allows searching and reading conversations. Sending is off.",
      readWrite:
        "Allows searching and reading conversations, and sending messages as you. Sending may ask for macOS Automation permission on this Mac.",
    },
    platforms: ["darwin"],
  },
  description: "Search, read, and send Apple Messages through an enrolled Mac.",
  id: "apple-messages",
  name: "Apple Messages",
  provider: "apple-messages",
});

/** Apple data apps a Mac or an iPhone can share. */
const mockAppleDataDefinitions: readonly IntegrationDefinitionSummary[] = [
  { id: "apple-contacts", name: "Contacts", reads: ["search_contacts"], writes: [] },
  {
    id: "apple-calendar",
    name: "Calendar",
    reads: ["list_calendars", "list_events"],
    writes: ["create_event", "update_event", "delete_event"],
  },
  {
    id: "apple-reminders",
    name: "Reminders",
    reads: ["list_reminder_lists", "list_reminders"],
    writes: ["create_reminder", "update_reminder", "delete_reminder"],
  },
].map(({ id, name, reads, writes }) =>
  IntegrationDefinitionSummarySchema.parse({
    adapter: "computer",
    id,
    name,
    provider: id,
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    description: `Use ${name} on an enrolled Mac or iPhone. On an iPhone, Opensteer must be open.`,
    computerApp: {
      accessLabels: { read: "Can read", readWrite: "Can read and change" },
      accessSummaries: { read: `Read ${name}.`, readWrite: `Read and change ${name}.` },
      accessLevels: writes.length ? ["read", "read-write"] : ["read"],
      platforms: ["darwin", "ios"],
      operations: [
        ...reads.map((name) => ({ name, effect: "read" })),
        ...writes.map((name) => ({ name, effect: "write" })),
      ],
    },
  }),
);

/** iPhone-only and read-only, in the catalog's own words. */
const mockIphoneOnlyDefinitions: readonly IntegrationDefinitionSummary[] = [
  {
    id: "iphone-location",
    name: "Location",
    description:
      "Get this iPhone's current location while Opensteer is open, with the accuracy iPhone Settings allows. No location history or background tracking.",
    label: "Can read",
    read: "Allows reading a current location and its accuracy while Opensteer is open on this iPhone. No background tracking or location history.",
    reads: ["current_location"],
  },
  {
    id: "iphone-photos",
    name: "Photos",
    description:
      "Read metadata for photos, videos and user albums visible to Opensteer on this iPhone. Photo contents, location, hidden assets and shared albums are not returned.",
    label: "Can read metadata",
    read: "Allows reading dates, dimensions, media types, favorites and user album names for the photos iPhone Settings permits. Photos cannot be viewed, changed or deleted; photo locations are not shared.",
    reads: ["list_assets", "list_albums"],
  },
].map(({ description, id, label, name, read, reads }) =>
  IntegrationDefinitionSummarySchema.parse({
    adapter: "computer",
    id,
    name,
    provider: id,
    authMethods: [{ id: "computer", kind: "computer", label: "This iPhone" }],
    description,
    computerApp: {
      accessLabels: { read: label, readWrite: label },
      accessSummaries: { read, readWrite: read },
      accessLevels: ["read"],
      platforms: ["ios"],
      operations: reads.map((name) => ({ name, effect: "read" })),
    },
  }),
);

/** Data apps the scripted iPhone bridge reports; these are presentation fixtures. */
export const mockIphoneAppDefinitions: readonly IntegrationDefinitionSummary[] = [
  ...mockAppleDataDefinitions,
  ...mockIphoneOnlyDefinitions,
];

/**
 * Computer use, the one computer app whose connections name an app: each app
 * a person approves on a Mac is its own connection of this one definition.
 * The words are the catalog's own.
 */
export const mockComputerUseDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "computer",
  authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
  computerApp: {
    accessLabels: { read: "Can see", readWrite: "Can see and control" },
    accessLevels: ["read", "read-write"],
    accessSummaries: {
      read: "Allows observing the app: its accessibility tree and a screenshot, opening it in the background if needed.",
      readWrite:
        "Allows observing the app, and clicking, typing, scrolling, pressing keys and setting values in it, all in the background.",
    },
    kind: "gui",
    operations: [
      { effect: "read", name: "observe" },
      { effect: "write", name: "act" },
    ],
    platforms: ["darwin"],
  },
  description: "See and operate apps on a Mac in the background while the person keeps using it.",
  id: "macos-app",
  name: "Computer use",
  provider: "macos-app",
});

/**
 * An Android phone's whole screen, the `display` computer app: its one
 * connection names no app, because a session holds the entire phone. The words
 * are the catalog's own.
 */
export const mockAgentPhoneDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "computer",
  authMethods: [{ id: "computer", kind: "computer", label: "This phone" }],
  computerApp: {
    accessLabels: { read: "Can see", readWrite: "Can see and control" },
    accessLevels: ["read", "read-write"],
    accessSummaries: {
      read: "Allows seeing the phone's screen: its accessibility tree and a screenshot. Never turns the screen on.",
      readWrite:
        "Allows seeing the phone's screen and operating it like a person: tapping, swiping, typing, pressing back and home, opening apps and turning the screen on.",
    },
    kind: "display",
    operations: [
      { effect: "read", name: "observe" },
      { effect: "write", name: "act" },
      { effect: "read", name: "release" },
    ],
    platforms: ["android"],
  },
  description: "See and operate the whole screen of an Android phone dedicated to agents.",
  id: "android-phone",
  name: "Android phone",
  provider: "android-phone",
});

/** The preview's agent phone, set up over USB and approved on its own screen. */
export const mockAgentPhoneRunnerId = RunnerIdSchema.parse(
  "rnr_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
);

/** The apps the preview's Mac has approved, blocked, or is using right now. */
export const mockComputerUseApps = {
  calendar: { bundleId: "com.apple.iCal", displayName: "Calendar", teamId: null },
  notes: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
  numbers: { bundleId: "com.apple.iWork.Numbers", displayName: "Numbers", teamId: null },
  safari: { bundleId: "com.apple.Safari", displayName: "Safari", teamId: null },
} as const;

/**
 * An integration an agent proposed and an administrator installed. Its name is
 * text the agent researched, so nothing vouches for it. Its first key was
 * rejected, and a reconnect made before keys could repair a connection in place
 * left a second account of the same name the same morning.
 */
const mockVapiDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "openapi",
  // The Host's own facts about the key, apart from the agent's guidance below.
  apiKey: { check: true, destinations: ["https://api.vapi.ai"] },
  authMethods: [
    {
      id: "api-key",
      kind: "api-key",
      label: "API key",
      inputs: [
        {
          description: "Use the private key from the Vapi dashboard, not the public one.",
          label: "API key",
          secret: true,
          variable: "apiKey",
        },
      ],
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
      ],
    },
  ],
  description: "Assistants, calls and phone numbers through the Vapi REST API.",
  id: "vapi-api",
  name: "Vapi API",
  provider: "vapi",
  setupUrl: "https://dashboard.vapi.ai/org/api-keys",
});
/** The GitHub account waiting for repositories whose token GitHub has revoked. */
export const mockGitHubRevoked = {
  connectionId: "con_00000000-0000-4000-8000-0000000000e1" as IntegrationConnectionId,
} as const;

/** The seeded accounts, and the task whose request names the rejected one. */
export const mockVapi = {
  connectionId: "con_00000000-0000-4000-8000-0000000000f1" as IntegrationConnectionId,
  installationId: "iin_00000000-0000-4000-8000-0000000000f1",
  requestId: "req_00000000-0000-4000-8000-0000000000f1",
  serverId: "isv_00000000-0000-4000-8000-0000000000f1" as IntegrationServerId,
  threadId: "thr_00000000-0000-4000-8000-000000000008",
  twinConnectionId: "con_00000000-0000-4000-8000-0000000000f2" as IntegrationConnectionId,
} as const;

function mockVapiInstallation(installedBy: UserId): MockInstallationEntry {
  const createdAt = "2026-08-09T08:55:00.000Z";
  return {
    installation: {
      createdAt,
      description: mockVapiDefinition.description,
      id: mockVapi.installationId as MockInstallationEntry["installation"]["id"],
      manifest: { definition: mockVapiDefinition, kind: "proposal" },
      name: mockVapiDefinition.id,
      provenance: {
        artifactDigest: mockIntegrationDigest("vapi-proposal"),
        installedBy,
        proposalKind: "openapi",
      },
      revision: 1,
      sourceKind: "proposed",
      status: "active",
      title: mockVapiDefinition.name,
      trust: "administrator-approved",
      updatedAt: createdAt,
      version: null,
    },
    servers: [
      {
        connectionRequirement: {
          definitionId: mockVapiDefinition.id,
          kind: "provider",
          provider: mockVapiDefinition.provider,
          providerApplicationRequired: false,
        },
        id: mockVapi.serverId,
        installationId: mockVapi.installationId as MockInstallationEntry["installation"]["id"],
        name: mockVapiDefinition.id,
        status: "active",
        statusDetail: null,
        toolGeneration: 1,
        transportType: "adapter",
        updatedAt: createdAt,
      },
    ],
    skills: [],
    tools: [
      {
        annotations: { readOnlyHint: true },
        connectionId: null,
        description: "List the assistants on this Vapi account.",
        id: createIntegrationId("tool"),
        name: "list_assistants",
        schemaDigest: mockIntegrationDigest("vapi-tool-list_assistants"),
        serverId: mockVapi.serverId,
        status: "active",
        title: "List assistants",
      },
    ],
  };
}

function mockVapiConnection(input: {
  readonly createdAt: string;
  readonly id: IntegrationConnectionId;
  readonly rejected: boolean;
}): IntegrationConnectionSummary {
  return {
    accountIdentifier: null,
    applicationSource: { kind: "api-key" },
    authMethodId: "api-key",
    authorizationDigest: mockIntegrationDigest("vapi-authorization"),
    computer: null,
    connectionMethod: "api-key",
    createdAt: input.createdAt,
    definitionId: mockVapiDefinition.id,
    displayName: mockVapiDefinition.name,
    externalIdentityId: null,
    externalTenantId: null,
    grantedScopes: [],
    id: input.id,
    provider: mockVapiDefinition.provider,
    providerApplicationId: null,
    // The Host's own words when a service rejects a saved key.
    status: input.rejected ? "needs-attention" : "connected",
    statusDetail: input.rejected
      ? integrationCredentialRejectedDetail(mockVapiDefinition.name, "key")
      : null,
    statusReason: null,
    updatedAt: input.rejected ? "2026-08-09T09:31:00.000Z" : input.createdAt,
  };
}

/**
 * The key every checked service in the mock turns away, as a live service turns
 * away a wrong one: nothing is saved, and the Host says so in its own words.
 */
export const mockRejectedApiKey = "rejected-key";

/**
 * An agent's proposal waiting for review, as a live test met TMDB: an OpenAPI
 * document whose own title is "tmdb-api", named and described by the agent for
 * the service people know, with a key the Host checks before saving. The mock
 * installs exactly this proposal, as the Host would.
 */
const mockTmdbOrigin = "https://api.themoviedb.org";
const mockTmdbDigest = mockIntegrationDigest("tmdb-proposal");
const mockTmdbDescription = "Movie and TV show details, search and ratings.";
const mockTmdbCredential = {
  description:
    "In your TMDB account, open Settings → API and copy the API Read Access Token, not the shorter v3 API Key.",
  label: "TMDB API Read Access Token",
  setupUrl: "https://www.themoviedb.org/settings/api",
} as const;
export const mockTmdbProposal = {
  digest: mockTmdbDigest,
  installationId: "iin_00000000-0000-4000-8000-0000000000f9",
  manifest: IntegrationInstallManifestSummarySchema.parse({
    kind: "proposal",
    proposal: {
      apiKey: { check: true, destinations: [mockTmdbOrigin] },
      authMethods: ["api-key"],
      check: { operationId: "authentication-validate-key" },
      credential: mockTmdbCredential,
      description: mockTmdbDescription,
      digest: mockTmdbDigest,
      kind: "openapi",
      name: "TMDB",
      preview: {
        authSchemes: ["api-key"],
        operationCount: 152,
        servers: [mockTmdbOrigin],
        tags: ["Movies", "TV", "Search"],
        title: "tmdb-api",
      },
      source: { origin: "https://developer.themoviedb.org", type: "url" },
    },
  }),
  requestId: "req_00000000-0000-4000-8000-0000000000f9",
  serverId: "isv_00000000-0000-4000-8000-0000000000f9" as IntegrationServerId,
  threadId: "thr_00000000-0000-4000-8000-000000000009",
} as const;

const mockTmdbDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "openapi",
  apiKey: { check: true, destinations: [mockTmdbOrigin] },
  authMethods: [
    {
      id: "api-key",
      inputs: [
        {
          description: mockTmdbCredential.description,
          label: mockTmdbCredential.label,
          secret: true,
          variable: "apiKey",
        },
      ],
      kind: "api-key",
      label: mockTmdbCredential.label,
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
      ],
    },
  ],
  description: mockTmdbDescription,
  id: "proposed-tmdb",
  name: "TMDB",
  provider: "proposed-tmdb",
  setupUrl: mockTmdbCredential.setupUrl,
});

/** What installing the TMDB proposal produces; the mock adds it on approval only. */
export function mockTmdbInstallation(installedBy: UserId): MockInstallationEntry {
  const createdAt = "2026-08-09T10:06:00.000Z";
  const installationId =
    mockTmdbProposal.installationId as MockInstallationEntry["installation"]["id"];
  // Named as the Host plans TMDB's operations, which carry no title of their own.
  const tool = (name: string, description: string, readOnly: boolean) => ({
    annotations: readOnly ? { readOnlyHint: true } : { readOnlyHint: false },
    connectionId: null,
    description,
    id: createIntegrationId("tool"),
    name,
    schemaDigest: mockIntegrationDigest(`tmdb-tool-${name}`),
    serverId: mockTmdbProposal.serverId,
    status: "active" as const,
    title: name,
  });
  return {
    installation: {
      createdAt,
      description: mockTmdbDefinition.description,
      id: installationId,
      manifest: { definition: mockTmdbDefinition, kind: "proposal" },
      name: mockTmdbDefinition.id,
      provenance: {
        artifactDigest: mockTmdbDigest,
        installedBy,
        proposalKind: "openapi",
      },
      revision: 1,
      sourceKind: "proposed",
      status: "active",
      title: mockTmdbDefinition.name,
      trust: "administrator-approved",
      updatedAt: createdAt,
      version: mockTmdbDigest,
    },
    servers: [
      {
        connectionRequirement: {
          definitionId: mockTmdbDefinition.id,
          kind: "provider",
          provider: mockTmdbDefinition.provider,
          providerApplicationRequired: false,
        },
        id: mockTmdbProposal.serverId,
        installationId,
        name: "default",
        status: "active",
        statusDetail: null,
        toolGeneration: 1,
        transportType: "adapter",
        updatedAt: createdAt,
      },
    ],
    skills: [],
    tools: [
      tool("search.searchMovie", "Search for movies by title.", true),
      tool("search.searchTv", "Search for TV shows by name.", true),
      tool("movie.movieDetails", "Read one movie's details.", true),
      tool("account.accountAddFavorite", "Mark a movie or show as a favorite.", false),
    ],
  };
}

/**
 * An MCP server an agent proposed and an administrator installed, named by its
 * host as the Host names every MCP proposal. It signs in with the server's own
 * OAuth, so its one account is held by the installation, not the definition.
 */
const mockMcpProposalDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "mcp",
  authMethods: [{ id: "mcp-oauth", kind: "mcp-oauth", label: "MCP OAuth" }],
  description: "Boards, lists and cards for planning a team’s work.",
  id: "proposed-7c0f3a9d2b1e4f60",
  name: "mcp.trellis.example",
  provider: "proposed-7c0f3a9d2b1e4f60",
});
export const mockMcpProposal = {
  connectionId: "con_00000000-0000-4000-8000-0000000000f3" as IntegrationConnectionId,
  installationId: "iin_00000000-0000-4000-8000-0000000000f3",
  serverId: "isv_00000000-0000-4000-8000-0000000000f3" as IntegrationServerId,
} as const;

function mockMcpProposalInstallation(installedBy: UserId): MockInstallationEntry {
  const createdAt = "2026-08-12T10:00:00.000Z";
  const installationId =
    mockMcpProposal.installationId as MockInstallationEntry["installation"]["id"];
  return {
    installation: {
      createdAt,
      description: mockMcpProposalDefinition.description,
      id: installationId,
      manifest: { definition: mockMcpProposalDefinition, kind: "proposal" },
      name: mockMcpProposalDefinition.id,
      provenance: {
        artifactDigest: mockIntegrationDigest("trellis-proposal"),
        installedBy,
        proposalKind: "mcp",
      },
      revision: 1,
      sourceKind: "proposed",
      status: "active",
      title: mockMcpProposalDefinition.name,
      trust: "administrator-approved",
      updatedAt: createdAt,
      version: null,
    },
    servers: [
      {
        connectionRequirement: { kind: "mcp-oauth" },
        id: mockMcpProposal.serverId,
        installationId,
        name: "default",
        status: "active",
        statusDetail: null,
        toolGeneration: 1,
        transportType: "streamable-http",
        updatedAt: createdAt,
      },
    ],
    skills: [],
    tools: [
      {
        annotations: { readOnlyHint: true },
        connectionId: mockMcpProposal.connectionId,
        description: "List the boards this Trellis account can see.",
        id: createIntegrationId("tool"),
        name: "list_boards",
        schemaDigest: mockIntegrationDigest("trellis-tool-list_boards"),
        serverId: mockMcpProposal.serverId,
        status: "active",
        title: "List boards",
      },
    ],
  };
}

/**
 * A Google preset whose authorization changed after both accounts connected,
 * so the Host marked each for reconnecting. The mock provider signs in as
 * alex@example.com, so reconnecting repairs that account in place.
 */
const mockGoogleCalendarDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "google-oauth",
      kind: "oauth",
      label: "Sign in with Google",
      placements: [bearerAccessTokenPlacement],
      oauth: {
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        clientAuth: "body",
        identity: {
          accountIdentifierPath: "email",
          displayNamePath: "name",
          identityPath: "sub",
          source: "userinfo",
          userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
        },
        scopeSeparator: " ",
        scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar"],
        tokenUrl: "https://oauth2.googleapis.com/token",
        usesPkce: true,
      },
    },
  ],
  description: "Read and manage Google Calendar.",
  hostedOAuth: {
    providerApplicationRevision: 1,
    qualification: { authorizationCodeExchange: true, refresh: true },
  },
  id: "google-calendar",
  name: "Google Calendar",
  provider: "google",
  setupUrl: "https://console.cloud.google.com/apis/credentials",
});

/** The Host's own words when a definition's authorization changed under an account. */
const mockAuthorizationChangedDetail =
  "Opensteer changed how this service connects. Reconnect this account to keep using it.";

function mockGoogleCalendarConnection(input: {
  readonly accountIdentifier: string;
  readonly createdAt: string;
  readonly externalIdentityId: string;
  readonly source: IntegrationOAuthApplicationSource;
}): IntegrationConnectionSummary {
  return {
    accountIdentifier: input.accountIdentifier,
    applicationSource: input.source,
    authMethodId: "google-oauth",
    authorizationDigest: mockIntegrationDigest("google-calendar-authorization-previous"),
    computer: null,
    connectionMethod: "managed-oauth",
    createdAt: input.createdAt,
    definitionId: mockGoogleCalendarDefinition.id,
    displayName: "Alex",
    externalIdentityId: input.externalIdentityId,
    externalTenantId: null,
    grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/calendar"],
    id: createIntegrationId("connection"),
    provider: "google",
    providerApplicationId: null,
    status: "needs-attention",
    statusDetail: mockAuthorizationChangedDetail,
    statusReason: null,
    updatedAt: "2026-10-02T08:00:00.000Z",
  };
}

/**
 * An OpenAPI proposal that signs in only with OAuth, installed before the Host
 * refused such proposals. It can never work, so its reason names the way out.
 */
const mockGmailProposalDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "oauth",
      kind: "oauth",
      label: "Sign in with Google",
      placements: [bearerAccessTokenPlacement],
      oauth: {
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        clientAuth: "body",
        identity: { identityPath: "sub", source: "token-response" },
        scopeSeparator: " ",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        tokenUrl: "https://oauth2.googleapis.com/token",
        usesPkce: true,
      },
    },
  ],
  description: "Read, search and send Gmail messages.",
  id: "proposed-3b8e51c07a9d4f12",
  name: "Gmail API",
  provider: "proposed-3b8e51c07a9d4f12",
});
export const mockGmailProposal = {
  installationId: "iin_00000000-0000-4000-8000-0000000000f4",
  reason:
    "Opensteer can’t set up this service’s sign-in from an agent’s proposal. Add the service from Add a service if it’s listed there, then uninstall this one.",
} as const;

function mockGmailProposalInstallation(installedBy: UserId): MockInstallationEntry {
  const createdAt = "2026-10-14T16:20:00.000Z";
  const installationId =
    mockGmailProposal.installationId as MockInstallationEntry["installation"]["id"];
  return {
    installation: {
      createdAt,
      description: mockGmailProposalDefinition.description,
      id: installationId,
      manifest: { definition: mockGmailProposalDefinition, kind: "proposal" },
      name: mockGmailProposalDefinition.id,
      provenance: {
        artifactDigest: mockIntegrationDigest("gmail-proposal"),
        installedBy,
        proposalKind: "openapi",
      },
      revision: 1,
      sourceKind: "proposed",
      status: "needs-attention",
      title: mockGmailProposalDefinition.name,
      trust: "administrator-approved",
      updatedAt: createdAt,
      version: null,
    },
    servers: [
      {
        connectionRequirement: {
          definitionId: mockGmailProposalDefinition.id,
          kind: "provider",
          provider: mockGmailProposalDefinition.provider,
          providerApplicationRequired: false,
        },
        id: createIntegrationId("server"),
        installationId,
        name: mockGmailProposalDefinition.id,
        status: "needs-attention",
        statusDetail: mockGmailProposal.reason,
        toolGeneration: 1,
        transportType: "adapter",
        updatedAt: createdAt,
      },
    ],
    skills: [],
    tools: [],
  };
}

/**
 * A preset Opensteer retired: a migration turned its installation off and
 * recorded why on its server, and the catalog no longer offers it.
 */
const mockSlackMcpDefinition = IntegrationDefinitionSummarySchema.parse({
  adapter: "mcp",
  authMethods: [{ id: "mcp-oauth", kind: "mcp-oauth", label: "Slack MCP OAuth" }],
  description:
    "Search messages, read canvases, and post Slack updates through Slack's managed MCP server.",
  id: "slack-mcp",
  name: "Slack MCP",
  provider: "slack-mcp",
});
export const mockSlackMcp = {
  installationId: "iin_00000000-0000-4000-8000-0000000000f5",
  reason: "Opensteer no longer supports Slack MCP. Uninstall it and use Slack instead.",
} as const;

function mockSlackMcpInstallation(installedBy: UserId): MockInstallationEntry {
  const createdAt = "2026-08-20T12:00:00.000Z";
  const installationId = mockSlackMcp.installationId as MockInstallationEntry["installation"]["id"];
  return {
    installation: {
      createdAt,
      description: mockSlackMcpDefinition.description,
      id: installationId,
      manifest: {
        definition: mockSlackMcpDefinition,
        digest: mockIntegrationDigest("slack-mcp-catalog"),
        kind: "catalog",
      },
      name: mockSlackMcpDefinition.id,
      provenance: {
        definitionId: mockSlackMcpDefinition.id,
        installedBy,
        source: "catalog",
      },
      revision: 2,
      sourceKind: "built-in",
      status: "disabled",
      title: mockSlackMcpDefinition.name,
      trust: "built-in",
      updatedAt: "2026-10-10T09:00:00.000Z",
      version: null,
    },
    servers: [
      {
        connectionRequirement: { kind: "mcp-oauth" },
        id: createIntegrationId("server"),
        installationId,
        name: "default",
        status: "active",
        statusDetail: mockSlackMcp.reason,
        toolGeneration: 1,
        transportType: "streamable-http",
        updatedAt: createdAt,
      },
    ],
    skills: [],
    tools: [],
  };
}

export const mockIntegrationDefinitions: readonly IntegrationDefinitionSummary[] = [
  mockGithubDefinition,
  mockGoogleCalendarDefinition,
  mockLinearDefinition,
  mockMessagesDefinition,
  ...mockIphoneAppDefinitions,
  mockComputerUseDefinition,
  mockAgentPhoneDefinition,
  mockNotionDefinition,
  mockSlackDefinition,
  mockResendDefinition,
  mockVapiDefinition,
  mockTmdbDefinition,
];

/** The operations the preview materialises per connection, by effect. */
const mockMessagesOperations: readonly (MockToolSeed & { readonly effect: "read" | "write" })[] = [
  {
    description: "List recent Messages conversations.",
    effect: "read",
    name: "list_conversations",
    title: "List conversations",
  },
  {
    description: "Read Messages in a conversation or search decoded message text.",
    effect: "read",
    name: "read_messages",
    title: "Read messages",
  },
  {
    description: "Ask Messages to send text to one named conversation or iMessage address.",
    effect: "write",
    name: "send_message",
    title: "Send message",
  },
];

const mockComputerUseOperations: readonly (MockToolSeed & {
  readonly effect: "read" | "write";
})[] = [
  {
    description: "See the app: its accessibility tree and a screenshot.",
    effect: "read",
    name: "observe",
    title: "Observe",
  },
  {
    description: "Perform actions in order in the app, then return a fresh observation.",
    effect: "write",
    name: "act",
    title: "Act",
  },
];

const mockAgentPhoneOperations: readonly (MockToolSeed & {
  readonly effect: "read" | "write";
})[] = [
  {
    description: "See the phone's screen: its accessibility tree and a screenshot.",
    effect: "read",
    name: "observe",
    title: "Observe",
  },
  {
    description: "Perform actions on the phone in order, then return a fresh observation.",
    effect: "write",
    name: "act",
    title: "Act",
  },
  {
    description: "Let go of the phone so another task can use it.",
    effect: "read",
    name: "release",
    title: "Release",
  },
];

/**
 * The tool rows one app connection has. Access is the ceiling, so a read-only
 * connection simply has no send row — there is nothing for a grant to reach.
 */
export function mockComputerAppTools(input: {
  readonly access: "read" | "read-write";
  readonly connectionId: IntegrationConnectionId;
  readonly definitionId: string;
  readonly serverId: IntegrationServerId;
}): MockInstallationEntry["tools"] {
  const operations =
    input.definitionId === mockComputerUseDefinition.id
      ? mockComputerUseOperations
      : input.definitionId === mockAgentPhoneDefinition.id
        ? mockAgentPhoneOperations
        : (mockIphoneAppDefinitions
            .find(({ id }) => id === input.definitionId)
            ?.computerApp?.operations.map(({ name, effect }) => ({
              name,
              effect,
              title: name.replaceAll("_", " "),
              description: name.replaceAll("_", " "),
            })) ?? mockMessagesOperations);
  return operations
    .filter(({ effect }) => input.access === "read-write" || effect === "read")
    .map((operation) => ({
      annotations: { readOnlyHint: operation.effect === "read" },
      connectionId: input.connectionId,
      description: operation.description,
      id: createIntegrationId("tool"),
      name: operation.name,
      schemaDigest: mockIntegrationDigest(`${input.definitionId}-tool-${operation.name}`),
      serverId: input.serverId,
      status: "active",
      title: operation.title,
    }));
}

/**
 * A computer definition materialises one server with no tools of its own:
 * tools exist per connection, because the connection's access is what decides
 * which of them exist at all.
 */
export function mockComputerAppInstallation(input: {
  /** The app connections that already exist, each with the ceiling it was given. */
  readonly connections: readonly {
    readonly access: "read" | "read-write";
    readonly id: IntegrationConnectionId;
  }[];
  readonly createdAt: string;
  readonly definition: IntegrationDefinitionSummary;
  readonly digest: string;
  readonly installedBy: UserId;
}): MockInstallationEntry {
  const { createdAt, definition } = input;
  const installationId = createIntegrationId("installation");
  const serverId = createIntegrationId("server");
  return {
    installation: {
      createdAt,
      description: definition.description,
      id: installationId,
      manifest: { definition, digest: input.digest, kind: "catalog" },
      name: definition.id,
      provenance: { installedBy: input.installedBy, source: "catalog" },
      revision: 1,
      sourceKind: "built-in",
      status: "active",
      title: definition.name,
      trust: "built-in",
      updatedAt: createdAt,
      version: null,
    },
    servers: [
      {
        connectionRequirement: { definitionId: definition.id, kind: "computer" },
        id: serverId,
        installationId,
        name: definition.id,
        status: "active",
        statusDetail: null,
        toolGeneration: 1,
        transportType: "computer",
        updatedAt: createdAt,
      },
    ],
    skills: [],
    tools: input.connections.flatMap(({ access, id }) =>
      mockComputerAppTools({
        access,
        connectionId: id,
        definitionId: definition.id,
        serverId,
      }),
    ),
  };
}

export function mockIntegrationInstallation(input: {
  readonly createdAt: string;
  readonly definition: IntegrationDefinitionSummary;
  readonly installedBy: UserId;
  readonly digest: string;
  readonly providerApplicationRequired: boolean;
  readonly skills: readonly MockSkillSeed[];
  readonly tools: readonly MockToolSeed[];
}): MockInstallationEntry {
  const { createdAt, definition } = input;
  const installationId = createIntegrationId("installation");
  const serverId = createIntegrationId("server");
  return {
    installation: {
      createdAt,
      description: definition.description,
      id: installationId,
      manifest: { definition, digest: input.digest, kind: "catalog" },
      name: definition.id,
      provenance: { installedBy: input.installedBy, source: "catalog" },
      revision: 1,
      sourceKind: "built-in",
      status: "active",
      title: definition.name,
      trust: "built-in",
      updatedAt: createdAt,
      version: null,
    },
    servers: [
      {
        connectionRequirement: {
          definitionId: definition.id,
          kind: "provider",
          provider: definition.provider,
          providerApplicationRequired: input.providerApplicationRequired,
        },
        id: serverId,
        installationId,
        name: definition.id,
        status: "active",
        statusDetail: null,
        toolGeneration: 1,
        transportType: "adapter",
        updatedAt: createdAt,
      },
    ],
    skills: input.skills.map((skill) => ({
      description: skill.description,
      digest: mockIntegrationDigest(`${definition.id}-skill-${skill.name}`),
      id: createIntegrationId("skill"),
      installationId,
      name: skill.name,
      status: "active",
      updatedAt: createdAt,
    })),
    tools: input.tools.map((tool) => ({
      annotations: {},
      connectionId: null,
      description: tool.description,
      id: createIntegrationId("tool"),
      name: tool.name,
      schemaDigest: mockIntegrationDigest(`${definition.id}-tool-${tool.name}`),
      serverId,
      status: "active",
      title: tool.title,
    })),
  };
}

export function mockCatalogTools(
  definition: IntegrationDefinitionSummary,
): readonly MockToolSeed[] {
  return [
    {
      description: `${definition.name} operations.`,
      name: `${definition.id}_operations`,
      title: `${definition.name} operations`,
    },
  ];
}

const mockGithubToolSeeds: readonly MockToolSeed[] = [
  {
    description: "Read one repository's metadata, default branch, and visibility.",
    name: "repos_get",
    title: "Get repository",
  },
  {
    description: "List the repositories the connected account can read.",
    name: "repos_list",
    title: "List repositories",
  },
  {
    description: "List open and closed issues for one repository.",
    name: "issues_list",
    title: "List issues",
  },
  {
    description: "Read one issue with its labels, assignees, and body.",
    name: "issues_get",
    title: "Get issue",
  },
  {
    description: "List pull requests for one repository.",
    name: "pulls_list",
    title: "List pull requests",
  },
  {
    description: "Read one pull request with its head and base branches.",
    name: "pulls_get",
    title: "Get pull request",
  },
  {
    description: "Read the files changed by one pull request.",
    name: "pulls_list_files",
    title: "List pull request files",
  },
  {
    description: "Search code across the repositories the account can read.",
    name: "search_code",
    title: "Search code",
  },
  {
    description: "Open a new issue in one repository.",
    name: "issues_create",
    title: "Create issue",
  },
  {
    description: "Comment on an existing issue or pull request.",
    name: "issues_create_comment",
    title: "Comment on issue",
  },
  {
    description: "Open a pull request from one branch into another.",
    name: "pulls_create",
    title: "Open pull request",
  },
  {
    description: "Create or update one file on a branch.",
    name: "repos_put_contents",
    title: "Write repository file",
  },
  {
    description: "Read the login and id of the connected GitHub account.",
    name: "users_get_authenticated",
    title: "Get signed-in user",
  },
];

const mockLinearToolSeeds: readonly MockToolSeed[] = [
  {
    description: "List Linear issues filtered by team, state, or assignee.",
    name: "issues_list",
    title: "List issues",
  },
  {
    description: "Read one Linear issue with its description and comments.",
    name: "issue_get",
    title: "Get issue",
  },
  {
    description: "Create a Linear issue in one team.",
    name: "issue_create",
    title: "Create issue",
  },
  {
    description: "Update the state, assignee, or estimate of one issue.",
    name: "issue_update",
    title: "Update issue",
  },
  {
    description: "Add a comment to one Linear issue.",
    name: "comment_create",
    title: "Comment on issue",
  },
];

const mockNotionToolSeeds: readonly MockToolSeed[] = [
  {
    description: "Search the authorized Notion workspace for pages and databases.",
    name: "search",
    title: "Search workspace",
  },
  {
    description: "Read one Notion page and its properties.",
    name: "retrieve_page",
    title: "Get page",
  },
  {
    description: "Read the block children of one Notion page.",
    name: "retrieve_blocks",
    title: "Get page content",
  },
  {
    description: "Create a Notion page inside a parent page or database.",
    name: "create_page",
    title: "Create page",
  },
  {
    description: "Update the properties of one Notion page.",
    name: "update_page",
    title: "Update page",
  },
  {
    description: "Read the bot identity of this Notion authorization.",
    name: "retrieve_bot_user",
    title: "Get bot user",
  },
];

const mockSlackToolSeeds: readonly MockToolSeed[] = [
  {
    description: "List the channels this Slack app can see.",
    name: "conversations_list",
    title: "List channels",
  },
  {
    description: "Read recent messages from one Slack channel.",
    name: "conversations_history",
    title: "Read channel history",
  },
  {
    description: "Read the replies inside one Slack thread.",
    name: "conversations_replies",
    title: "Read thread replies",
  },
  {
    description: "Post a message to one Slack channel.",
    name: "chat_post_message",
    title: "Post message",
  },
];

/**
 * A representative deployment: installed presets with connected, key-based,
 * and failing accounts, one catalog-only preset, one remote MCP server, and
 * the provider-authorization spread the connect and admin flows branch on.
 */
export function createInitialIntegrationState(ownerUserId: UserId): MockIntegrationState {
  const github = mockIntegrationInstallation({
    installedBy: ownerUserId,
    createdAt: "2026-07-14T09:12:00.000Z",
    definition: mockGithubDefinition,
    digest: mockIntegrationDigest("github-catalog"),
    providerApplicationRequired: true,
    skills: [
      {
        description: "Draft a release note from merged pull requests in one repository.",
        name: "release-notes",
      },
      {
        description: "Summarize open issues that have gone stale for a repository.",
        name: "issue-triage",
      },
    ],
    tools: mockGithubToolSeeds,
  });
  const googleCalendar = mockIntegrationInstallation({
    installedBy: ownerUserId,
    createdAt: "2026-07-15T10:00:00.000Z",
    definition: mockGoogleCalendarDefinition,
    digest: mockIntegrationDigest("google-calendar-catalog"),
    providerApplicationRequired: true,
    skills: [],
    tools: mockCatalogTools(mockGoogleCalendarDefinition),
  });
  const linear = mockIntegrationInstallation({
    installedBy: ownerUserId,
    createdAt: "2026-07-16T11:40:00.000Z",
    definition: mockLinearDefinition,
    digest: mockIntegrationDigest("linear-catalog"),
    providerApplicationRequired: false,
    skills: [],
    tools: mockLinearToolSeeds,
  });
  const notion = mockIntegrationInstallation({
    installedBy: ownerUserId,
    createdAt: "2026-07-21T15:05:00.000Z",
    definition: mockNotionDefinition,
    digest: mockIntegrationDigest("notion-catalog"),
    providerApplicationRequired: true,
    skills: [
      {
        description: "Turn a Thread transcript into a structured Notion page.",
        name: "meeting-notes",
      },
    ],
    tools: mockNotionToolSeeds,
  });
  const slack = mockIntegrationInstallation({
    installedBy: ownerUserId,
    createdAt: "2026-08-01T08:30:00.000Z",
    definition: mockSlackDefinition,
    digest: mockIntegrationDigest("slack-catalog"),
    providerApplicationRequired: true,
    skills: [],
    tools: mockSlackToolSeeds,
  });
  // Messages is on for the Mac this deployment runs on, and only to read; the
  // studio Mac has it on too and is asleep.
  const messagesConnectionId = createIntegrationId("connection");
  const messagesAwayConnectionId = createIntegrationId("connection");
  const messages = mockComputerAppInstallation({
    installedBy: ownerUserId,
    connections: [
      { access: "read", id: messagesConnectionId },
      { access: "read-write", id: messagesAwayConnectionId },
    ],
    createdAt: "2026-09-02T10:15:00.000Z",
    definition: mockMessagesDefinition,
    digest: mockIntegrationDigest("apple-messages-catalog"),
  });

  // Computer use on the Mac this deployment runs on, under automatic
  // approval: Notes and Calendar are in use, and Safari was blocked, so it has
  // no tools at all.
  const notesConnectionId = createIntegrationId("connection");
  const calendarConnectionId = createIntegrationId("connection");
  const safariConnectionId = createIntegrationId("connection");
  const computerUse = mockComputerAppInstallation({
    installedBy: ownerUserId,
    connections: [
      { access: "read-write", id: notesConnectionId },
      { access: "read", id: calendarConnectionId },
    ],
    createdAt: "2026-09-18T09:00:00.000Z",
    definition: mockComputerUseDefinition,
    digest: mockIntegrationDigest("macos-app-catalog"),
  });
  // The agent phone, approved on its own screen to be seen and controlled.
  const agentPhoneConnectionId = createIntegrationId("connection");
  const agentPhone = mockComputerAppInstallation({
    installedBy: ownerUserId,
    connections: [{ access: "read-write", id: agentPhoneConnectionId }],
    createdAt: "2026-10-11T09:00:00.000Z",
    definition: mockAgentPhoneDefinition,
    digest: mockIntegrationDigest("android-phone-catalog"),
  });
  const computerUseConnection = (input: {
    readonly access: "read" | "read-write";
    readonly app: (typeof mockComputerUseApps)[keyof typeof mockComputerUseApps];
    readonly blockedAt: string | null;
    readonly id: IntegrationConnectionId;
    readonly policyRevision: number | null;
  }): IntegrationConnectionSummary => ({
    accountIdentifier: null,
    applicationSource: null,
    authMethodId: "computer",
    authorizationDigest: null,
    computer: {
      access: input.access,
      app: input.app,
      blockedAt: input.blockedAt,
      policyRevision: input.policyRevision,
      runnerId: mockMessagesRunnerId,
    },
    connectionMethod: "computer",
    createdAt: "2026-09-18T09:10:00.000Z",
    definitionId: mockComputerUseDefinition.id,
    displayName: `${input.app.displayName} on Mac mini`,
    externalIdentityId: null,
    externalTenantId: null,
    grantedScopes: [],
    id: input.id,
    provider: mockComputerUseDefinition.provider,
    providerApplicationId: null,
    // A blocked app keeps its connection so it can be unblocked, and nothing more.
    status: input.blockedAt === null ? "connected" : "paused",
    statusDetail: null,
    statusReason: null,
    updatedAt: input.blockedAt ?? "2026-09-18T09:10:00.000Z",
  });

  const remoteInstallationId = createIntegrationId("installation");
  const remoteServerId = createIntegrationId("server");
  const remoteConnectionId = createIntegrationId("connection");
  const remoteMcp: MockInstallationEntry = {
    installation: {
      createdAt: "2026-08-03T17:22:00.000Z",
      description: "The TinyCRM MCP server approved for this deployment.",
      id: remoteInstallationId,
      manifest: { kind: "remote-mcp", url: "https://mcp.tinycrm.example/mcp" },
      name: "tinycrm",
      provenance: { installedBy: ownerUserId, source: "remote-mcp" },
      revision: 2,
      sourceKind: "remote-mcp",
      status: "active",
      title: "TinyCRM",
      trust: "administrator-approved",
      updatedAt: "2026-08-05T09:02:00.000Z",
      version: "2026-07-30",
    },
    servers: [
      {
        connectionRequirement: { kind: "mcp-oauth" },
        id: remoteServerId,
        installationId: remoteInstallationId,
        name: "tinycrm",
        status: "active",
        statusDetail: null,
        toolGeneration: 4,
        transportType: "streamable-http",
        updatedAt: "2026-08-05T09:02:00.000Z",
      },
    ],
    skills: [],
    tools: [
      {
        annotations: {},
        connectionId: remoteConnectionId,
        description: "Search TinyCRM contacts by name, company, or email.",
        id: createIntegrationId("tool"),
        name: "search_contacts",
        schemaDigest: mockIntegrationDigest("tinycrm-tool-search-contacts"),
        serverId: remoteServerId,
        status: "active",
        title: "Search contacts",
      },
      {
        annotations: {},
        connectionId: remoteConnectionId,
        description: "Read one TinyCRM deal with its stage and owner.",
        id: createIntegrationId("tool"),
        name: "get_deal",
        schemaDigest: mockIntegrationDigest("tinycrm-tool-get-deal"),
        serverId: remoteServerId,
        status: "active",
        title: "Get deal",
      },
      {
        annotations: {},
        connectionId: remoteConnectionId,
        description: "Log an activity note against one TinyCRM contact.",
        id: createIntegrationId("tool"),
        name: "log_activity",
        schemaDigest: mockIntegrationDigest("tinycrm-tool-log-activity"),
        serverId: remoteServerId,
        status: "active",
        title: "Log activity",
      },
    ],
  };

  const githubApplicationId = createIntegrationId("providerApplication");
  const githubHostedSource: IntegrationOAuthApplicationSource = {
    brokerIssuer: mockIntegrationBrokerIssuer,
    kind: "hosted-oauth",
    providerApplicationRevision: 3,
  };
  const githubDeploymentSource: IntegrationOAuthApplicationSource = {
    callbackUrl: mockIntegrationCallbackUrl("github"),
    kind: "deployment-oauth",
    providerApplicationId: githubApplicationId,
    providerApplicationRevision: 3,
  };
  const notionHostedSource: IntegrationOAuthApplicationSource = {
    brokerIssuer: mockIntegrationBrokerIssuer,
    kind: "hosted-oauth",
    providerApplicationRevision: 1,
  };
  const googleHostedSource: IntegrationOAuthApplicationSource = {
    brokerIssuer: mockIntegrationBrokerIssuer,
    kind: "hosted-oauth",
    providerApplicationRevision: 1,
  };

  return {
    applications: [
      {
        availability: "deployment",
        callbackUrl: mockIntegrationCallbackUrl("github"),
        canManage: true,
        clientId: "Iv1.mock0github0client",
        configuredSecretFields: ["clientSecret"],
        createdAt: "2026-07-14T09:05:00.000Z",
        displayName: "Opensteer on GitHub",
        id: githubApplicationId,
        ownerUserId: null,
        provider: "github",
        revision: 3,
        status: "active",
        updatedAt: "2026-08-02T13:44:00.000Z",
      },
    ],
    callbackUrls: {
      github: mockIntegrationCallbackUrl("github"),
      google: mockIntegrationCallbackUrl("google"),
      notion: mockIntegrationCallbackUrl("notion"),
      slack: mockIntegrationCallbackUrl("slack"),
    },
    catalog: [
      ...mockIphoneAppDefinitions.map((definition) => ({
        definition,
        digest: mockIntegrationDigest(`${definition.id}-catalog`),
        installationId: null,
      })),
      {
        definition: mockGithubDefinition,
        digest: mockIntegrationDigest("github-catalog"),
        installationId: github.installation.id,
      },
      {
        definition: mockGoogleCalendarDefinition,
        digest: mockIntegrationDigest("google-calendar-catalog"),
        installationId: googleCalendar.installation.id,
      },
      {
        definition: mockLinearDefinition,
        digest: mockIntegrationDigest("linear-catalog"),
        installationId: linear.installation.id,
      },
      {
        definition: mockNotionCatalogDefinition,
        digest: mockIntegrationDigest("notion-catalog"),
        installationId: notion.installation.id,
      },
      {
        definition: mockMessagesDefinition,
        digest: mockIntegrationDigest("apple-messages-catalog"),
        installationId: messages.installation.id,
      },
      {
        definition: mockComputerUseDefinition,
        digest: mockIntegrationDigest("macos-app-catalog"),
        installationId: computerUse.installation.id,
      },
      {
        definition: mockAgentPhoneDefinition,
        digest: mockIntegrationDigest("android-phone-catalog"),
        installationId: agentPhone.installation.id,
      },
      {
        definition: mockSlackDefinition,
        digest: mockIntegrationDigest("slack-catalog"),
        installationId: slack.installation.id,
      },
      {
        definition: mockResendCatalogDefinition,
        digest: mockIntegrationDigest("resend-catalog"),
        installationId: null,
      },
    ],
    connections: [
      {
        accountIdentifier: "octocat",
        applicationSource: githubHostedSource,
        authMethodId: "github-app",
        authorizationDigest: mockIntegrationDigest("authorization"),
        computer: null,
        connectionMethod: "managed-oauth",
        createdAt: "2026-07-14T09:20:00.000Z",
        definitionId: "github",
        displayName: "octocat",
        externalIdentityId: "583231",
        externalTenantId: null,
        grantedScopes: ["read:user", "repo"],
        id: createIntegrationId("connection"),
        provider: "github",
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        statusReason: null,
        updatedAt: "2026-08-06T10:01:00.000Z",
      },
      {
        accountIdentifier: "opensteer-release-bot",
        applicationSource: {
          callbackUrl: mockIntegrationCallbackUrl("github"),
          kind: "deployment-oauth",
          providerApplicationId: githubApplicationId,
          providerApplicationRevision: 2,
        },
        authMethodId: "github-app",
        authorizationDigest: mockIntegrationDigest("authorization"),
        computer: null,
        connectionMethod: "managed-oauth",
        createdAt: "2026-07-28T14:02:00.000Z",
        definitionId: "github",
        displayName: "opensteer-release-bot",
        externalIdentityId: "984112",
        externalTenantId: "opensteer",
        grantedScopes: ["read:user", "repo"],
        id: createIntegrationId("connection"),
        provider: "github",
        providerApplicationId: githubApplicationId,
        status: "needs-attention",
        statusDetail: integrationApplicationSourceUnavailableDetail,
        statusReason: null,
        updatedAt: "2026-08-02T13:50:00.000Z",
      },
      // Signed in, but the GitHub App reaches none of its repositories yet:
      // the Host records why, and the release bot above, whose app revision
      // is gone, has to sign in again instead.
      {
        accountIdentifier: "opensteer-docs",
        applicationSource: githubHostedSource,
        authMethodId: "github-app",
        authorizationDigest: mockIntegrationDigest("authorization"),
        computer: null,
        connectionMethod: "managed-oauth",
        createdAt: "2026-10-12T15:30:00.000Z",
        definitionId: "github",
        displayName: "opensteer-docs",
        externalIdentityId: "1204417",
        externalTenantId: null,
        grantedScopes: ["read:user", "repo"],
        id: createIntegrationId("connection"),
        provider: "github",
        providerApplicationId: null,
        status: "needs-attention",
        statusDetail:
          "Install or configure this GitHub App for at least one repository you can access, then check again.",
        statusReason: "permissions",
        updatedAt: "2026-10-12T15:32:00.000Z",
      },
      // Waiting for its repositories too, but GitHub has since revoked its
      // token: the repository check is how the Host finds that out.
      {
        accountIdentifier: "opensteer-ci",
        applicationSource: githubHostedSource,
        authMethodId: "github-app",
        authorizationDigest: mockIntegrationDigest("authorization"),
        computer: null,
        connectionMethod: "managed-oauth",
        createdAt: "2026-10-13T11:05:00.000Z",
        definitionId: "github",
        displayName: "opensteer-ci",
        externalIdentityId: "1377203",
        externalTenantId: null,
        grantedScopes: ["read:user", "repo"],
        id: mockGitHubRevoked.connectionId,
        provider: "github",
        providerApplicationId: null,
        status: "needs-attention",
        statusDetail:
          "Install or configure this GitHub App for at least one repository you can access, then check again.",
        statusReason: "permissions",
        updatedAt: "2026-10-13T11:07:00.000Z",
      },
      {
        accountIdentifier: null,
        applicationSource: { kind: "api-key" },
        authMethodId: "api-key",
        authorizationDigest: mockIntegrationDigest("authorization"),
        computer: null,
        connectionMethod: "api-key",
        createdAt: "2026-07-16T12:00:00.000Z",
        definitionId: "linear",
        displayName: "Alex · Opensteer",
        externalIdentityId: "lin_usr_88213",
        externalTenantId: "lin_org_opensteer",
        grantedScopes: [],
        id: createIntegrationId("connection"),
        provider: "linear",
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        statusReason: null,
        updatedAt: "2026-07-16T12:00:00.000Z",
      },
      {
        accountIdentifier: null,
        // An app on a computer holds no credential and no OAuth posture, so it
        // carries no authorization digest to describe one.
        applicationSource: null,
        authMethodId: "computer",
        authorizationDigest: null,
        computer: {
          access: "read",
          app: null,
          blockedAt: null,
          policyRevision: null,
          runnerId: mockMessagesRunnerId,
        },
        connectionMethod: "computer",
        createdAt: "2026-09-02T10:20:00.000Z",
        definitionId: "apple-messages",
        displayName: "Mac mini",
        externalIdentityId: null,
        externalTenantId: null,
        grantedScopes: [],
        id: messagesConnectionId,
        provider: "apple-messages",
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        statusReason: null,
        updatedAt: "2026-09-02T10:20:00.000Z",
      },
      {
        accountIdentifier: null,
        applicationSource: null,
        authMethodId: "computer",
        authorizationDigest: null,
        // On, at the higher ceiling, on a Mac that is asleep: the connection
        // and its grants stand, and the row says the change waits.
        computer: {
          access: "read-write",
          app: null,
          blockedAt: null,
          policyRevision: null,
          runnerId: mockMessagesAwayRunnerId,
        },
        connectionMethod: "computer",
        createdAt: "2026-09-05T09:00:00.000Z",
        definitionId: "apple-messages",
        displayName: "Studio iMac",
        externalIdentityId: null,
        externalTenantId: null,
        grantedScopes: [],
        id: messagesAwayConnectionId,
        provider: "apple-messages",
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        statusReason: null,
        updatedAt: "2026-09-05T09:00:00.000Z",
      },
      computerUseConnection({
        access: "read-write",
        app: mockComputerUseApps.notes,
        blockedAt: null,
        id: notesConnectionId,
        policyRevision: null,
      }),
      // Approved automatically, which the connection remembers.
      computerUseConnection({
        access: "read",
        app: mockComputerUseApps.calendar,
        blockedAt: null,
        id: calendarConnectionId,
        policyRevision: 1,
      }),
      computerUseConnection({
        access: "read-write",
        app: mockComputerUseApps.safari,
        blockedAt: "2026-09-19T15:30:00.000Z",
        id: safariConnectionId,
        policyRevision: 1,
      }),
      {
        accountIdentifier: null,
        applicationSource: null,
        authMethodId: "computer",
        authorizationDigest: null,
        computer: {
          access: "read-write",
          app: null,
          blockedAt: null,
          policyRevision: null,
          runnerId: mockAgentPhoneRunnerId,
        },
        connectionMethod: "computer",
        createdAt: "2026-10-11T09:05:00.000Z",
        definitionId: mockAgentPhoneDefinition.id,
        displayName: "Pixel 7",
        externalIdentityId: null,
        externalTenantId: null,
        grantedScopes: [],
        id: agentPhoneConnectionId,
        provider: mockAgentPhoneDefinition.provider,
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        statusReason: null,
        updatedAt: "2026-10-11T09:05:00.000Z",
      },
      {
        accountIdentifier: null,
        applicationSource: notionHostedSource,
        authMethodId: "notion-oauth",
        authorizationDigest: mockIntegrationDigest("authorization"),
        computer: null,
        connectionMethod: "managed-oauth",
        createdAt: "2026-07-21T15:31:00.000Z",
        definitionId: "notion",
        displayName: "Opensteer HQ",
        externalIdentityId: "ntn_bot_41",
        externalTenantId: "ntn_ws_opensteer",
        grantedScopes: [],
        id: createIntegrationId("connection"),
        provider: "notion",
        providerApplicationId: null,
        status: "needs-attention",
        statusDetail: "Notion revoked this authorization. Reconnect to restore page access.",
        statusReason: null,
        updatedAt: "2026-08-08T07:18:00.000Z",
      },
      {
        accountIdentifier: null,
        applicationSource: { kind: "provider-specific", method: "bring-your-own" },
        authMethodId: "oauth",
        authorizationDigest: mockIntegrationDigest("authorization"),
        computer: null,
        connectionMethod: "bring-your-own",
        createdAt: "2026-06-02T09:00:00.000Z",
        definitionId: "slack",
        displayName: "Opensteer (old workspace)",
        externalIdentityId: "U0FORMER",
        externalTenantId: "T0FORMER",
        grantedScopes: ["chat:write"],
        id: createIntegrationId("connection"),
        provider: "slack",
        providerApplicationId: null,
        status: "revoked",
        statusDetail: "Disconnected on 2 June.",
        statusReason: null,
        updatedAt: "2026-06-02T09:40:00.000Z",
      },
      mockGoogleCalendarConnection({
        accountIdentifier: "alex@example.com",
        createdAt: "2026-07-15T10:05:00.000Z",
        externalIdentityId: `mock-${mockGoogleCalendarDefinition.id}-identity`,
        source: googleHostedSource,
      }),
      mockGoogleCalendarConnection({
        accountIdentifier: "alex@opensteer.example",
        createdAt: "2026-07-15T10:09:00.000Z",
        externalIdentityId: "google-subject-opensteer",
        source: googleHostedSource,
      }),
      mockVapiConnection({
        createdAt: "2026-08-09T09:12:00.000Z",
        id: mockVapi.connectionId,
        rejected: true,
      }),
      mockVapiConnection({
        createdAt: "2026-08-09T09:40:00.000Z",
        id: mockVapi.twinConnectionId,
        rejected: false,
      }),
    ],
    grants: [
      {
        access: "read-write",
        alias: "GitHub · octocat",
        connectionId: null,
        createdAt: "2026-07-30T09:00:00.000Z",
        id: createIntegrationId("grant"),
        installationId: github.installation.id,
        isDefault: true,
        ownerUserId: ownerUserId,
        revokedAt: null,
        status: "active",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000002",
      },
      {
        access: "read",
        alias: "TinyCRM · shared",
        connectionId: remoteConnectionId,
        createdAt: "2026-08-05T09:10:00.000Z",
        id: createIntegrationId("grant"),
        installationId: remoteInstallationId,
        isDefault: false,
        ownerUserId: ownerUserId,
        revokedAt: null,
        status: "active",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000002",
      },
      {
        access: "read",
        alias: "Linear · Alex",
        connectionId: null,
        createdAt: "2026-07-18T16:20:00.000Z",
        id: createIntegrationId("grant"),
        installationId: linear.installation.id,
        isDefault: true,
        ownerUserId: ownerUserId,
        revokedAt: null,
        status: "active",
        workspaceId: "wsp_00000000-0000-4000-8000-000000000003",
      },
    ],
    installations: [
      github,
      googleCalendar,
      linear,
      messages,
      computerUse,
      agentPhone,
      notion,
      slack,
      remoteMcp,
      mockVapiInstallation(ownerUserId),
      mockMcpProposalInstallation(ownerUserId),
      mockGmailProposalInstallation(ownerUserId),
      mockSlackMcpInstallation(ownerUserId),
    ],
    mcpConnections: [
      {
        accountIdentifier: "alex@example.com",
        connectionId: remoteConnectionId,
        createdAt: "2026-08-03T17:40:00.000Z",
        displayName: "TinyCRM · alex@example.com",
        installationId: remoteInstallationId,
        serverId: remoteServerId,
        status: "connected",
        updatedAt: "2026-08-05T09:02:00.000Z",
      },
      {
        accountIdentifier: "alex@example.com",
        connectionId: mockMcpProposal.connectionId,
        createdAt: "2026-08-12T10:05:00.000Z",
        displayName: `${mockMcpProposalDefinition.name} account`,
        installationId: mockMcpProposal.installationId as MockMcpConnection["installationId"],
        serverId: mockMcpProposal.serverId,
        status: "connected",
        updatedAt: "2026-08-12T10:05:00.000Z",
      },
    ],
    providerAuthorizations: {
      github: {
        availableSources: [githubHostedSource, githubDeploymentSource],
        code: "READY",
        detail: "Opensteer-managed sign-in is ready for new GitHub accounts.",
        selectedSource: githubHostedSource,
        selectedSourceKind: "hosted-oauth",
        hostedOAuthStatus: "available",
      },
      google: {
        availableSources: [googleHostedSource],
        code: "READY",
        detail: "Opensteer-managed sign-in is ready for new Google accounts.",
        selectedSource: googleHostedSource,
        selectedSourceKind: "hosted-oauth",
        hostedOAuthStatus: "available",
      },
      notion: {
        availableSources: [notionHostedSource],
        code: "ACCOUNT_LINK_REQUIRED",
        detail:
          "Link this Opensteer to your Opensteer Account to use managed Notion sign-in, or configure a custom OAuth app.",
        selectedSource: null,
        selectedSourceKind: null,
        hostedOAuthStatus: "unsupported",
      },
      slack: {
        availableSources: [],
        code: "PROVIDER_APPLICATION_REQUIRED",
        detail: "Add a Slack OAuth application for this deployment before connecting an account.",
        selectedSource: null,
        selectedSourceKind: null,
        hostedOAuthStatus: "unsupported",
      },
    },
    providers: [
      {
        description: mockGithubDefinition.description,
        hostedOAuthCapable: true,
        label: mockGithubDefinition.name,
        provider: "github",
        secretFields: ["clientSecret"],
        setupLabel: "GitHub OAuth application",
        setupSteps: [
          "Create an OAuth application for GitHub REST.",
          "Add the callback URL shown by Opensteer.",
          "Copy the client ID and client secret into Opensteer.",
        ],
        setupUrl: "https://github.com/settings/apps/new",
      },
      {
        description: mockNotionDefinition.description,
        hostedOAuthCapable: true,
        label: mockNotionDefinition.name,
        provider: "notion",
        secretFields: ["clientSecret"],
        setupLabel: "Notion OAuth application",
        setupSteps: [
          "Create a public integration in the Notion developer console.",
          "Add the callback URL shown by Opensteer.",
          "Copy the client ID and client secret into Opensteer.",
        ],
        setupUrl: "https://www.notion.so/my-integrations",
      },
      {
        description: mockSlackDefinition.description,
        hostedOAuthCapable: true,
        label: mockSlackDefinition.name,
        provider: "slack",
        secretFields: ["clientSecret"],
        setupLabel: "Slack app",
        setupSteps: [
          "Create a Slack app for your workspace.",
          "Add the callback URL shown by Opensteer as a redirect URL.",
          "Copy the client ID and client secret into Opensteer.",
        ],
        setupUrl: "https://api.slack.com/apps",
      },
    ],
  };
}
