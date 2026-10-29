import { googleDiscoveryOpenApiConfig, type GoogleService } from "@opensteer/integration-adapters";
import { IntegrationDefinitionSchema } from "@opensteer/integration-core";
import { bearerAccessToken } from "./helpers.js";

const auth = (scope: string): string => `https://www.googleapis.com/auth/${scope}`;
const identityScopes = ["openid", "email", "profile"] as const;
const googleOAuth = {
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  clientAuth: "body",
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  identity: {
    accountIdentifierPath: "email",
    source: "userinfo",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    identityPath: "sub",
    displayNamePath: "name",
  },
  issuer: "https://accounts.google.com",
  revocation: {
    clientAuth: "none",
    method: "post-form",
    tokenField: "token",
    tokenSource: "refresh-token-preferred",
    url: "https://oauth2.googleapis.com/revoke",
  },
  scopeAliases: {
    email: ["https://www.googleapis.com/auth/userinfo.email"],
    profile: ["https://www.googleapis.com/auth/userinfo.profile"],
  },
  scopeSeparator: " ",
  tokenUrl: "https://oauth2.googleapis.com/token",
  usesPkce: true,
} as const;

type GooglePreset = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly service: GoogleService;
  readonly scopes: readonly string[];
  readonly healthCheck?: {
    readonly operationId: string;
    readonly args?: Readonly<Record<string, unknown>>;
    readonly identityPath: string;
    readonly displayNamePath?: string;
  };
};

