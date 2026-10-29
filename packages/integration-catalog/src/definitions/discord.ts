import { IntegrationDefinitionSchema } from "@opensteer/integration-core";
import { bearerAccessToken } from "./helpers.js";

const servicePolicy = {
  "identity.read": { operations: ["get-current-user"], scopes: ["identify", "email"] },
  "guilds.read": { operations: ["list-current-user-guilds"], scopes: ["guilds"] },
} as const;

const discordSpec = {
  openapi: "3.1.0",
  info: { title: "Discord User API", version: "10" },
  servers: [{ url: "https://discord.com/api/v10" }],
  paths: {
    "/users/@me": {
      get: {
        operationId: "get-current-user",
        responses: {
          "200": {
            description: "Current user",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string" },
                    id: { type: "string" },
                    username: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/users/@me/guilds": {
      get: {
        operationId: "list-current-user-guilds",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } },
        ],
        responses: { "200": { description: "Guilds" } },
      },
    },
  },
} as const;

export const discordIntegration = IntegrationDefinitionSchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "oauth",
      kind: "oauth",
      label: "Discord OAuth",
      placements: [bearerAccessToken],
      oauth: {
        authorizationUrl: "https://discord.com/oauth2/authorize",
        clientAuth: "body",
        extraAuthorizeParams: { prompt: "consent" },
        tokenUrl: "https://discord.com/api/oauth2/token",
        usesPkce: false,
        scopeSeparator: " ",
        scopes: [...new Set(Object.values(servicePolicy).flatMap((value) => value.scopes))],
        identity: {
          accountIdentifierPath: "email",
          source: "userinfo",
          userinfoUrl: "https://discord.com/api/v10/users/@me",
          identityPath: "id",
          displayNamePath: "username",
        },
        revocation: {
          clientAuth: "body",
          method: "post-form",
          tokenField: "token",
          tokenSource: "refresh-token-preferred",
          url: "https://discord.com/api/v10/oauth2/token/revoke",
        },
      },
    },
  ],
  config: {
    inline: discordSpec,
    healthCheck: {
      accountIdentifierPath: "email",
      operationId: "get-current-user",
      identityPath: "id",
      displayNamePath: "username",
    },
  },
  description: "Read the signed-in Discord identity and basic server memberships.",
  hostedOAuth: {
    providerApplicationRevision: 1,
    qualification: { authorizationCodeExchange: true, refresh: true },
  },
  id: "discord",
  name: "Discord",
  provider: "discord",
  setupUrl: "https://discord.com/developers/applications",
});
