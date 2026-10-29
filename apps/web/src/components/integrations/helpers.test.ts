import { describe, expect, it } from "vitest";
import type {
  IntegrationConnectionSummary,
  IntegrationDashboard,
} from "@opensteer/integration-core";
import {
  catalogReadiness,
  connectionNeedsReconnect,
  definitionOf,
  type DefinedIntegration,
  type InstallationEntry,
} from "./helpers.js";

describe("catalogReadiness", () => {
  it("uses Host provider authorization instead of requiring a custom app", () => {
    expect(catalogReadiness(integration(), dashboard("READY"), null)).toEqual({
      kind: "connectable",
    });
  });

  it("keeps one-time Personal Account linking in the ordinary connect path", () => {
    expect(catalogReadiness(integration(), dashboard("ACCOUNT_LINK_REQUIRED"), null)).toEqual({
      kind: "connectable",
    });
  });

  it("opens remote Personal services to show the local-computer remedy", () => {
    expect(catalogReadiness(integration(), dashboard("CANONICAL_SURFACE_REQUIRED"), null)).toEqual({
      kind: "connectable",
    });
  });

  it("shows provider setup only when the Host requires it", () => {
    expect(
      catalogReadiness(integration(), dashboard("PROVIDER_APPLICATION_REQUIRED"), null),
    ).toEqual({
      canConfigure: true,
      kind: "admin-setup",
    });
  });

  it("keeps personal OAuth app setup connectable for a non-administrator", () => {
    const state = dashboard("PROVIDER_APPLICATION_REQUIRED");
    state.isAdministrator = false;
    state.callbackUrls.google = "https://deployment.test/v1/integrations/oauth/callback/google";
    state.providers = [{ provider: "google" }] as never;

    expect(catalogReadiness(integration(), state, null)).toEqual({ kind: "connectable" });
  });

  it("asks an installed computer app which computer, rather than for a sign-in", () => {
    expect(catalogReadiness(computerIntegration(), dashboard("READY"), null)).toEqual({
      kind: "choose-computer",
    });
  });

  it("calls a computer app ready once one computer has it on", () => {
    expect(
      catalogReadiness(
        computerIntegration(),
        {
          ...dashboard("READY"),
          connections: [computerConnection()],
        },
        null,
      ),
    ).toEqual({ kind: "ready" });
  });

  // Blocking an app is a decision the owner made, not something to repair.
  it("does not call Computer use in need of attention because an app is blocked", () => {
    expect(
      catalogReadiness(
        computerIntegration(),
        {
          ...dashboard("READY"),
          connections: [blockedComputerConnection()],
        },
        null,
      ),
    ).toEqual({ kind: "ready" });
  });

  // A disabled installation cannot run a call, so offering to connect an
  // account to it would collect a credential nothing could ever use.
  it.each(["disabled", "needs-attention"] as const)(
    "never offers a connection for a %s installation",
    (status) => {
      const inactive = integration();

      expect(
        catalogReadiness(
          {
            ...inactive,
            entry: {
              ...inactive.entry!,
              installation: { ...inactive.entry!.installation, status },
            },
          },
          dashboard("READY"),
          null,
        ),
      ).toMatchObject({ installation: { status }, kind: "inactive" });
    },
  );
});

describe("connectionNeedsReconnect", () => {
  it("leaves a connected account alone", () => {
    expect(connectionNeedsReconnect(connection(1))).toBe(false);
  });

  it("treats any non-connected status as needing the user again", () => {
    expect(connectionNeedsReconnect({ ...connection(1), status: "paused" })).toBe(true);
  });

  // An app on a computer holds no credential and pins no OAuth application, so
  // it carries no authorization digest and can never be "reconnected".
  it("never asks to reauthorize an app on a computer", () => {
    expect(connectionNeedsReconnect(computerConnection())).toBe(false);
  });

  it("never asks to repair an app its owner blocked", () => {
    expect(connectionNeedsReconnect(blockedComputerConnection())).toBe(false);
  });
});

