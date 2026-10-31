import {
  convertGoogleDiscoveryDocument,
  graphqlAdapter,
  mcpAdapter,
  openApiAdapter,
  OpenApiAdapterConfigSchema,
  type GoogleService,
  validateJsonSchema,
} from "@opensteer/integration-adapters";
import {
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
} from "@opensteer/integration-core";
import { authorizationDigest } from "@opensteer/integration-core/digest";
import { parseComputerAppConfig } from "@opensteer/integration-core/computer-app";
import { describe, expect, it } from "vitest";
import { getIntegrationDefinition, integrationDefinitions } from "./index.js";

describe("first-party integration catalog", () => {
  it("qualifies hosted OAuth only when both exchange and refresh are reviewed", () => {
    const hosted = integrationDefinitions.filter((definition) => definition.hostedOAuth);
    for (const definition of hosted) {
      const summary = integrationDefinitionSummary(definition);
      expect(summary.hostedOAuth, definition.id).toEqual(definition.hostedOAuth);
      expect(authorizationDigest(summary), definition.id).toBe(authorizationDigest(definition));
    }
    expect(hosted.map(({ id }) => id)).toEqual([
      "google-gmail",
      "google-calendar",
      "google-drive",
      "google-sheets",
      "google-docs",
      "google-slides",
      "google-forms",
      "google-tasks",
      "google-people",
      "slack",
      "github",
      "discord",
      "microsoft-profile",
      "microsoft-outlook-mail",
      "microsoft-outlook-calendar",
      "microsoft-contacts",
      "microsoft-todo",
      "microsoft-onedrive",
      "microsoft-onenote",
      "microsoft-teams-chat",
    ]);
    expect(getIntegrationDefinition("discord")?.hostedOAuth).toEqual({
      providerApplicationRevision: 1,
      qualification: { authorizationCodeExchange: true, refresh: true },
    });
    expect(
      hosted
        .filter(({ provider }) => provider === "microsoft")
        .map(({ hostedOAuth }) => hostedOAuth),
    ).toEqual(
      Array.from({ length: 8 }, () => ({
        providerApplicationRevision: 1,
        qualification: { authorizationCodeExchange: true, refresh: true },
      })),
    );
  });

  it("qualifies Discord's confidential authorization-code and refresh flow", () => {
    const discord = getIntegrationDefinition("discord");
    const oauth = discord?.authMethods.find((method) => method.kind === "oauth");
    expect(discord?.hostedOAuth).toEqual({
      providerApplicationRevision: 1,
      qualification: { authorizationCodeExchange: true, refresh: true },
    });
    expect(oauth?.kind).toBe("oauth");
    if (oauth?.kind !== "oauth") return;
    expect(oauth.oauth).toMatchObject({
      authorizationUrl: "https://discord.com/oauth2/authorize",
      clientAuth: "body",
      scopeSeparator: " ",
      scopes: ["identify", "email", "guilds"],
      tokenUrl: "https://discord.com/api/oauth2/token",
      usesPkce: false,
    });
    expect(oauth.oauth.identity).toMatchObject({
      accountIdentifierPath: "email",
      displayNamePath: "username",
      identityPath: "id",
      source: "userinfo",
      userinfoUrl: "https://discord.com/api/v10/users/@me",
    });
    expect(oauth.oauth.revocation).toMatchObject({
      tokenSource: "refresh-token-preferred",
      url: "https://discord.com/api/v10/oauth2/token/revoke",
    });
  });

  it("uses Slack's confidential Web OAuth flow for bot scopes", () => {
    const slack = getIntegrationDefinition("slack");
    const oauth = slack?.authMethods.find((method) => method.kind === "oauth");
    expect(oauth?.kind).toBe("oauth");
    if (oauth?.kind !== "oauth") return;
    expect(oauth.oauth.clientAuth).toBe("body");
    expect(oauth.oauth.usesPkce).toBe(false);
    expect(oauth.oauth.tokenResponseProfile).toBe("slack-bot");
    expect(oauth.oauth.identity.identityPath).toBe("bot_user_id");
    expect([...oauth.oauth.scopes].sort()).toEqual([
      "channels:history",
      "channels:read",
      "chat:write",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "mpim:history",
      "mpim:read",
      "users:read",
    ]);
  });

  it("qualifies GitHub's PKCE user-token flow without OAuth scopes", () => {
    const github = getIntegrationDefinition("github");
    const oauth = github?.authMethods.find((method) => method.kind === "oauth");
    expect(github?.hostedOAuth).toEqual({
      providerApplicationRevision: 1,
      qualification: { authorizationCodeExchange: true, refresh: true },
    });
    expect(oauth?.kind).toBe("oauth");
    if (oauth?.kind !== "oauth") return;
    expect(oauth.oauth.clientAuth).toBe("body");
    expect(oauth.oauth.usesPkce).toBe(true);
    expect(oauth.oauth.scopes).toEqual([]);
    expect(oauth.oauth.identity).toMatchObject({
      identityPath: "id",
      source: "userinfo",
      userinfoUrl: "https://api.github.com/user",
    });
  });

  it("keeps hosted Microsoft consent scoped to each Graph integration", () => {
    const expectedScopes = {
      "microsoft-profile": ["User.Read"],
      "microsoft-outlook-mail": [
        "User.Read",
        "Mail.ReadWrite",
        "Mail.Send",
        "MailboxSettings.ReadWrite",
      ],
      "microsoft-outlook-calendar": ["User.Read", "Calendars.ReadWrite"],
      "microsoft-contacts": ["User.Read", "Contacts.ReadWrite", "People.Read"],
      "microsoft-todo": ["User.Read", "Tasks.ReadWrite"],
      "microsoft-onedrive": ["User.Read", "Files.ReadWrite.All"],
      "microsoft-onenote": ["User.Read", "Notes.ReadWrite"],
      "microsoft-teams-chat": ["User.Read", "Chat.ReadWrite"],
    } as const;
    const identityScopes = ["offline_access", "openid", "profile", "email"];

    for (const [id, integrationScopes] of Object.entries(expectedScopes)) {
      const definition = getIntegrationDefinition(id);
      const oauth = definition?.authMethods.find((method) => method.kind === "oauth");
      expect(oauth?.kind === "oauth" ? oauth.oauth.scopes : []).toEqual([
        ...identityScopes,
        ...integrationScopes,
      ]);
      expect(oauth?.kind === "oauth" ? oauth.oauth.idTokenValidation : undefined).toBe("ignore");
    }
  });

  it("contains all requested definitions with unique ids", () => {
    const ids = integrationDefinitions.map((definition) => definition.id);
    expect(ids).toHaveLength(60);
    expect(ids).not.toContain("slack-mcp");
    expect(ids).toEqual(
      expect.arrayContaining([
        "google-gmail",
        "apple-messages",
        "apple-contacts",
        "apple-calendar",
        "apple-reminders",
        "iphone-location",
        "iphone-photos",
        "macos-app",
        "android-phone",
        "slack",
        "github",
        "figma-rest",
        "stripe-rest",
        "spotify-rest",
        "digitalocean-rest",
        "microsoft-outlook-mail",
        "microsoft-outlook-calendar",
        "github-graphql",
        "anilist-graphql",
        "cloudflare-mcp",
      ]),
    );
    expect(ids).not.toEqual(expect.arrayContaining(["petstore", "emulate-mcp", "chrome-devtools"]));
    expect(new Set(integrationDefinitions.map((definition) => definition.id)).size).toBe(
      integrationDefinitions.length,
    );
  });

  it("validates every definition and its adapter-owned config without network access", () => {
    for (const definition of integrationDefinitions) {
      expect(() => IntegrationDefinitionSchema.parse(definition)).not.toThrow();
      if (definition.adapter === "openapi") {
        expect(() => openApiAdapter.parseConfig(definition.config)).not.toThrow();
      } else if (definition.adapter === "graphql") {
        expect(() => graphqlAdapter.parseConfig(definition.config)).not.toThrow();
      } else if (definition.adapter === "mcp") {
        expect(() => mcpAdapter.parseConfig(definition.config)).not.toThrow();
      } else if (definition.adapter === "computer") {
        expect(() => parseComputerAppConfig(definition)).not.toThrow();
      } else {
        throw new Error(`Unexpected first-party adapter ${definition.adapter}`);
      }
    }
  });

  it("keeps provider authorization fixed in each definition", () => {
    for (const definition of integrationDefinitions) {
      for (const method of definition.authMethods) {
        if (method.kind === "oauth") {
          expect(method.oauth.scopes).toEqual([...new Set(method.oauth.scopes)]);
        }
      }
    }
  });

  /**
   * A GUI computer app publishes exactly the two operations a model may reach.
   * Sessions, permissions, the picker and app resolution travel on the same
   * frame but are the Host's own, and a definition that listed them would put
   * a session id and an app identity in a model's arguments.
   */
  it("publishes only observe and act for the GUI computer app", () => {
    const definition = getIntegrationDefinition("macos-app");
    if (!definition) throw new Error("The catalog must define macos-app");
    const config = parseComputerAppConfig(definition);
    expect(config.kind).toBe("gui");
    expect(config.operations.map(({ effect, name }) => [name, effect])).toEqual([
      ["observe", "read"],
      ["act", "write"],
    ]);
    const act = config.operations.find(({ name }) => name === "act");
    expect(act?.inputSchema).toMatchObject({
      properties: { window: { type: "string" }, snapshot: { type: ["string", "null"] } },
      required: ["window", "snapshot", "actions"],
      additionalProperties: false,
    });
    const observe = config.operations.find(({ name }) => name === "observe");
    for (const operation of ["windows", "bind", "observe"])
      expect(validateJsonSchema(observe?.inputSchema, { operation })).toEqual([]);
    expect(validateJsonSchema(observe?.inputSchema, {})).not.toEqual([]);
    expect(
      validateJsonSchema(observe?.inputSchema, { operation: "observe", extra: true }),
    ).not.toEqual([]);
    for (const row of config.operations) expect(row.description).toContain("computer tool");
    expect(config.platforms).toEqual(["darwin"]);
    expect(config.accessLabels).toEqual({ read: "Can see", readWrite: "Can see and control" });
    expect(
      validateJsonSchema(act?.inputSchema, {
        window: "window-1",
        snapshot: null,
        actions: [{ type: "key", keys: "cmd+s" }],
      }),
    ).toEqual([]);
    expect(
      validateJsonSchema(act?.inputSchema, {
        window: "window-1",
        snapshot: null,
        actions: [{ type: "wait", ms: 1 }],
      }),
    ).not.toEqual([]);
    expect(
      validateJsonSchema(act?.inputSchema, {
        observationId: "obs-1",
        actions: [{ type: "key", keys: "cmd+s" }],
      }),
    ).not.toEqual([]);
    const messages = getIntegrationDefinition("apple-messages");
    if (!messages) throw new Error("The catalog must define apple-messages");
    expect(parseComputerAppConfig(messages).kind).toBeUndefined();
  });

  it("asks Gmail for no more than the mailbox work its tools perform", () => {
    const gmail = getIntegrationDefinition("google-gmail");
    const gmailOAuth = gmail?.authMethods.find((method) => method.kind === "oauth");
    expect(gmailOAuth?.kind === "oauth" ? gmailOAuth.oauth.scopes : []).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
  });

  it("classifies Notion search as read despite its POST transport", async () => {
    const notion = getIntegrationDefinition("notion");
    if (!notion) throw new Error("The catalog must define notion");
    const { tools } = await openApiAdapter.resolveTools({ config: notion.config });
    expect(tools.find(({ name }) => name === "search.postOperation")?.annotations).toEqual({
      destructiveHint: false,
      readOnlyHint: true,
    });
  });

  /**
   * gmail.modify cannot permanently delete or read settings, so publishing those
   * methods would expose tools that can only ever answer 403. The definition has
   * to drop them from the document it compiles, not merely narrow the consent.
   */
  it("publishes no Gmail operation its narrowed scope could not perform", () => {
    const gmail = getIntegrationDefinition("google-gmail");
    if (!gmail) throw new Error("The catalog must define google-gmail");
    const configured = OpenApiAdapterConfigSchema.parse(gmail.config).googleDiscovery?.services[0];
    if (!configured) throw new Error("google-gmail must compile from a Google Discovery service");
    // The schema types every policy field as optional; the hint the converter
    // takes declares them present-or-absent, so each one is carried explicitly.
    const service: GoogleService = {
      service: configured.service,
      version: configured.version,
      ...(configured.blockedMethodIds ? { blockedMethodIds: configured.blockedMethodIds } : {}),
      ...(configured.blockedMethodPrefixes
        ? { blockedMethodPrefixes: configured.blockedMethodPrefixes }
        : {}),
      ...(configured.blockedMethodSubstrings
        ? { blockedMethodSubstrings: configured.blockedMethodSubstrings }
        : {}),
      ...(configured.consentScopes ? { consentScopes: configured.consentScopes } : {}),
    };

    const converted = convertGoogleDiscoveryDocument(gmailDiscoveryDocument, service);
    const operations = Object.values(converted.paths as Record<string, Record<string, unknown>>)
      .flatMap((path) => Object.values(path))
      .map((operation) => (operation as { readonly operationId: string }).operationId);

    expect(operations).toEqual(["gmail.users.messages.list", "gmail.users.messages.trash"]);
    expect(operations).not.toContain("gmail.users.messages.delete");
    expect(operations).not.toContain("gmail.users.messages.batchDelete");
    expect(operations).not.toContain("gmail.users.threads.delete");
    expect(operations).not.toContain("gmail.users.settings.getVacation");
    // What survives is authorized by exactly the scope the definition requests.
    const listPath = (converted.paths as Record<string, Record<string, unknown>>)[
      "/gmail/v1/users/{userId}/messages"
    ];
    if (!listPath) throw new Error("The converted document must publish the message list path");
    expect((listPath.get as { readonly security: unknown }).security).toEqual([
      { googleOAuth2: ["https://www.googleapis.com/auth/gmail.modify"] },
    ]);
  });
});

