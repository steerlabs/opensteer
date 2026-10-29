import { describe, expect, it } from "vitest";
import { createIntegrationId, type IntegrationDashboard } from "@opensteer/integration-core";
import {
  authorizationConnection,
  canSetUpOwnApp,
  connectAvailability,
  connectChoiceAvailable,
  connectOption,
  connectSavedSource,
  connectSignInOptions,
  connectedAccount,
  initialConnectSource,
  manageableApplication,
} from "./connect-selection.js";

const hosted = {
  brokerIssuer: "https://oauth.opensteer.test",
  kind: "hosted-oauth" as const,
  providerApplicationRevision: 1,
};

const personalAppId = createIntegrationId("providerApplication");
const sharedAppId = createIntegrationId("providerApplication");

const personalSource = {
  callbackUrl: "https://deployment.test/v1/integrations/oauth/callback/slack",
  kind: "deployment-oauth" as const,
  providerApplicationId: personalAppId,
  providerApplicationRevision: 3,
};
const sharedSource = {
  ...personalSource,
  providerApplicationId: sharedAppId,
  providerApplicationRevision: 1,
};

describe("connectSignInOptions", () => {
  it("offers Opensteer only when the Host advertises a hosted source", () => {
    const withoutHosted = connectSignInOptions(dashboard({ sources: [personalSource] }), "slack");
    const withHosted = connectSignInOptions(dashboard({ sources: [hosted] }), "slack");

    expect(withoutHosted.map(({ label }) => label)).toEqual(["Mattress Deal Finder Bot"]);
    expect(withHosted.map(({ label }) => label)).toEqual(["Opensteer"]);
  });
});

describe("initialConnectSource", () => {
  it("starts on the source the Host selected", () => {
    const source = initialConnectSource(
      dashboard({ selected: hosted, sources: [hosted, personalSource] }),
      "slack",
    );

    expect(source).toEqual(hosted);
  });

  it("preselects nothing when several apps are eligible and none is the default", () => {
    expect(
      initialConnectSource(dashboard({ sources: [personalSource, sharedSource] }), "slack"),
    ).toBeNull();
  });

  it("never preselects a sole eligible app the Host did not select", () => {
    // A missing saved default and a managed outage both leave the selection
    // null with one custom app still eligible; choosing it here would connect
    // through an app nobody picked.
    expect(initialConnectSource(dashboard({ sources: [personalSource] }), "slack")).toBeNull();
    expect(
      initialConnectSource(
        dashboard({
          code: "HOSTED_OAUTH_TEMPORARILY_UNAVAILABLE",
          hostedOAuthStatus: "temporarily-unavailable",
          sources: [personalSource],
        }),
        "slack",
      ),
    ).toBeNull();
  });

  it("ignores a selection the Host no longer offers", () => {
    expect(
      initialConnectSource(dashboard({ selected: hosted, sources: [personalSource] }), "slack"),
    ).toBeNull();
  });
});

describe("connectAvailability", () => {
  it("offers custom setup only when the Host supplies a usable callback on this surface", () => {
    const available = dashboard({ code: "ACCOUNT_LINK_REQUIRED" });
    expect(canSetUpOwnApp({ ...available, callbackUrls: {} }, "slack")).toBe(false);
    expect(canSetUpOwnApp(dashboard({ code: "CANONICAL_SURFACE_REQUIRED" }), "slack")).toBe(false);
    expect(canSetUpOwnApp(available, "slack")).toBe(true);
  });

  it("is ready whenever an eligible app exists, whatever the selection code says", () => {
    const value = connectAvailability(
      dashboard({
        code: "ACCOUNT_LINK_OR_PROVIDER_APPLICATION_REQUIRED",
        sources: [personalSource, sharedSource],
      }),
      "slack",
    );

    expect(value).toEqual({ kind: "ready" });
  });

  it("distinguishes missing configuration from a withdrawn app", () => {
    expect(
      connectAvailability(dashboard({ code: "PROVIDER_APPLICATION_REQUIRED" }), "slack"),
    ).toEqual({
      canSetUpOwnApp: true,
      detail: "Configure and enable this deployment's OAuth application",
      kind: "setup-required",
    });
    expect(connectAvailability(dashboard({ code: "OAUTH_SOURCE_UNAVAILABLE" }), "slack").kind).toBe(
      "source-unavailable",
    );
  });

  it("keeps the Personal remote boundary even when an app is eligible", () => {
    expect(
      connectAvailability(
        dashboard({ code: "CANONICAL_SURFACE_REQUIRED", sources: [personalSource] }),
        "slack",
      ).kind,
    ).toBe("other-surface");
  });
});

