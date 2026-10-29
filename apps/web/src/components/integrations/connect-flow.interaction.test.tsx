// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIntegrationId,
  type IntegrationAuthorizationStatus,
  type IntegrationDashboard,
} from "@opensteer/integration-core";
import type { IntegrationDefinitionSummary } from "@opensteer/integration-core/adapter";
import { ConnectFlow } from "./connect-flow.js";
import type { ConnectOperations } from "./connect-operations.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const hosted = {
  brokerIssuer: "https://oauth.opensteer.test",
  kind: "hosted-oauth" as const,
  providerApplicationRevision: 1,
};
const personalAppId = createIntegrationId("providerApplication");
const personalSource = {
  callbackUrl: "https://deployment.test/v1/integrations/oauth/callback/slack",
  kind: "deployment-oauth" as const,
  providerApplicationId: personalAppId,
  providerApplicationRevision: 3,
};
const started = {
  attemptId: createIntegrationId("oauthAttempt"),
  expiresAt: "2026-09-17T00:10:00.000Z",
  launchTicket: "t".repeat(43),
};

describe("ConnectFlow", () => {
  it("does not report a connection when an app is saved", async () => {
    const operations = fakeOperations({
      reloaded: dashboard({ sources: [personalSource] }),
      saved: application({}),
    });
    render({ operations });

    await click("Use my own Slack app");
    type("App name", "Mattress Deal Finder Bot");
    type("Client ID", "1234567890.987");
    type("Client Secret", "shhh");
    await submit();

    expect(operations.saveProviderApplication).toHaveBeenCalledWith(
      expect.objectContaining({ availability: "personal", provider: "slack" }),
    );
    expect(operations.beginAuthorization).not.toHaveBeenCalled();
    expect(text()).toContain("No account is connected yet");
    expect(text()).toContain("Sign-in app: Mattress Deal Finder Bot");
    expect(text()).not.toContain("Slack is connected as");
  });

  it("selects the app the Host says it saved, not one that looks like it", async () => {
    // A second registration of the same Slack app carries the same name and
    // client id; only the Host's answer says which row was written.
    const twinId = createIntegrationId("providerApplication");
    const twin = application({ id: twinId, revision: 1 });
    const twinSource = {
      ...personalSource,
      providerApplicationId: twinId,
      providerApplicationRevision: 1,
    };
    const operations = fakeOperations({
      reloaded: dashboard({
        applications: [application({}), twin],
        sources: [personalSource, twinSource],
      }),
      saved: twin,
    });
    render({ operations });

    await click("Use my own Slack app");
    type("App name", "Mattress Deal Finder Bot");
    type("Client ID", "1234567890.987");
    type("Client Secret", "shhh");
    await submit();
    await click("Continue to Slack");

    expect(operations.beginAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ applicationSource: twinSource }),
    );
  });

  it("keeps the chosen app when a reload moves the deployment's default", async () => {
    const operations = fakeOperations({
      // Retrying the outage reloads a dashboard that now selects Opensteer; the
      // person already chose their own app for this attempt.
      reloaded: dashboard({ selected: hosted, sources: [hosted, personalSource] }),
    });
    render({
      dashboard: dashboard({
        hostedOAuthStatus: "temporarily-unavailable",
        selected: hosted,
        sources: [hosted, personalSource],
      }),
      operations,
    });

    await click("Change");
    await click("Mattress Deal Finder Bot");
    await click("Retry Opensteer sign-in");
    await click("Continue to Slack");

    expect(operations.reloadDashboard).toHaveBeenCalled();
    expect(operations.beginAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ applicationSource: personalSource }),
    );
  });

  it("makes own-app setup the action when no sign-in app is eligible", async () => {
    const operations = fakeOperations();
    render({ dashboard: dashboard({ sources: [] }), operations });

    expect(text()).toContain("Set up my own Slack app");
    // Nothing to continue to, so no dead primary action is offered.
    expect(text()).not.toContain("Continue to Slack");
    expect(text()).toContain("Opensteer sign-in is not available for Slack yet");
  });

  it("pins the app the person chose to the attempt", async () => {
    const operations = fakeOperations();
    render({
      dashboard: dashboard({ sources: [hosted, personalSource] }),
      operations,
    });

    await click("Mattress Deal Finder Bot");
    await click("Continue to Slack");

    expect(operations.beginAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ applicationSource: personalSource }),
    );
  });

  it("offers a retry for an outage instead of sending anyone to set up an app", async () => {
    const operations = fakeOperations();
    render({
      dashboard: dashboard({
        hostedOAuthStatus: "temporarily-unavailable",
        selected: hosted,
        sources: [hosted],
      }),
      operations,
    });

    expect(text()).toContain("Opensteer sign-in is temporarily unavailable");
    expect(text()).toContain("This is an outage, not missing setup");

    await click("Retry Opensteer sign-in");

    expect(operations.reloadDashboard).toHaveBeenCalled();
    expect(operations.beginAuthorization).not.toHaveBeenCalled();
  });

  it("reports a refusal as a refusal", async () => {
    const operations = fakeOperations({
      status: {
        connectionId: null,
        expiresAt: started.expiresAt,
        failureCode: null,
        status: "denied",
      },
    });
    render({ operations });

    await click("Continue to Slack");

    expect(text()).toContain("Access was not approved.");
    expect(text()).not.toContain("Slack is connected as");
  });

  it("refuses to call an attempt connected without a connection row", async () => {
    const operations = fakeOperations({
      status: {
        connectionId: createIntegrationId("connection"),
        expiresAt: started.expiresAt,
        failureCode: null,
        status: "completed",
      },
    });
    render({ operations });

    await click("Continue to Slack");

    expect(text()).toContain("no connected account is recorded here");
    expect(text()).not.toContain("Slack is connected as");
  });

  it("reports durable completion when cancellation loses the terminal race", async () => {
    const connectionId = createIntegrationId("connection");
    const operations = fakeOperations({
      cancelStatus: {
        connectionId,
        expiresAt: started.expiresAt,
        failureCode: null,
        status: "completed",
      },
      reloaded: {
        ...dashboard({ sources: [hosted], selected: hosted }),
        connections: [connection(connectionId)],
      },
    });
    const onConnected = vi.fn();
    render({ onConnected, operations });

    await click("Continue to Slack");
    await click("Cancel");

    expect(text()).toContain("Slack is connected as Oversteer");
    expect(text()).not.toContain("No account was connected");
    expect(onConnected).toHaveBeenCalledWith(connectionId);
  });

  it("waits for GitHub repository access and completes only after a successful recheck", async () => {
    const connectionId = createIntegrationId("connection");
    const operations = fakeOperations({
      repositoryAccess: [
        {
          installationUrl: "https://github.com/apps/opensteer/installations/new",
          installations: [],
          ready: false,
        },
        {
          installationUrl: "https://github.com/apps/opensteer/installations/new",
          installations: [
            {
              accountLogin: "steerlabs",
              configureUrl: "https://github.com/organizations/steerlabs/settings/installations/1",
              id: "1",
              repositoryCount: 3,
              repositorySelection: "selected",
              suspended: false,
            },
          ],
          ready: true,
        },
      ],
      reloaded: githubDashboard(githubConnection(connectionId)),
      status: {
        connectionId,
        expiresAt: started.expiresAt,
        failureCode: null,
        status: "completed",
      },
    });
    const onConnected = vi.fn();
    render({
      definition: githubDefinition(),
      dashboard: githubDashboard(),
      onConnected,
      operations,
    });

    await click("Continue to GitHub");

    expect(text()).toContain("Repository access is still required");
    expect(text()).toContain("Install GitHub App");
    expect(onConnected).not.toHaveBeenCalled();

    await click("Recheck repository access");

    expect(onConnected).toHaveBeenCalledWith(connectionId);
    expect(text()).toContain("GitHub is connected as steerlabs");
  });

  // GitHub's 401 makes the Host record a sign-in-required account; checking
  // that credential again can only be refused again.
  it("returns to sign-in when GitHub rejects the sign-in at the first check", async () => {
    const connectionId = createIntegrationId("connection");
    const operations = githubOperations(connectionId);
    vi.mocked(operations.checkRepositoryAccess).mockImplementationOnce(async () => {
      vi.mocked(operations.reloadDashboard).mockResolvedValue(
        githubDashboard(githubConnection(connectionId, signInRequired)),
      );
      throw new Error(rejectedSignIn);
    });
    const onConnected = vi.fn();
    render({
      definition: githubDefinition(),
      dashboard: githubDashboard(),
      onConnected,
      operations,
    });

    await click("Continue to GitHub");

    expect(operations.reloadDashboard).toHaveBeenCalledTimes(2);
    expect(alert()).toBe(rejectedSignIn);
    expect(text()).toContain("Connect GitHub");
    expect(buttons()).toContain("Continue to GitHub");
    expect(buttons()).not.toContain("Recheck repository access");
    expect(onConnected).not.toHaveBeenCalled();

    await click("Continue to GitHub");

    expect(operations.beginAuthorization).toHaveBeenCalledTimes(2);
  });

  it("returns to sign-in when GitHub rejects the sign-in on a recheck", async () => {
    const connectionId = createIntegrationId("connection");
    const operations = githubOperations(connectionId);
    const onConnected = vi.fn();
    render({
      definition: githubDefinition(),
      dashboard: githubDashboard(),
      onConnected,
      operations,
    });
    await click("Continue to GitHub");
    expect(text()).toContain("Repository access is still required");

    vi.mocked(operations.checkRepositoryAccess).mockImplementationOnce(async () => {
      vi.mocked(operations.reloadDashboard).mockResolvedValue(
        githubDashboard(githubConnection(connectionId, signInRequired)),
      );
      throw new Error(rejectedSignIn);
    });
    await click("Recheck repository access");

    expect(alert()).toBe(rejectedSignIn);
    expect(buttons()).toContain("Continue to GitHub");
    expect(buttons()).not.toContain("Recheck repository access");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("keeps the repository step when GitHub fails a recheck without rejecting the sign-in", async () => {
    const connectionId = createIntegrationId("connection");
    const unavailable = "GitHub repository access could not be checked. Retry in a moment.";
    const operations = githubOperations(connectionId);
    render({ definition: githubDefinition(), dashboard: githubDashboard(), operations });
    await click("Continue to GitHub");

    // A 5xx changes nothing at the Host: the account still waits for repositories.
    vi.mocked(operations.checkRepositoryAccess).mockRejectedValueOnce(new Error(unavailable));
    await click("Recheck repository access");

    expect(operations.reloadDashboard).toHaveBeenCalledTimes(2);
    expect(alert()).toBe(unavailable);
    expect(text()).toContain("Repository access is still required");
    expect(buttons()).toContain("Recheck repository access");
    expect(buttons()).not.toContain("Continue to GitHub");

    await click("Recheck repository access");

    expect(operations.checkRepositoryAccess).toHaveBeenCalledTimes(3);
  });

  it("does not complete a repository recheck after the flow closes", async () => {
    const connectionId = createIntegrationId("connection");
    let finishCheck!: (value: { installationUrl: null; installations: []; ready: true }) => void;
    const pendingCheck = new Promise<{
      installationUrl: null;
      installations: [];
      ready: true;
    }>((resolve) => {
      finishCheck = resolve;
    });
    const operations = fakeOperations({
      repositoryAccess: [{ installationUrl: null, installations: [], ready: false }],
      reloaded: githubDashboard(githubConnection(connectionId)),
      status: {
        connectionId,
        expiresAt: started.expiresAt,
        failureCode: null,
        status: "completed",
      },
    });
    vi.mocked(operations.checkRepositoryAccess)
      .mockResolvedValueOnce({ installationUrl: null, installations: [], ready: false })
      .mockImplementationOnce(() => pendingCheck);
    const onConnected = vi.fn();
    const root = render({
      definition: githubDefinition(),
      dashboard: githubDashboard(),
      onConnected,
      operations,
    });

    await click("Continue to GitHub");
    await click("Recheck repository access");
    act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => finishCheck({ installationUrl: null, installations: [], ready: true }));

    expect(onConnected).not.toHaveBeenCalled();
    expect(operations.reloadDashboard).toHaveBeenCalledTimes(1);
  });

  // The ways it could fail: Cancel loses to a sign-in that completed while
  // its first repository check was out, and the cancellation checks again.
  // The cancelled sign-in's check, refused now, sends the sheet back to
  // sign-in and frees "Continue" while the cancellation is still checking;
  // a sign-in started then is replaced by the cancellation's late answer.
  it("lets a cancellation that lost to a completed sign-in finish it alone", async () => {
    const connectionId = createIntegrationId("connection");
    const operations = githubOperations(connectionId);
    vi.mocked(operations.cancelAuthorization).mockResolvedValueOnce(completed(connectionId));
    let refuseCancelled!: (reason: Error) => void;
    let refuseRecovery!: (reason: Error) => void;
    vi.mocked(operations.checkRepositoryAccess)
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            refuseCancelled = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            refuseRecovery = reject;
          }),
      );
    render({ definition: githubDefinition(), dashboard: githubDashboard(), operations });
    await click("Continue to GitHub");
    await click("Cancel");
    expect(operations.checkRepositoryAccess).toHaveBeenCalledTimes(2);
    vi.mocked(operations.reloadDashboard).mockResolvedValue(
      githubDashboard(githubConnection(connectionId, signInRequired)),
    );

    await act(async () => refuseCancelled(new Error("The cancelled sign-in's check")));

    expect(alert()).toBeNull();
    expect(buttons()).not.toContain("Continue to GitHub");

    await act(async () => refuseRecovery(new Error(rejectedSignIn)));

    expect(alert()).toBe(rejectedSignIn);
    expect(button("Continue to GitHub").disabled).toBe(false);
  });

  // The ways it could fail: Cancel answers only after the sign-in it was
  // meant for has settled and the person has started another; the answer
  // ends the newer sign-in's wait and finishes the old one in its place.
  it("leaves a sign-in started since alone when an older Cancel answers late", async () => {
    const connectionId = createIntegrationId("connection");
    const operations = githubOperations(connectionId);
    let answerCancel!: (status: IntegrationAuthorizationStatus) => void;
    vi.mocked(operations.cancelAuthorization).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerCancel = resolve;
        }),
    );
    let refuseFirst!: (reason: Error) => void;
    vi.mocked(operations.checkRepositoryAccess).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          refuseFirst = reject;
        }),
    );
    render({ definition: githubDefinition(), dashboard: githubDashboard(), operations });
    await click("Continue to GitHub");
    await click("Cancel");
    vi.mocked(operations.reloadDashboard).mockResolvedValue(
      githubDashboard(githubConnection(connectionId, signInRequired)),
    );
    await act(async () => refuseFirst(new Error(rejectedSignIn)));
    expect(alert()).toBe(rejectedSignIn);

    let newerWait!: AbortSignal;
    vi.mocked(operations.beginAuthorization).mockResolvedValueOnce({
      ...started,
      attemptId: createIntegrationId("oauthAttempt"),
    });
    vi.mocked(operations.awaitAuthorization).mockImplementationOnce((_, signal) => {
      newerWait = signal;
      return new Promise(() => {});
    });
    await click("Continue to GitHub");
    expect(text()).toContain("Finish signing in at GitHub");

    await act(async () => answerCancel(completed(connectionId)));

    expect(newerWait.aborted).toBe(false);
    expect(text()).toContain("Finish signing in at GitHub");
    expect(buttons()).toContain("Cancel");
    expect(operations.checkRepositoryAccess).toHaveBeenCalledTimes(1);
  });

  // The ways it could fail: Cancel loses to a completed GitHub sign-in, the
  // check that finishes it is refused, and the reason the Host recorded is
  // cleared once the sheet is back at sign-in.
  it("says why a cancellation that lost to a completed sign-in asks for another", async () => {
    const connectionId = createIntegrationId("connection");
    const operations = githubOperations(connectionId);
    vi.mocked(operations.awaitAuthorization).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(operations.cancelAuthorization).mockResolvedValueOnce(completed(connectionId));
    vi.mocked(operations.checkRepositoryAccess).mockImplementationOnce(async () => {
      vi.mocked(operations.reloadDashboard).mockResolvedValue(
        githubDashboard(githubConnection(connectionId, signInRequired)),
      );
      throw new Error(rejectedSignIn);
    });
    render({ definition: githubDefinition(), dashboard: githubDashboard(), operations });

    await click("Continue to GitHub");
    await click("Cancel");

    expect(alert()).toBe(rejectedSignIn);
    expect(button("Continue to GitHub").disabled).toBe(false);
  });

  // The ways it could fail: Cancel loses to a sign-in that completed, and the
  // reload that would finish it fails. The sheet stays on "Finish signing in"
  // with a Cancel no sign-in owns, so pressing it again, closing the sheet and
  // letting that answer arrive reports the connection to a parent that has
  // moved on; or the sheet offers nothing that works.
  it("offers sign-in again when a lost cancellation cannot reload, and ignores a Cancel after close", async () => {
    const connectionId = createIntegrationId("connection");
    const unreachable = "This deployment could not be reached.";
    const operations = fakeOperations({
      cancelStatus: completed(connectionId),
      reloaded: {
        ...dashboard({ sources: [hosted], selected: hosted }),
        connections: [connection(connectionId)],
      },
    });
    vi.mocked(operations.reloadDashboard).mockRejectedValueOnce(new Error(unreachable));
    const onConnected = vi.fn();
    const root = render({ onConnected, operations });

    await click("Continue to Slack");
    await click("Cancel");

    expect(alert()).toBe(unreachable);
    expect(buttons()).not.toContain("Cancel");
    expect(button("Continue to Slack").disabled).toBe(false);

    let answerCancel!: (status: IntegrationAuthorizationStatus) => void;
    vi.mocked(operations.cancelAuthorization).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerCancel = resolve;
        }),
    );
    await click("Continue to Slack");
    expect(operations.beginAuthorization).toHaveBeenCalledTimes(2);
    await click("Cancel");
    act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await act(async () => answerCancel(completed(connectionId)));

    expect(onConnected).not.toHaveBeenCalled();
    expect(operations.reloadDashboard).toHaveBeenCalledTimes(1);
  });
});

