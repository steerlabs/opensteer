import { IntegrationDefinitionSchema } from "@opensteer/integration-core";
import { bearerAccessToken } from "./helpers.js";

const servicePolicy = {
  "identity.read": { operations: ["auth.test", "users.info"], scopes: ["users:read"] },
  "channel.messages": {
    operations: [
      "conversations.history",
      "conversations.list",
      "chat.postMessage",
      "chat.scheduleMessage",
    ],
    scopes: [
      "channels:history",
      "channels:read",
      "chat:write",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "mpim:history",
      "mpim:read",
    ],
  },
  "channel.threads": {
    operations: ["conversations.replies"],
    scopes: ["channels:history", "groups:history", "im:history", "mpim:history"],
  },
} as const;

const slackSpec = {
  openapi: "3.1.0",
  info: { title: "Slack Web API", version: "1" },
  servers: [{ url: "https://slack.com/api" }],
  paths: {
    "/auth.test": {
      post: {
        operationId: "auth.test",
        responses: {
          "200": {
            description: "OK",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/users.info": {
      get: {
        operationId: "users.info",
        parameters: [{ name: "user", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/conversations.list": {
      get: { operationId: "conversations.list", responses: { "200": { description: "OK" } } },
    },
    "/conversations.history": {
      get: {
        operationId: "conversations.history",
        parameters: [{ name: "channel", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/conversations.replies": {
      get: {
        operationId: "conversations.replies",
        parameters: [
          { name: "channel", in: "query", required: true, schema: { type: "string" } },
          { name: "ts", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/chat.postMessage": {
      post: {
        operationId: "chat.postMessage",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["channel", "text"],
                properties: {
                  channel: { type: "string" },
                  text: { type: "string" },
                  thread_ts: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "OK" } },
      },
    },
    "/chat.scheduleMessage": {
      post: {
        operationId: "chat.scheduleMessage",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "OK" } },
      },
    },
  },
} as const;

export const slackIntegration = IntegrationDefinitionSchema.parse({
  adapter: "openapi",
  authMethods: [
    {
      id: "oauth",
      kind: "oauth",
      label: "Install Slack app",
      placements: [bearerAccessToken],
      oauth: {
        authorizationUrl: "https://slack.com/oauth/v2/authorize",
        clientAuth: "body",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        tokenResponseProfile: "slack-bot",
        usesPkce: false,
        scopeSeparator: ",",
        scopes: [...new Set(Object.values(servicePolicy).flatMap((value) => value.scopes))],
        identity: {
          source: "token-response",
          identityPath: "bot_user_id",
          tenantPath: "team.id",
          displayNamePath: "team.name",
        },
        revocation: {
          clientAuth: "none",
          errorPath: "error",
          ignoredErrors: ["token_revoked"],
          method: "post-form",
          successPath: "ok",
          tokenField: "token",
          tokenSource: "access-token",
          url: "https://slack.com/api/auth.revoke",
        },
      },
    },
  ],
  config: {
    responseProfile: "slack",
    inline: slackSpec,
    healthCheck: {
      operationId: "auth.test",
      identityPath: "user_id",
      tenantPath: "team_id",
      displayNamePath: "user",
    },
  },
  description: "Read conversations and post messages in Slack workspaces.",
  hostedOAuth: {
    providerApplicationRevision: 1,
    qualification: { authorizationCodeExchange: true, refresh: true },
  },
  id: "slack",
  name: "Slack",
  provider: "slack",
  setupUrl: "https://api.slack.com/apps",
});
