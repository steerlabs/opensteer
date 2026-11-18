import type { HostedOAuthProviderApplication } from "./hosted-oauth-provider-registry.js";

/** The reviewed OAuth configurations the broker tests register, one per provider. */
const providers: Readonly<
  Record<string, Pick<HostedOAuthProviderApplication, "oauth" | "allowedScopes">>
> = {
  google: {
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      clientAuth: "body",
      extraAuthorizeParams: {
        access_type: "offline",
        prompt: "consent",
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
      scopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"],
      tokenUrl: "https://oauth2.googleapis.com/token",
      usesPkce: true,
    },
    allowedScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/forms.body",
      "https://www.googleapis.com/auth/forms.responses.readonly",
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/contacts.other.readonly",
      "https://www.googleapis.com/auth/directory.readonly",
      "https://www.googleapis.com/auth/user.addresses.read",
      "https://www.googleapis.com/auth/user.birthday.read",
      "https://www.googleapis.com/auth/user.emails.read",
      "https://www.googleapis.com/auth/user.gender.read",
      "https://www.googleapis.com/auth/user.organization.read",
      "https://www.googleapis.com/auth/user.phonenumbers.read",
    ],
  },
  microsoft: {
    oauth: {
      authorizationUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      clientAuth: "body",
      idTokenValidation: "ignore",
      scopeAliases: {
        "User.Read": ["https://graph.microsoft.com/User.Read"],
      },
      scopeSeparator: " ",
      scopes: ["offline_access", "openid", "profile", "email", "User.Read"],
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      usesPkce: true,
    },
    allowedScopes: [
      "offline_access",
      "openid",
      "profile",
      "email",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "MailboxSettings.ReadWrite",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      "People.Read",
      "Tasks.ReadWrite",
      "Files.ReadWrite.All",
      "Notes.ReadWrite",
      "Chat.ReadWrite",
    ],
  },
  slack: {
    oauth: {
      authorizationUrl: "https://slack.com/oauth/v2/authorize",
      clientAuth: "body",
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
      scopeSeparator: ",",
      scopes: [
        "users:read",
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
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      tokenResponseProfile: "slack-bot",
      usesPkce: false,
    },
    allowedScopes: [
      "users:read",
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
  github: {
    oauth: {
      authorizationUrl: "https://github.com/login/oauth/authorize",
      clientAuth: "body",
      revocation: {
        clientAuth: "basic",
        method: "delete-json",
        tokenField: "access_token",
        tokenSource: "access-token",
        url: "https://api.github.com/applications/{clientId}/token",
      },
      scopeSeparator: " ",
      scopes: [],
      tokenUrl: "https://github.com/login/oauth/access_token",
      usesPkce: true,
    },
    allowedScopes: [],
  },
  discord: {
    oauth: {
      authorizationUrl: "https://discord.com/oauth2/authorize",
      clientAuth: "body",
      extraAuthorizeParams: {
        prompt: "consent",
      },
      revocation: {
        clientAuth: "body",
        method: "post-form",
        tokenField: "token",
        tokenSource: "refresh-token-preferred",
        url: "https://discord.com/api/v10/oauth2/token/revoke",
      },
      scopeSeparator: " ",
      scopes: ["identify", "email", "guilds"],
      tokenUrl: "https://discord.com/api/oauth2/token",
      usesPkce: false,
    },
    allowedScopes: ["identify", "email", "guilds"],
  },
};

export function brokerProviderFixture(
  provider: string,
): Pick<HostedOAuthProviderApplication, "oauth" | "allowedScopes"> {
  const fixture = providers[provider];
  if (!fixture) throw new Error(`Missing OAuth fixture for ${provider}`);
  return fixture;
}