const presets: readonly GooglePreset[] = [
  {
    id: "google-gmail",
    name: "Google Gmail",
    description: "Read, draft, send, and manage Gmail.",
    // gmail.modify covers read, draft, send, and label work. Permanent deletion and settings
    // methods need the mailbox-wide or settings scopes this definition no longer requests, so
    // they are blocked rather than exposed as tools that can only ever return 403.
    service: {
      service: "gmail",
      version: "v1",
      consentScopes: [auth("gmail.modify")],
      blockedMethodIds: [
        "gmail.users.messages.delete",
        "gmail.users.messages.batchDelete",
        "gmail.users.threads.delete",
      ],
      blockedMethodPrefixes: ["gmail.users.settings."],
    },
    scopes: [...identityScopes, auth("gmail.modify")],
    healthCheck: {
      operationId: "gmail.users.labels.list",
      args: { userId: "me" },
      identityPath: "labels.0.id",
      displayNamePath: "labels.0.name",
    },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Read and manage Google Calendar.",
    service: {
      service: "calendar",
      version: "v3",
      consentScopes: [auth("calendar")],
      blockedMethodIds: ["calendar.calendars.transferOwnership"],
    },
    scopes: [...identityScopes, auth("calendar")],
    healthCheck: {
      operationId: "calendar.calendarList.list",
      identityPath: "items.0.id",
      displayNamePath: "items.0.summary",
    },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Search, read, and manage Google Drive files.",
    service: {
      service: "drive",
      version: "v3",
      consentScopes: [auth("drive")],
      blockedMethodIds: ["drive.apps.list"],
    },
    scopes: [...identityScopes, auth("drive")],
    healthCheck: {
      operationId: "drive.about.get",
      args: { fields: "user" },
      identityPath: "user.permissionId",
      displayNamePath: "user.displayName",
    },
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    description: "Read and manage Google Sheets spreadsheets.",
    service: {
      service: "sheets",
      version: "v4",
      consentScopes: [auth("spreadsheets"), auth("drive.file")],
      hiddenSchemaProperties: {
        Request: [
          "addDataSource",
          "updateDataSource",
          "refreshDataSource",
          "cancelDataSourceRefresh",
        ],
      },
    },
    scopes: [...identityScopes, auth("spreadsheets"), auth("drive.file")],
  },
  {
    id: "google-docs",
    name: "Google Docs",
    description: "Read and manage Google Docs documents.",
    service: { service: "docs", version: "v1", consentScopes: [auth("documents")] },
    scopes: [...identityScopes, auth("documents")],
  },
  {
    id: "google-slides",
    name: "Google Slides",
    description: "Read and manage Google Slides presentations.",
    service: { service: "slides", version: "v1", consentScopes: [auth("presentations")] },
    scopes: [...identityScopes, auth("presentations")],
  },
  {
    id: "google-forms",
    name: "Google Forms",
    description: "Read and manage Google Forms and responses.",
    service: {
      service: "forms",
      version: "v1",
      url: "https://forms.googleapis.com/$discovery/rest?version=v1",
      consentScopes: [auth("forms.body"), auth("forms.responses.readonly")],
    },
    scopes: [...identityScopes, auth("forms.body"), auth("forms.responses.readonly")],
  },
  {
    id: "google-tasks",
    name: "Google Tasks",
    description: "Read and manage Google Tasks.",
    service: { service: "tasks", version: "v1", consentScopes: [auth("tasks")] },
    scopes: [...identityScopes, auth("tasks")],
    healthCheck: {
      operationId: "tasks.tasklists.list",
      args: { maxResults: 1 },
      identityPath: "items.0.id",
      displayNamePath: "items.0.title",
    },
  },
  {
    id: "google-people",
    name: "Google Contacts",
    description: "Read and manage Google Contacts and people profiles.",
    service: {
      service: "people",
      version: "v1",
      consentScopes: [
        auth("contacts"),
        auth("contacts.other.readonly"),
        auth("directory.readonly"),
        auth("user.addresses.read"),
        auth("user.birthday.read"),
        auth("user.emails.read"),
        auth("user.gender.read"),
        auth("user.organization.read"),
        auth("user.phonenumbers.read"),
      ],
      requiredParameters: {
        "people.people.createContact": ["personFields"],
        "people.people.get": ["personFields"],
        "people.people.getBatchGet": ["resourceNames", "personFields"],
        "people.people.connections.list": ["personFields"],
        "people.people.searchContacts": ["query", "readMask"],
        "people.people.updateContact": ["updatePersonFields"],
        "people.people.listDirectoryPeople": ["sources", "readMask"],
        "people.people.searchDirectoryPeople": ["query", "sources", "readMask"],
        "people.otherContacts.list": ["readMask"],
        "people.otherContacts.search": ["query", "readMask"],
        "people.contactGroups.batchGet": ["resourceNames"],
      },
      requiredRequestBodies: [
        "people.people.createContact",
        "people.people.batchCreateContacts",
        "people.people.batchUpdateContacts",
        "people.people.batchDeleteContacts",
        "people.people.updateContact",
        "people.people.updateContactPhoto",
        "people.contactGroups.create",
        "people.contactGroups.update",
        "people.contactGroups.members.modify",
        "people.otherContacts.copyOtherContactToMyContactsGroup",
      ],
      requiredSchemaProperties: {
        BatchCreateContactsRequest: ["contacts", "readMask"],
        BatchUpdateContactsRequest: ["contacts", "updateMask", "readMask"],
        BatchDeleteContactsRequest: ["resourceNames"],
        UpdateContactPhotoRequest: ["photoBytes"],
        CreateContactGroupRequest: ["contactGroup"],
        UpdateContactGroupRequest: ["contactGroup"],
        CopyOtherContactToMyContactsGroupRequest: ["copyMask"],
      },
    },
    scopes: [
      ...identityScopes,
      auth("contacts"),
      auth("contacts.other.readonly"),
      auth("directory.readonly"),
      auth("user.addresses.read"),
      auth("user.birthday.read"),
      auth("user.emails.read"),
      auth("user.gender.read"),
      auth("user.organization.read"),
      auth("user.phonenumbers.read"),
    ],
    healthCheck: {
      operationId: "people.people.get",
      args: { resourceName: "people/me", personFields: "emailAddresses" },
      identityPath: "resourceName",
      displayNamePath: "names.0.displayName",
    },
  },
];

function definitionFor(preset: GooglePreset) {
  return IntegrationDefinitionSchema.parse({
    adapter: "openapi",
    authMethods: [
      {
        id: "oauth",
        kind: "oauth",
        label: `Connect ${preset.name}`,
        placements: [bearerAccessToken],
        oauth: { ...googleOAuth, scopes: preset.scopes },
      },
    ],
    config: googleDiscoveryOpenApiConfig([preset.service], {
      timeoutMs: 30_000,
      ...(preset.healthCheck ? { healthCheck: preset.healthCheck } : {}),
    }),
    description: preset.description,
    hostedOAuth: {
      providerApplicationRevision: 1,
      qualification: { authorizationCodeExchange: true, refresh: true },
    },
    id: preset.id,
    name: preset.name,
    provider: "google",
    setupUrl: "https://console.cloud.google.com/apis/credentials",
  });
}

export const googleIntegrations = presets.map(definitionFor);
