import { describe, expect, it } from "vitest";
import { mainAccessDetail, type LoadedAccessRequest } from "./access-request.js";
import { mockMessagesDefinition, mockTmdbProposal } from "../mock/mock-integration-fixtures.js";
import { collapsedAccountRows, connectCard } from "./connect-card.js";

const workspace = { kind: "main", name: "Main" } as const;
const project = { kind: "project", name: "Launch" } as const;
const source = {
  kind: "hosted-oauth",
  brokerIssuer: "https://account.test",
  providerApplicationRevision: 1,
};
function loaded(
  kind: "provider" | "api-key" | "computer" | "mcp-oauth" | "none" = "provider",
  count = 0,
): LoadedAccessRequest {
  const connections = Array.from({ length: count }, (_, i) => ({
    id: `account-${i}`,
    definitionId: "gmail",
    accountIdentifier: `you${i}@gmail.com`,
    displayName: "Personal",
    createdAt: "2026-01-01T00:00:00Z",
    status: "connected",
    computer: kind === "computer" ? { access: "read", runnerId: "runner" } : null,
  }));
  return {
    request: {
      kind: "integration.access",
      access: "read",
      reason: "Read the latest message",
      installationId: "installation",
      requestedServerId: "server",
      requestedConnectionId: null,
      manifest: null,
    },
    dashboard: {
      connections,
      applications: [],
      providers: [],
      isAdministrator: true,
      callbackUrls: {},
      providerAuthorizations: {
        google: { availableSources: [source], selectedSource: source, code: "READY" },
      },
    },
    platform: {
      connections:
        kind === "mcp-oauth"
          ? connections.map((c) => ({
              ...c,
              connectionId: c.id,
              installationId: "installation",
              serverId: "server",
            }))
          : [],
      installations: [
        {
          installation: {
            id: "installation",
            title: "Gmail",
            sourceKind: "catalog",
            manifest: {
              definition: {
                id: "gmail",
                name: "Gmail",
                description: "Email",
                provider: "google",
                adapter: "openapi",
                apiKey:
                  kind === "api-key" ? { destinations: ["https://mail.test"], check: false } : null,
                authMethods:
                  kind === "api-key"
                    ? [
                        {
                          id: "key",
                          kind: "api-key",
                          label: "Key",
                          inputs: [{ variable: "key", label: "API key", secret: true }],
                          placements: [
                            { carrier: "header", name: "Authorization", variable: "key" },
                          ],
                        },
                      ]
                    : [
                        {
                          id: "oauth",
                          kind: "oauth",
                          label: "Google",
                          oauth: {
                            authorizationUrl: "https://google.test/authorize",
                            tokenUrl: "https://google.test/token",
                            clientAuth: "body",
                            identity: { identityPath: "id", source: "token-response" },
                            scopes: [],
                            usesPkce: true,
                          },
                          placements: [
                            { carrier: "header", name: "Authorization", variable: "accessToken" },
                          ],
                        },
                      ],
              },
            },
          },
          servers: [
            {
              id: "server",
              name: "Gmail",
              status: "active",
              connectionRequirement:
                kind === "provider" || kind === "api-key"
                  ? {
                      kind: "provider",
                      definitionId: "gmail",
                      provider: "google",
                      providerApplicationRequired: kind === "provider",
                    }
                  : kind === "computer"
                    ? { kind: "computer", definitionId: "gmail" }
                    : { kind },
            },
          ],
          tools: [
            { connectionId: null, serverId: "server", annotations: { readOnlyHint: true } },
            { connectionId: null, serverId: "server", annotations: { readOnlyHint: false } },
          ],
        },
      ],
    },
  } as unknown as LoadedAccessRequest;
}
function preinstall(administrator: boolean, proposal = false) {
  const value = loaded();
  const definition = value.platform.installations[0]!.installation.manifest["definition"];
  return {
    ...value,
    dashboard: { ...value.dashboard, isAdministrator: administrator },
    request: {
      ...value.request,
      installationId: null,
      manifest: proposal
        ? mockTmdbProposal.manifest
        : { kind: "catalog", definition, digest: "a".repeat(43) },
    },
  } as unknown as LoadedAccessRequest;
}