function render(input: {
  readonly dashboard?: IntegrationDashboard;
  readonly definition?: IntegrationDefinitionSummary;
  readonly onConnected?: (connectionId: string) => void;
  readonly operations: ConnectOperations;
}): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <MemoryRouter>
        <ConnectFlow
          dashboard={input.dashboard ?? dashboard({ selected: hosted, sources: [hosted] })}
          definition={input.definition ?? definition()}
          onClose={vi.fn()}
          onConnected={input.onConnected ?? vi.fn()}
          operations={input.operations}
          purpose="Connect a Slack account so this integration can read through 6 operations you approve."
          requestedBy="Mattress Deal Finder"
          returnPath="/threads/thread-1"
        />
      </MemoryRouter>,
    ),
  );
  return root;
}

function text(): string {
  return document.body.textContent ?? "";
}

function alert(): string | null {
  return document.querySelector('[role="alert"]')?.textContent ?? null;
}

function buttons(): readonly string[] {
  return [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}

async function click(label: string): Promise<void> {
  const target = [...document.querySelectorAll<HTMLElement>("button, label")].find((element) =>
    element.textContent?.includes(label),
  );
  if (!target) throw new Error(`No control labelled ${label}`);
  const control =
    target instanceof HTMLLabelElement
      ? (target.querySelector<HTMLInputElement>("input") ?? target)
      : target;
  await act(async () => {
    control.click();
  });
}

function type(label: string, value: string): void {
  const field = [...document.querySelectorAll("label.field")].find((element) =>
    element.textContent?.includes(label),
  );
  const input = field?.querySelector<HTMLInputElement>("input");
  if (!input) throw new Error(`No field labelled ${label}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  const form = document.querySelector("form");
  if (!form) throw new Error("No form is open");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function fakeOperations(
  input: {
    readonly cancelStatus?: IntegrationAuthorizationStatus;
    readonly reloaded?: IntegrationDashboard;
    readonly saved?: IntegrationDashboard["applications"][number];
    readonly repositoryAccess?: readonly import("@opensteer/integration-core").IntegrationRepositoryAccess[];
    readonly status?: IntegrationAuthorizationStatus;
  } = {},
): ConnectOperations {
  let repositoryCheck = 0;
  return {
    // Without a status the sign-in is still waiting at the provider.
    awaitAuthorization: vi.fn((): Promise<IntegrationAuthorizationStatus> =>
      input.status ? Promise.resolve(input.status) : new Promise(() => {}),
    ),
    beginAuthorization: vi.fn(async () => started),
    cancelAuthorization: vi.fn(
      async () =>
        input.cancelStatus ?? {
          connectionId: null,
          expiresAt: started.expiresAt,
          failureCode: null,
          status: "cancelled" as const,
        },
    ),
    checkRepositoryAccess: vi.fn(
      async () =>
        input.repositoryAccess?.[
          Math.min(repositoryCheck++, input.repositoryAccess.length - 1)
        ] ?? { installationUrl: null, installations: [], ready: false },
    ),
    reloadDashboard: vi.fn(
      async () => input.reloaded ?? dashboard({ selected: hosted, sources: [hosted] }),
    ),
    saveProviderApplication: vi.fn(async () => input.saved ?? application({})),
    setApplicationStatus: vi.fn(async () => input.saved ?? application({})),
  } as unknown as ConnectOperations;
}

const rejectedSignIn = "GitHub rejected the saved sign-in";
/** What the Host writes when only a new sign-in can repair the account. */
const signInRequired = { statusDetail: rejectedSignIn, statusReason: null } as const;

/** A GitHub sign-in that worked, waiting for its app to reach a repository. */
function githubConnection(
  id: string,
  state: { readonly statusDetail: string | null; readonly statusReason: string | null } = {
    statusDetail: null,
    statusReason: "permissions",
  },
): IntegrationDashboard["connections"][number] {
  return {
    ...connection(id),
    accountIdentifier: "steerlabs",
    definitionId: "github",
    displayName: "steerlabs",
    externalTenantId: null,
    provider: "github",
    status: "needs-attention",
    ...state,
  } as unknown as IntegrationDashboard["connections"][number];
}

function githubDashboard(
  ...connections: readonly IntegrationDashboard["connections"][number][]
): IntegrationDashboard {
  const base = dashboard({ sources: [hosted], selected: hosted });
  return {
    ...base,
    connections,
    providerAuthorizations: { github: base.providerAuthorizations.slack },
  } as unknown as IntegrationDashboard;
}

function completed(
  connectionId: NonNullable<IntegrationAuthorizationStatus["connectionId"]>,
): IntegrationAuthorizationStatus {
  return { connectionId, expiresAt: started.expiresAt, failureCode: null, status: "completed" };
}

/** A completed GitHub sign-in whose first check finds no repository yet. */
function githubOperations(
  connectionId: NonNullable<IntegrationAuthorizationStatus["connectionId"]>,
): ConnectOperations {
  return fakeOperations({
    reloaded: githubDashboard(githubConnection(connectionId)),
    repositoryAccess: [
      {
        installationUrl: "https://github.com/apps/opensteer/installations/new",
        installations: [],
        ready: false,
      },
    ],
    status: {
      connectionId,
      expiresAt: started.expiresAt,
      failureCode: null,
      status: "completed",
    },
  });
}

function githubDefinition(): IntegrationDefinitionSummary {
  return {
    ...definition(),
    description: "Work with GitHub repositories.",
    id: "github",
    name: "GitHub",
    provider: "github",
  } as unknown as IntegrationDefinitionSummary;
}

function application(input: {
  readonly clientId?: string;
  readonly displayName?: string;
  readonly id?: string;
  readonly revision?: number;
}): IntegrationDashboard["applications"][number] {
  return {
    availability: "personal",
    callbackUrl: "https://deployment.test/v1/integrations/oauth/callback/slack",
    canManage: true,
    clientId: input.clientId ?? "1234567890.987",
    configuredSecretFields: ["clientSecret"],
    createdAt: "2026-09-17T00:00:00.000Z",
    displayName: input.displayName ?? "Mattress Deal Finder Bot",
    id: input.id ?? personalAppId,
    ownerUserId: "usr_1",
    provider: "slack",
    revision: input.revision ?? 3,
    status: "active",
    updatedAt: "2026-09-17T00:00:00.000Z",
  } as unknown as IntegrationDashboard["applications"][number];
}

function connection(id: string) {
  return {
    accountIdentifier: "oversteer.slack.com",
    applicationSource: hosted,
    authMethodId: "oauth",
    authorizationDigest: "a".repeat(43),
    connectionMethod: "managed-oauth",
    createdAt: "2026-09-17T00:00:00.000Z",
    definitionId: "slack",
    displayName: "Oversteer",
    externalIdentityId: "B01BOT",
    externalTenantId: "T01ABCDEF",
    grantedScopes: ["chat:write"],
    id,
    provider: "slack",
    providerApplicationId: null,
    status: "connected",
    statusDetail: null,
    updatedAt: "2026-09-17T00:00:00.000Z",
  } as unknown as IntegrationDashboard["connections"][number];
}

function definition(): IntegrationDefinitionSummary {
  return {
    adapter: "openapi",
    authMethods: [
      {
        id: "oauth",
        kind: "oauth",
        label: "Install Slack app",
        oauth: { scopes: ["channels:history", "chat:write"] },
        placements: [],
      },
    ],
    description: "Read conversations and post messages in Slack workspaces.",
    id: "slack",
    name: "Slack",
    provider: "slack",
  } as unknown as IntegrationDefinitionSummary;
}

function dashboard(input: {
  readonly applications?: readonly IntegrationDashboard["applications"][number][];
  readonly hostedOAuthStatus?: IntegrationDashboard["providerAuthorizations"]["slack"]["hostedOAuthStatus"];
  readonly selected?: IntegrationDashboard["providerAuthorizations"]["slack"]["selectedSource"];
  readonly sources: IntegrationDashboard["providerAuthorizations"]["slack"]["availableSources"];
}): IntegrationDashboard {
  return {
    applications: input.applications ?? [application({})],
    authorizationSurface: "canonical",
    callbackUrls: { slack: "https://deployment.test/v1/integrations/oauth/callback/slack" },
    connections: [],
    hostedOAuthDisclosure: "Opensteer brokers the authorization only.",
    isAdministrator: false,
    providerAuthorizations: {
      slack: {
        availableSources: input.sources,
        code: input.selected ? "READY" : "PROVIDER_APPLICATION_REQUIRED",
        detail: input.selected ? "Ready to connect" : "Configure an OAuth application first",
        hostedOAuthStatus: input.hostedOAuthStatus ?? "available",
        selectedSource: input.selected ?? null,
        selectedSourceKind: input.selected?.kind ?? null,
      },
    },
    providers: [
      {
        description: "Slack apps",
        hostedOAuthCapable: true,
        label: "Slack",
        provider: "slack",
        secretFields: ["clientSecret"],
        setupLabel: "Slack app",
        setupSteps: ["Create an app from a manifest."],
        setupUrl: "https://api.slack.com/apps",
      },
    ],
  } as unknown as IntegrationDashboard;
}