const mailboxScope = "https://mail.google.com/";
const modifyScope = "https://www.googleapis.com/auth/gmail.modify";

/** A miniature Gmail Discovery document carrying one method per blocked class. */
const gmailDiscoveryDocument = {
  auth: { oauth2: { scopes: { [modifyScope]: { description: "Modify mail" } } } },
  name: "gmail",
  resources: {
    users: {
      resources: {
        messages: {
          methods: {
            batchDelete: {
              httpMethod: "POST",
              id: "gmail.users.messages.batchDelete",
              path: "gmail/v1/users/{userId}/messages/batchDelete",
              parameters: { userId: { location: "path", required: true, type: "string" } },
              scopes: [mailboxScope],
            },
            delete: {
              httpMethod: "DELETE",
              id: "gmail.users.messages.delete",
              path: "gmail/v1/users/{userId}/messages/{id}",
              parameters: {
                id: { location: "path", required: true, type: "string" },
                userId: { location: "path", required: true, type: "string" },
              },
              scopes: [mailboxScope],
            },
            list: {
              httpMethod: "GET",
              id: "gmail.users.messages.list",
              path: "gmail/v1/users/{userId}/messages",
              parameters: { userId: { location: "path", required: true, type: "string" } },
              scopes: [mailboxScope, modifyScope],
            },
            trash: {
              httpMethod: "POST",
              id: "gmail.users.messages.trash",
              path: "gmail/v1/users/{userId}/messages/{id}/trash",
              parameters: {
                id: { location: "path", required: true, type: "string" },
                userId: { location: "path", required: true, type: "string" },
              },
              scopes: [mailboxScope, modifyScope],
            },
          },
        },
        settings: {
          methods: {
            getVacation: {
              httpMethod: "GET",
              id: "gmail.users.settings.getVacation",
              path: "gmail/v1/users/{userId}/settings/vacation",
              parameters: { userId: { location: "path", required: true, type: "string" } },
              scopes: ["https://www.googleapis.com/auth/gmail.settings.basic"],
            },
          },
        },
        threads: {
          methods: {
            delete: {
              httpMethod: "DELETE",
              id: "gmail.users.threads.delete",
              path: "gmail/v1/users/{userId}/threads/{id}",
              parameters: {
                id: { location: "path", required: true, type: "string" },
                userId: { location: "path", required: true, type: "string" },
              },
              scopes: [mailboxScope],
            },
          },
        },
      },
    },
  },
  rootUrl: "https://gmail.googleapis.com/",
  servicePath: "",
  version: "v1",
};