// An installation listed without its definition loses its app words and is
// managed as a bare installation. Neither a newer Host's platforms nor an
// installation stored before definitions carried key facts may cause that.
describe("definitionOf", () => {
  const stored = {
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    computerApp: {
      accessLabels: { read: "Can read", readWrite: "Can read and change" },
      accessLevels: ["read", "read-write"],
      accessSummaries: { read: "Reads.", readWrite: "Reads and changes." },
      operations: [
        { effect: "read", name: "list_events" },
        { effect: "write", name: "create_event" },
      ],
      platforms: ["darwin"],
    },
    description: "Read and change Calendar through an enrolled Mac.",
    id: "apple-calendar",
    name: "Calendar",
    provider: "apple-calendar",
  };

  it("reads a newer Host's app, keeping the platforms this client knows", () => {
    const definition = definitionOf(
      installed({
        ...stored,
        apiKey: null,
        computerApp: { ...stored.computerApp, platforms: ["darwin", "ios", "future-phone-os"] },
      }),
    );
    expect(definition?.computerApp?.platforms).toEqual(["darwin", "ios"]);
  });

  it("still reads an installation stored before definitions carried key facts", () => {
    expect(definitionOf(installed(stored))).toMatchObject({ apiKey: null, id: "apple-calendar" });
  });

  function installed(definition: object): InstallationEntry {
    return {
      installation: { manifest: { definition, digest: "d", kind: "catalog" } },
      servers: [],
      skills: [],
      tools: [],
    } as unknown as InstallationEntry;
  }
});

function connection(pinnedRevision: number): IntegrationConnectionSummary {
  return {
    accountIdentifier: "alex@example.com",
    applicationSource: {
      brokerIssuer: "https://account.opensteer.test",
      kind: "hosted-oauth",
      providerApplicationRevision: pinnedRevision,
    },
    authMethodId: "google-oauth",
    authorizationDigest: "a".repeat(43),
    connectionMethod: "managed-oauth",
    createdAt: "2026-08-26T00:00:00.000Z",
    definitionId: "google-calendar",
    displayName: "Alex",
    externalIdentityId: "google-subject",
    externalTenantId: null,
    grantedScopes: ["openid"],
    id: "con_00000000-0000-4000-8000-000000000001",
    provider: "google",
    providerApplicationId: "ipa_00000000-0000-4000-8000-000000000001",
    status: "connected",
    statusDetail: null,
    updatedAt: "2026-08-26T00:00:00.000Z",
  } as unknown as IntegrationConnectionSummary;
}

function computerConnection(): IntegrationConnectionSummary {
  return {
    ...connection(1),
    applicationSource: null,
    authMethodId: "computer",
    authorizationDigest: null,
    computer: { access: "read", runnerId: "rnr_11111111-1111-4111-8111-111111111111" },
    connectionMethod: "computer",
    definitionId: "apple-messages",
    displayName: "Mac mini",
    provider: "apple-messages",
  } as unknown as IntegrationConnectionSummary;
}

function blockedComputerConnection(): IntegrationConnectionSummary {
  const base = computerConnection();
  return {
    ...base,
    computer: {
      ...base.computer,
      app: { bundleId: "com.apple.Safari", displayName: "Safari", teamId: "APPLECOMP1" },
      blockedAt: "2026-09-21T00:00:00.000Z",
    },
    status: "paused",
  } as unknown as IntegrationConnectionSummary;
}

function computerIntegration(): DefinedIntegration {
  return {
    definition: {
      computerApp: {
        accessLabels: { read: "Read only", readWrite: "Read and send" },
        accessLevels: ["read", "read-write"],
        accessSummaries: { read: "Reads.", readWrite: "Reads and sends." },
        platforms: ["darwin"],
      },
      id: "apple-messages",
      name: "Messages",
      provider: "apple-messages",
    },
    digest: "digest",
    entry: {
      installation: { status: "active" },
      servers: [{ connectionRequirement: { definitionId: "apple-messages", kind: "computer" } }],
      skills: [],
      tools: [],
    },
  } as unknown as DefinedIntegration;
}

function dashboard(
  code: IntegrationDashboard["providerAuthorizations"][string]["code"],
): IntegrationDashboard {
  const source = {
    brokerIssuer: "https://account.opensteer.test",
    kind: "hosted-oauth" as const,
    providerApplicationRevision: 1,
  };
  const ready = code === "READY";
  return {
    applications: [],
    authorizationSurface: "canonical",
    callbackUrls: {},
    connections: [],
    hostedOAuthDisclosure: "Managed sign-in disclosure",
    isAdministrator: true,
    providerAuthorizations: {
      google: {
        availableSources: ready ? [source] : [],
        code,
        detail: ready ? "Ready" : "Setup required",
        selectedSource: ready ? source : null,
        hostedOAuthStatus: "available",
        selectedSourceKind: ready ? "hosted-oauth" : null,
      },
    },
    providers: [],
  };
}

function integration(): DefinedIntegration {
  return {
    definition: { id: "google-calendar", provider: "google" },
    digest: "digest",
    entry: {
      installation: { status: "active" },
      servers: [
        {
          connectionRequirement: {
            kind: "provider",
            provider: "google",
            providerApplicationRequired: true,
          },
        },
      ],
      skills: [],
      tools: [],
    },
  } as unknown as DefinedIntegration;
}
