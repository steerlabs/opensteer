import { IntegrationDefinitionSchema } from "@opensteer/integration-core";

const identityScopes = ["offline_access", "openid", "profile", "email"] as const;
const specUrl =
  "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml";
const setupUrl =
  "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
const bearerAccessToken = {
  carrier: "header",
  name: "Authorization",
  prefix: "Bearer ",
  variable: "accessToken",
} as const;

const presets = [
  {
    description: "Read the signed-in Microsoft profile.",
    id: "microsoft-profile",
    name: "Microsoft Profile",
    paths: ["/me"],
    scopes: ["User.Read"],
  },
  {
    description: "Read, send, and manage Outlook mail and mailbox settings.",
    id: "microsoft-outlook-mail",
    name: "Microsoft Outlook Mail",
    paths: ["/me", "/me/messages*", "/me/mailFolders*", "/me/sendMail*", "/me/mailboxSettings*"],
    scopes: ["User.Read", "Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite"],
  },
  {
    description: "Read and manage Outlook calendars and events.",
    id: "microsoft-outlook-calendar",
    name: "Microsoft Outlook Calendar",
    paths: ["/me", "/me/calendar*", "/me/calendars*", "/me/events*", "/me/findMeetingTimes*"],
    scopes: ["User.Read", "Calendars.ReadWrite"],
  },
  {
    description: "Read and manage Outlook contacts and people.",
    id: "microsoft-contacts",
    name: "Microsoft Contacts",
    paths: ["/me", "/me/contacts*", "/me/contactFolders*", "/me/people*"],
    scopes: ["User.Read", "Contacts.ReadWrite", "People.Read"],
  },
  {
    description: "Read and manage Microsoft To Do task lists and tasks.",
    id: "microsoft-todo",
    name: "Microsoft To Do",
    paths: ["/me", "/me/todo*"],
    scopes: ["User.Read", "Tasks.ReadWrite"],
  },
  {
    description: "Read and manage OneDrive files.",
    id: "microsoft-onedrive",
    name: "Microsoft OneDrive",
    paths: ["/me", "/me/drive*", "/me/drives*", "/shares*"],
    scopes: ["User.Read", "Files.ReadWrite.All"],
  },
  {
    description: "Read and manage OneNote notebooks and notes.",
    id: "microsoft-onenote",
    name: "Microsoft OneNote",
    paths: ["/me", "/me/onenote*"],
    scopes: ["User.Read", "Notes.ReadWrite"],
  },
  {
    description: "Read and manage Microsoft Teams chats.",
    id: "microsoft-teams-chat",
    name: "Microsoft Teams Chat",
    paths: ["/me", "/me/chats*", "/chats*"],
    scopes: ["User.Read", "Chat.ReadWrite"],
  },
] as const;

export const microsoftIntegrations = presets.map((preset) =>
  IntegrationDefinitionSchema.parse({
    adapter: "openapi",
    authMethods: [
      {
        id: "oauth",
        kind: "oauth",
        label: `Connect ${preset.name}`,
        placements: [bearerAccessToken],
        oauth: {
          authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
          clientAuth: "body",
          idTokenValidation: "ignore",
          identity: {
            accountIdentifierPath: "email",
            displayNamePath: "name",
            identityPath: "sub",
            source: "userinfo",
            userinfoUrl: "https://graph.microsoft.com/oidc/userinfo",
          },
          scopeAliases: Object.fromEntries(
            preset.scopes.map((scope) => [scope, [`https://graph.microsoft.com/${scope}`]]),
          ),
          scopeSeparator: " ",
          scopes: [...identityScopes, ...preset.scopes],
          tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          usesPkce: true,
        },
      },
    ],
    config: {
      baseUrl: "https://graph.microsoft.com/v1.0",
      healthCheck: {
        accountIdentifierPath: "userPrincipalName",
        displayNamePath: "displayName",
        identityPath: "id",
        method: "get",
        path: "/me",
        tenantPath: "userPrincipalName",
      },
      operationFilter: { include: preset.paths.map((path) => ({ path })) },
      specUrl,
    },
    description: preset.description,
    hostedOAuth: {
      providerApplicationRevision: 1,
      qualification: { authorizationCodeExchange: true, refresh: true },
    },
    id: preset.id,
    name: preset.name,
    provider: "microsoft",
    setupUrl,
  }),
);