describe("connectChoiceAvailable", () => {
  it("refuses to fall back when the chosen app stops being offered", () => {
    const options = connectSignInOptions(dashboard({ sources: [hosted] }), "slack");

    expect(connectChoiceAvailable(options, personalSource)).toBe(false);
    expect(connectChoiceAvailable(options, hosted)).toBe(true);
  });
});

describe("manageableApplication", () => {
  it("offers editing only for an app this person may manage", () => {
    const options = connectSignInOptions(
      dashboard({ sources: [personalSource, sharedSource] }),
      "slack",
    );

    expect(manageableApplication(connectOption(options, personalSource))?.id).toBe(personalAppId);
    expect(manageableApplication(connectOption(options, sharedSource))).toBeNull();
    expect(manageableApplication(null)).toBeNull();
  });
});

describe("connectSavedSource", () => {
  it("finds the saved app by its own identity when two apps share a client id", () => {
    const twinId = createIntegrationId("providerApplication");
    const twinSource = {
      ...personalSource,
      providerApplicationId: twinId,
      providerApplicationRevision: 1,
    };
    const base = dashboard({ sources: [personalSource, twinSource] });
    // Both registrations carry the same name and client id, as two copies of
    // one Slack app legitimately do.
    const twin = {
      ...base.applications[0]!,
      id: twinId,
      revision: 1,
    };

    const source = connectSavedSource(
      { ...base, applications: [...base.applications, twin] },
      {
        id: twinId,
        provider: "slack",
        revision: 1,
      },
    );

    expect(source).toEqual(twinSource);
  });

  it("has no source for a revision the Host no longer offers", () => {
    expect(
      connectSavedSource(dashboard({ sources: [personalSource] }), {
        id: personalAppId,
        provider: "slack",
        revision: 9,
      }),
    ).toBeNull();
  });
});

describe("connectedAccount", () => {
  it("counts only a connected row as an account", () => {
    const connectionId = createIntegrationId("connection");
    const base = dashboard({});

    expect(connectedAccount(base, null)).toBeNull();
    expect(
      connectedAccount(
        { ...base, connections: [connection(connectionId, "needs-attention")] },
        connectionId,
      ),
    ).toBeNull();
    expect(
      connectedAccount(
        { ...base, connections: [connection(connectionId, "connected")] },
        connectionId,
      )?.id,
    ).toBe(connectionId);
  });
});

describe("authorizationConnection", () => {
  it("admits only a row waiting for provider permissions before connected", () => {
    const connectionId = createIntegrationId("connection");
    const slack = connection(connectionId, "needs-attention");
    const github = { ...slack, provider: "github" } as typeof slack;
    const waiting = { ...github, statusReason: "permissions" } as typeof slack;
    const base = dashboard({});

    expect(authorizationConnection({ ...base, connections: [slack] }, connectionId)).toBeNull();
    expect(authorizationConnection({ ...base, connections: [github] }, connectionId)).toBeNull();
    expect(authorizationConnection({ ...base, connections: [waiting] }, connectionId)?.id).toBe(
      connectionId,
    );
  });
});

