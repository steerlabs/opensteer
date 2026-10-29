import { IntegrationDefinitionSchema } from "@opensteer/integration-core";
import { bearerAccessToken } from "./helpers.js";

const servicePolicy = {
  "identity.read": { operations: ["users/get-authenticated-user"], scopes: [] },
  "repositories.read": {
    operations: [
      "repos/get",
      "repos/list-for-authenticated-user",
      "issues/list-for-repo",
      "pulls/list",
    ],
    scopes: [],
  },
  "repositories.write": {
    operations: [
      "issues/create",
      "issues/create-comment",
      "pulls/create",
      "repos/create-or-update-file-contents",
    ],
    scopes: [],
  },
} as const;

export const githubIntegration = IntegrationDefinitionSchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "github-app",
      kind: "oauth",
      label: "Authorize GitHub App",
      placements: [bearerAccessToken],
      oauth: {
        authorizationUrl: "https://github.com/login/oauth/authorize",
        clientAuth: "body",
        tokenUrl: "https://github.com/login/oauth/access_token",
        usesPkce: true,
        scopeSeparator: " ",
        scopes: [],
        identity: {
          accountIdentifierPath: "login",
          source: "userinfo",
          userinfoUrl: "https://api.github.com/user",
          identityPath: "id",
          displayNamePath: "login",
        },
        revocation: {
          clientAuth: "basic",
          method: "delete-json",
          tokenField: "access_token",
          tokenSource: "access-token",
          url: "https://api.github.com/applications/{clientId}/token",
        },
      },
    },
  ],
  config: {
    specUrl:
      "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    baseUrl: "https://api.github.com",
    operationFilter: {
      include: [
        { operationId: Object.values(servicePolicy).flatMap((mapping) => mapping.operations) },
      ],
    },
    healthCheck: {
      accountIdentifierPath: "login",
      operationId: "users/get-authenticated-user",
      identityPath: "id",
      displayNamePath: "login",
    },
  },
  description: "Work with repositories, issues, pull requests, and the signed-in GitHub identity.",
  hostedOAuth: {
    providerApplicationRevision: 1,
    qualification: { authorizationCodeExchange: true, refresh: true },
  },
  id: "github",
  name: "GitHub REST",
  provider: "github",
  setupUrl: "https://github.com/settings/apps/new",
});