describe("connectCard", () => {
  it("discloses Main inherited changes before catalog installation", () => {
    const card = connectCard({ loaded: preinstall(true), workspace });
    expect(card.scope).toBe("All tasks in Main");
    expect(card.details).toContain(mainAccessDetail("Main", "Gmail"));
  });
  it("connects Main in one action and discloses inherited changes", () => {
    const card = connectCard({ loaded: loaded(), workspace });
    expect(card).toMatchObject({
      phase: "ask",
      title: "Connect Gmail",
      primary: { kind: "connect", label: "Connect" },
      secondary: "Not now",
      reason: "Read the latest message",
      scope: "All tasks in Main",
      source,
    });
    expect(card.details).toContain(mainAccessDetail("Main", "Gmail"));
  });
  it("connects and grants only the named project, with optional changes", () => {
    expect(connectCard({ loaded: loaded(), workspace: project })).toMatchObject({
      title: "Connect Gmail in Launch",
      primary: { label: "Connect" },
      scope: null,
      canAllowChanges: true,
      effectiveAccess: "read",
    });
    expect(connectCard({ loaded: loaded(), workspace: project }).details).toContain(
      "Only Launch gets access.",
    );
    expect(
      connectCard({ loaded: loaded(), workspace: project, allowChanges: true }).effectiveAccess,
    ).toBe("read-write");
    const original = loaded();
    const value = { ...original, request: { ...original.request, access: "read-write" as const } };
    const card = connectCard({ loaded: value, workspace: project });
    expect(card.effectiveAccess).toBe("read-write");
    expect(card.canAllowChanges).toBe(false);
    expect(card.scope).toBe("Read and write");
  });
  it.each([1, 3])("offers account rows and one Allow with %i accounts", (count) => {
    const card = connectCard({
      loaded: loaded("provider", count),
      workspace,
      selectedAccountId: "account-0",
    });
    expect(card.phase).toBe("choose-account");
    expect(card.title).toBe("Use Gmail");
    expect(card.primary).toEqual({ kind: "use", label: "Allow" });
    expect(card.accounts).toHaveLength(count);
    expect(card.accounts[0]).toMatchObject({ label: "you0@gmail.com", selected: true });
    expect(card.canConnectAnother).toBe(true);
  });
  it("preserves the selected account across model reads", () => {
    expect(
      connectCard({ loaded: loaded("provider", 3), workspace, selectedAccountId: "account-2" })
        .selectedAccount?.id,
    ).toBe("account-2");
  });
  it("says an account's identity once, and a second line only between look-alikes", () => {
    const value = loaded("provider", 3);
    value.dashboard.connections[2] = {
      ...value.dashboard.connections[2]!,
      accountIdentifier: "you0@gmail.com",
      displayName: "Work inbox",
    };
    const card = connectCard({ loaded: value, workspace });
    expect(card.accounts.map(({ label, detail }) => [label, detail])).toEqual([
      ["you0@gmail.com", "Personal"],
      ["you1@gmail.com", null],
      ["you0@gmail.com", "Work inbox"],
    ]);
    // A Request pinned to one look-alike still says which one it is.
    const pinned = { ...value, request: { ...value.request, requestedConnectionId: "account-2" } };
    expect(
      connectCard({ loaded: pinned, workspace }).accounts.map(({ label, detail }) => [
        label,
        detail,
      ]),
    ).toEqual([["you0@gmail.com", "Work inbox"]]);
  });
  it("repairs a pinned account and never offers another", () => {
    const original = loaded("provider", 2);
    let value = {
      ...original,
      request: { ...original.request, requestedConnectionId: "account-0" },
    };
    value.dashboard.connections[0] = {
      ...value.dashboard.connections[0]!,
      status: "needs-attention",
      connectionMethod: "managed-oauth",
    };
    expect(connectCard({ loaded: value, workspace, selectedAccountId: "account-1" })).toMatchObject(
      {
        primary: { label: "Reconnect you0@gmail.com" },
        canConnectAnother: false,
        selectedAccount: null,
      },
    );
    value = { ...value, request: { ...value.request, requestedConnectionId: "gone" } };
    expect(connectCard({ loaded: value, workspace })).toMatchObject({
      phase: "unavailable",
      primary: null,
    });
  });
  it.each([
    [true, "ask"],
    [false, "needs-admin"],
  ] as const)(
    "auto-installs a catalog item only with admin authority (%s)",
    (administrator, phase) => {
      const card = connectCard({ loaded: preinstall(administrator), workspace });
      expect(card.phase).toBe(phase);
      expect(card.autoInstall).toBe(true);
      expect(card.primary?.label).toBe(administrator ? "Connect" : undefined);
      if (!administrator) expect(card.error).toBe("Ask an admin to add Gmail");
    },
  );
  it("requires explicit, attributed proposal review before connecting", () => {
    const card = connectCard({ loaded: preinstall(true, true), workspace });
    expect(card.autoInstall).toBe(false);
    expect(card.primary?.kind).toBe("install");
    expect(card.installReview?.provenance).toContain("agent");
  });
  it.each([
    ["api-key", "api-key"],
    ["computer", "computer"],
  ] as const)("keeps the %s form", (kind, form) => {
    expect(connectCard({ loaded: loaded(kind), workspace })).toMatchObject({
      phase: "needs-form",
      form,
    });
  });
  it("connects MCP directly and uses existing MCP account rows", () => {
    expect(connectCard({ loaded: loaded("mcp-oauth"), workspace })).toMatchObject({
      phase: "ask",
      primary: { label: "Connect" },
    });
    expect(connectCard({ loaded: loaded("mcp-oauth", 1), workspace }).primary).toEqual({
      kind: "use",
      label: "Allow",
    });
  });
  it("requires explicit server choice, including a singleton", () => {
    const original = loaded();
    const value = { ...original, request: { ...original.request, requestedServerId: null } };
    expect(connectCard({ loaded: value, workspace })).toMatchObject({
      phase: "needs-form",
      form: "server",
      primary: { label: "Choose server" },
    });
  });
  it("keeps repositories as a readiness step", () => {
    expect(connectCard({ loaded: loaded(), workspace, repositories: true })).toMatchObject({
      phase: "needs-form",
      form: "repositories",
      primary: { label: "Recheck repository access" },
    });
  });
  it("shows connecting, failures, committed success and answered states in place", () => {
    const input = { loaded: loaded(), workspace };
    expect(connectCard({ ...input, connecting: true })).toMatchObject({
      phase: "connecting",
      primary: null,
    });
    expect(connectCard({ ...input, error: "Denied" })).toMatchObject({
      phase: "failed",
      primary: { label: "Try again" },
      error: "Denied",
    });
    expect(
      connectCard({
        ...input,
        connectedAccount: { displayName: "You", accountIdentifier: "you@gmail.com" },
      }),
    ).toMatchObject({
      phase: "connected",
      primary: null,
      success: "Gmail connected · you@gmail.com",
    });
    expect(connectCard({ ...input, answered: true }).phase).toBe("answered");
  });
  it("never silently replaces an unavailable saved sign-in source", () => {
    const value = loaded();
    value.dashboard.providerAuthorizations.google = {
      ...value.dashboard.providerAuthorizations.google!,
      selectedSource: null,
      code: "OAUTH_SOURCE_UNAVAILABLE",
      detail: "The selected app is unavailable",
      availableSources: [source],
    } as never;
    expect(connectCard({ loaded: value, workspace })).toMatchObject({
      phase: "unavailable",
      source: null,
      primary: { kind: "settings" },
    });
  });
  it("keeps the computer's own ceiling separate from a project grant", () => {
    const value = loaded("computer", 1);
    value.platform.installations[0]!.installation.manifest["definition"] = {
      ...mockMessagesDefinition,
      id: "gmail",
      name: "Gmail",
    };
    const card = connectCard({ loaded: value, workspace: project, allowChanges: true });
    expect(card).toMatchObject({
      phase: "needs-form",
      form: "computer",
      primary: { kind: "upgrade", label: "Request sending access on Personal" },
      upgrade: { runnerId: "runner" },
    });
  });
  it("keeps the Request's proposal attribution on account and grant surfaces", () => {
    const card = connectCard({ loaded: loaded(), workspace, agentProposed: true });
    expect(card.proposed).toBe(true);
  });
  it("keeps an active browser attempt ahead of a local failure", () => {
    expect(
      connectCard({
        loaded: loaded(),
        workspace,
        connecting: true,
        error: "Cancel could not be sent",
      }),
    ).toMatchObject({ phase: "connecting", primary: null, error: "Cancel could not be sent" });
  });
  it("allows a credential-free integration without inventing an account", () => {
    expect(connectCard({ loaded: loaded("none"), workspace: project })).toMatchObject({
      phase: "ask",
      title: "Use Gmail in Launch",
      primary: { kind: "use", label: "Allow" },
      accounts: [],
    });
  });
});

describe("collapsedAccountRows", () => {
  const rows = (count: number, selected = 0) =>
    Array.from({ length: count }, (_, id) => ({ id, selected: id === selected }));
  it("shows a list at most one past the limit whole", () => {
    expect(collapsedAccountRows(rows(4), 3)).toEqual({ rows: rows(4), hidden: 0 });
  });
  it("keeps the selected account on screen when the list collapses", () => {
    const collapsed = collapsedAccountRows(rows(8, 6), 3);
    expect(collapsed.hidden).toBe(5);
    expect(collapsed.rows.map(({ id }) => id)).toEqual([0, 1, 6]);
  });
});