function connection(id: string, status: "connected" | "needs-attention") {
  return {
    accountIdentifier: "oversteer",
    applicationSource: hosted,
    authMethodId: "oauth",
    authorizationDigest: "a".repeat(43),
    connectionMethod: "managed-oauth",
    createdAt: "2026-09-17T00:00:00.000Z",
    definitionId: "slack",
    displayName: "Oversteer",
    externalIdentityId: "bot",
    externalTenantId: "T01",
    grantedScopes: ["chat:write"],
    id,
    provider: "slack",
    providerApplicationId: null,
    status,
    statusDetail: null,
    statusReason: null,
    updatedAt: "2026-09-17T00:00:00.000Z",
  } as unknown as IntegrationDashboard["connections"][number];
}

function dashboard(input: {
  readonly code?: IntegrationDashboard["providerAuthorizations"]["slack"]["code"];
  readonly hostedOAuthStatus?: IntegrationDashboard["providerAuthorizations"]["slack"]["hostedOAuthStatus"];
  readonly selected?: IntegrationDashboard["providerAuthorizations"]["slack"]["selectedSource"];
  readonly sources?: IntegrationDashboard["providerAuthorizations"]["slack"]["availableSources"];
}): IntegrationDashboard {
  const sources = input.sources ?? [];
  const selected = input.selected ?? null;
  return {
    applications: [
      application({ availability: "personal", canManage: true, id: personalAppId, revision: 3 }),
      application({ availability: "deployment", canManage: false, id: sharedAppId, revision: 1 }),
    ],
    authorizationSurface: "canonical",
    callbackUrls: { slack: "https://deployment.test/v1/integrations/oauth/callback/slack" },
    connections: [],
    hostedOAuthDisclosure: "Opensteer brokers the authorization only.",
    isAdministrator: false,
    providerAuthorizations: {
      slack: {
        availableSources: sources,
        code: input.code ?? (selected ? "READY" : "PROVIDER_APPLICATION_REQUIRED"),
        hostedOAuthStatus: input.hostedOAuthStatus ?? "available",
        detail: input.code
          ? detailFor(input.code)
          : selected
            ? "Ready to connect"
            : detailFor("PROVIDER_APPLICATION_REQUIRED"),
        selectedSource: selected,
        selectedSourceKind: selected?.kind ?? null,
      },
    },
    providers: [manifest()],
  } as unknown as IntegrationDashboard;
}

function detailFor(code: string): string {
  switch (code) {
    case "PROVIDER_APPLICATION_REQUIRED":
      return "Configure and enable this deployment's OAuth application";
    case "OAUTH_SOURCE_UNAVAILABLE":
      return "The selected hosted OAuth service is unavailable";
    case "CANONICAL_SURFACE_REQUIRED":
      return "Finish this on the computer running this deployment";
    case "HOSTED_OAUTH_TEMPORARILY_UNAVAILABLE":
      return "Opensteer hosted OAuth did not answer";
    default:
      return "Link Opensteer Account or configure this deployment's OAuth application";
  }
}

function application(input: {
  readonly availability: "deployment" | "personal";
  readonly canManage: boolean;
  readonly id: string;
  readonly revision: number;
}) {
  return {
    availability: input.availability,
    callbackUrl: "https://deployment.test/v1/integrations/oauth/callback/slack",
    canManage: input.canManage,
    clientId: "1234567890.987",
    configuredSecretFields: ["clientSecret"],
    createdAt: "2026-09-17T00:00:00.000Z",
    displayName:
      input.availability === "personal" ? "Mattress Deal Finder Bot" : "Deployment Slack",
    id: input.id,
    ownerUserId: input.availability === "personal" ? "usr_1" : null,
    provider: "slack",
    revision: input.revision,
    status: "active",
    updatedAt: "2026-09-17T00:00:00.000Z",
  } as unknown as IntegrationDashboard["applications"][number];
}

function manifest() {
  return {
    description: "Slack apps",
    hostedOAuthCapable: true,
    label: "Slack",
    provider: "slack",
    secretFields: ["clientSecret"],
    setupLabel: "Slack app",
    setupSteps: ["Create an app from a manifest."],
    setupUrl: "https://api.slack.com/apps",
  } as unknown as IntegrationDashboard["providers"][number];
}
