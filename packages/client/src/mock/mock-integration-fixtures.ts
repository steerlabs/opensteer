import { RunnerIdSchema, type UserId } from "@opensteer/core";
import {
  IntegrationDefinitionSummarySchema,
  createIntegrationId,
  type IntegrationCatalogEntry,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationDefinitionSummary,
  type IntegrationGrant,
  type IntegrationPlatformDashboard,
  type IntegrationProviderApplication,
  type IntegrationProviderAuthorization,
  type IntegrationProviderManifest,
  type IntegrationInstallationId,
  type IntegrationServerId,
} from "@opensteer/integration-core";

type MockInstallationEntry = IntegrationPlatformDashboard["installations"][number];
type MockMcpConnection = IntegrationPlatformDashboard["connections"][number];

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

export function mockIntegrationDigest(seed: string): string {
  return `${seed}${"-0".repeat(43)}`.replaceAll(/[^A-Za-z0-9_-]/g, "-").slice(0, 43);
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
      { name: "query_messages", effect: "read" },
      { name: "export_attachment", effect: "read" },
      { name: "send_message", effect: "write" },
    ],
    accessSummaries: {
      read: "Allows searching and reading conversations with names from Contacts; reading also needs Contacts access. Sending is off.",
      readWrite:
        "Allows searching and reading conversations with names from Contacts, and sending messages as you. Reading also needs Contacts access. Sending may ask for macOS Automation permission on this Mac.",
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

export const mockIntegrationDefinitions: readonly IntegrationDefinitionSummary[] = [
  mockMessagesDefinition,
  ...mockIphoneAppDefinitions,
  mockComputerUseDefinition,
  mockAgentPhoneDefinition,
];

/** The operations the preview materialises per connection, by effect. */
const mockMessagesOperations: readonly (MockToolSeed & { readonly effect: "read" | "write" })[] = [
  {
    description: "Query Messages history with read-only SQL.",
    effect: "read",
    name: "query_messages",
    title: "Query messages",
  },
  {
    description: "Copy an attachment original file to a path this task can read.",
    effect: "read",
    name: "export_attachment",
    title: "Export attachment",
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

/**
 * A representative deployment: installed presets with connected, key-based,
 * and failing accounts, one catalog-only preset, one remote MCP server, and
 * the provider-authorization spread the connect and admin flows branch on.
 */
/** The local server the preview lists under "On your devices", registered by an agent. */
export const mockNotesServer = {
  installationId: "iin_00000000-0000-4000-8000-0000000000a1" as IntegrationInstallationId,
  serverId: "isv_00000000-0000-4000-8000-0000000000a1" as IntegrationServerId,
  pluginId: "plg_notes_search",
  title: "Notes search",
  computer: "Home Mac",
  secrets: [{ name: "NOTES_TOKEN", title: "Notes API token" }],
} as const;

/** A local server registered by an agent: one plugin record, one server on one computer. */
export function mockLocalServerInstallation(input: {
  readonly installationId?: IntegrationInstallationId;
  readonly serverId?: IntegrationServerId;
  readonly pluginId: string;
  readonly name: string;
  readonly title: string;
  readonly installedBy: UserId;
  readonly issue?: string | null;
}): MockInstallationEntry {
  const at = "2026-10-20T09:00:00.000Z";
  const installationId = input.installationId ?? createIntegrationId("installation");
  return {
    installation: {
      createdAt: at,
      description: "",
      id: installationId,
      manifest: {},
      name: input.name,
      pluginId: input.pluginId,
      provenance: { installedBy: input.installedBy, source: "plugin" },
      revision: 1,
      sourceKind: "plugin",
      status: "active",
      title: input.title,
      trust: "administrator-approved",
      updatedAt: at,
      version: null,
    },
    servers: [
      {
        connectionRequirement: { kind: "none" },
        id: input.serverId ?? createIntegrationId("server"),
        installationId,
        name: input.name,
        status: input.issue ? "needs-attention" : "active",
        statusDetail: input.issue ?? null,
        toolGeneration: 1,
        transportType: "runner",
        updatedAt: at,
      },
    ],
    tools: [],
  };
}

export function createInitialIntegrationState(ownerUserId: UserId): MockIntegrationState {
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

  return {
    applications: [],
    callbackUrls: {},
    catalog: [
      ...mockIphoneAppDefinitions.map((definition) => ({
        definition,
        digest: mockIntegrationDigest(`${definition.id}-catalog`),
        installationId: null,
      })),
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
    ],
    connections: [
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
    ],
    grants: [],
    installations: [
      messages,
      computerUse,
      agentPhone,
      mockLocalServerInstallation({
        installationId: mockNotesServer.installationId,
        serverId: mockNotesServer.serverId,
        pluginId: mockNotesServer.pluginId,
        name: "notes-search",
        title: mockNotesServer.title,
        installedBy: ownerUserId,
      }),
    ],
    mcpConnections: [],
    providerAuthorizations: {},
    providers: [],
  };
}
