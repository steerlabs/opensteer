// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAgentProposedDetail } from "@opensteer/core";
import { mockTmdbProposal } from "@opensteer/client/mock";

const openURL = vi.hoisted(() => vi.fn(async () => undefined));

// The native renderer's state and hierarchy, with DOM hosts. Platform controls
// are outside this regression; what it pins is the flow: which app is sent to
// the Host, and what the sheet is willing to call a connection.
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Linking: { openURL },
  Pressable: ({
    accessibilityRole,
    children,
    onPress,
  }: {
    accessibilityRole: "link";
    children?: ReactNode;
    onPress: () => void;
  }) => (
    <button role={accessibilityRole} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../theme.js", () => ({ color: {}, space: {} }));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({
    children,
    footer,
    onClose,
    open,
    title,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    onClose: () => void;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <div>
        <h1>{title}</h1>
        <button onClick={onClose}>Dismiss sheet</button>
        {children}
        {footer}
      </div>
    ) : null,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ChoiceRow: ({
    description,
    disabled,
    onPress,
    title,
  }: {
    description: string;
    disabled?: boolean;
    onPress: () => void;
    title: string;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {title} — {description}
    </button>
  ),
  CodeBlock: ({ label, text }: { label?: string; text: string }) => (
    <code>
      {label}: {text}
    </code>
  ),
  Field: ({
    input,
    label,
  }: {
    input: { onChangeText?: (value: string) => void; value?: string };
    label: string;
  }) => (
    <label>
      {label}
      <input
        aria-label={label}
        onChange={(event) => input.onChangeText?.(event.target.value)}
        value={input.value ?? ""}
      />
    </label>
  ),
  Notice: ({
    action,
    detail,
    title,
  }: {
    action?: { label: string; onPress: () => void };
    detail: string;
    title: string;
  }) => (
    <div>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action ? <button onClick={action.onPress}>{action.label}</button> : null}
    </div>
  ),
  PrimaryButton: ({
    disabled,
    label,
    onPress,
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SecondaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  SectionLabel: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  SwitchRow: ({
    label,
    onChange,
    value,
  }: {
    label: string;
    onChange: (value: boolean) => void;
    value: boolean;
  }) => <button onClick={() => onChange(!value)}>{label}</button>,
}));
vi.mock("../ui/integration-icon.js", () => ({
  IntegrationIcon: ({ name }: { name: string }) => <span aria-hidden>{name} icon</span>,
}));

const beginIntegrationAuthorization = vi.fn();
const beginMcpIntegrationAuthorization = vi.fn();
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ beginIntegrationAuthorization, beginMcpIntegrationAuthorization }),
}));

const { IntegrationConnectSheet } = await import("./integration-connect-sheet.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  openURL.mockClear();
  vi.restoreAllMocks();
  beginIntegrationAuthorization.mockReset();
  beginMcpIntegrationAuthorization.mockReset();
});

const hosted = {
  brokerIssuer: "https://oauth.opensteer.test",
  kind: "hosted-oauth" as const,
  providerApplicationRevision: 1,
};
const personalAppId = "ipa_00000000-0000-4000-8000-000000000001";
const twinAppId = "ipa_00000000-0000-4000-8000-000000000002";
const personalSource = {
  callbackUrl: "https://deployment.test/v1/integrations/oauth/callback/slack",
  kind: "deployment-oauth" as const,
  providerApplicationId: personalAppId,
  providerApplicationRevision: 3,
};
const twinSource = {
  ...personalSource,
  providerApplicationId: twinAppId,
  providerApplicationRevision: 1,
};

const mainConnectAllows =
  "Your tasks in Main can read and make changes with every account you connect, so connecting also allows this request.";

describe("IntegrationConnectSheet", () => {
  it("installs from the access sheet without resolving the request", async () => {
    const client = fakeClient({ isAdministrator: true, sources: [] });
    await render(client, preinstallRequest());

    expect(text()).toContain("Test Calendar");
    expect(text()).toContain("Scheduling for the test suite.");
    expect(text()).toContain(
      "After it’s installed, you’ll finish setting it up and review its access here.",
    );
    await click("Install and continue");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { kind: "choice", optionId: "installed" },
        type: "request.respond",
      }),
    );
    expect(text()).toContain("Loading the account and access review");
  });

  // The ways it could fail: the phone naming a proposal by its document's
  // title while the browser names the service, or leaving out what the agent
  // said it does; saying where the key goes, or
  // that it is checked, differently from the browser card; an operation count
  // the access step will contradict.
  it("reviews an agent's proposal in the browser card's words", async () => {
    const client = fakeClient({ isAdministrator: true, sources: [] });
    await render(client, {
      ...(preinstallRequest() as unknown as { payload: object }),
      payload: {
        ...(preinstallRequest() as unknown as { payload: object }).payload,
        manifest: mockTmdbProposal.manifest,
      },
    } as never);

    for (const line of [
      "TMDB",
      requestAgentProposedDetail,
      "Movie and TV show details, search and ratings.",
      "Researched from developer.themoviedb.org.",
      "Your key is stored encrypted by your Opensteer and sent to api.themoviedb.org when used.",
      "Opensteer checks the key with TMDB before saving it.",
    ]) {
      expect(text()).toContain(line);
    }
    expect(text()).not.toMatch(/tmdb-api|operations|Agent proposal/u);
  });

  it("starts MCP authorization on the phone for the exact requested server", async () => {
    beginMcpIntegrationAuthorization.mockResolvedValue({
      connectionId: "con_00000000-0000-4000-8000-0000000000bb",
      expiresAt: "2026-09-17T00:10:00.000Z",
      failureCode: null,
      status: "completed",
    });
    const client = fakeClient({ requirementKind: "mcp-oauth", sources: [] });
    await render(client);

    await click("Connect account");

    expect(beginMcpIntegrationAuthorization).toHaveBeenCalledWith({
      displayName: "Slack account",
      requestId: "req_00000000-0000-4000-8000-000000000001",
      serverId: "isv_00000000-0000-4000-8000-000000000001",
    });
  });

  // The way it could fail: a phone offered an MCP sign-in whose callback is the
  // Mac's own loopback address, which the Host refuses to begin from here.
  it("says an MCP server's sign-in is finished on the computer running Opensteer", async () => {
    await render(fakeClient({ remote: true, requirementKind: "mcp-oauth", sources: [] }));

    expect(buttons()).not.toContain("Connect account");
    expect(text()).toContain(
      "This sign-in returns to the computer running Opensteer, so finish it there.",
    );
    expect(beginMcpIntegrationAuthorization).not.toHaveBeenCalled();
  });

  // The ways it could fail, as on the web card: connecting on a request for
  // Main also answers it with nothing said first, or said only on the review,
  // so the key form, the browser sign-in, or a key repair that opens straight
  // on its key connects in silence; Main promised only the access the request
  // asked for, when its tasks use every operation of every account it
  // connects; or the sheet promises that for a specialized Workspace, whose
  // account still waits for Allow.
  it("connects an API key without leaving the access sheet", async () => {
    const client = fakeClient({ requirementKind: "api-key", sources: [] });
    await render(client);

    expect(text()).toContain("Read and write · 2 operations");
    expect(text()).toContain(mainConnectAllows);
    await click("Connect account");
    expect(text()).toContain(mainConnectAllows);
    expect(text()).toContain("Get your API token in your Slack account, then paste it here.");
    typeInto("API token", "secret-token");
    await click("Connect account");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          authMethodId: "api-key",
          definitionId: "slack",
          values: { apiKey: "secret-token" },
        }),
        type: "integration.apiKey.connect",
      }),
    );
  });

  // Instruction failures: a proposed label loses its case, the method title
  // replaces the input label, several inputs name only the first, or an unsafe
  // setup URL becomes a link instead of naming the service account.
  it.each([
    {
      label: "TMDB API Read Access Token",
      setupUrl: "https://www.themoviedb.org/settings/api",
      extra: false,
    },
    { label: "Bot token", setupUrl: "https://www.themoviedb.org/settings/api", extra: false },
    { label: "Account SID", setupUrl: "https://www.themoviedb.org/settings/api", extra: true },
    { label: "Bot token", setupUrl: undefined, extra: false },
    { label: "Bot token", setupUrl: "http://www.themoviedb.org/settings/api", extra: false },
    { label: "Bot token", setupUrl: "https://name@www.themoviedb.org/settings/api", extra: false },
    {
      label: "Bot token",
      setupUrl: "https://:secret@www.themoviedb.org/settings/api",
      extra: false,
    },
  ])(
    "names $label with setup $setupUrl (multiple inputs: $extra)",
    async ({ label, setupUrl, extra }) => {
      const client = fakeClient({ requirementKind: "api-key", sources: [] });
      const installed = platform("api-key");
      const definition = installed.installations[0]!.installation.manifest.definition;
      definition.name = "TMDB";
      Object.assign(definition, setupUrl === undefined ? {} : { setupUrl });
      definition.authMethods = [
        {
          id: "api-key",
          inputs: [
            { label, secret: true, variable: "apiKey" },
            ...(extra ? [{ label: "Auth token", secret: true, variable: "authToken" }] : []),
          ],
          kind: "api-key",
          label: "Service credentials",
          placements: [{ carrier: "header", name: "Authorization", variable: "apiKey" }],
        },
      ];
      vi.spyOn(client.rpc, "integration.platform.get").mockResolvedValue({
        ok: true,
        data: installed,
      });
      await render(client);
      await click("Connect account");

      const noun = extra ? "key" : label;
      const safe = setupUrl?.startsWith("https://www.") === true;
      const location = safe ? "at www.themoviedb.org" : "in your TMDB account";
      expect(text()).toContain(`Get your ${noun} ${location}, then paste it here.`);
      expect(document.querySelectorAll('[role="link"]')).toHaveLength(safe ? 1 : 0);
      if (safe) {
        await click(`Get your ${noun}`);
        expect(openURL).toHaveBeenCalledWith(setupUrl);
      }
      typeInto(label, "credential-value");
      if (extra) typeInto("Auth token", "second-value");
      await click("Connect account");
      expect(client.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            values: {
              apiKey: "credential-value",
              ...(extra ? { authToken: "second-value" } : {}),
            },
          }),
          type: "integration.apiKey.connect",
        }),
      );
    },
  );

  it("promises nothing about connecting for a specialized Workspace", async () => {
    await render(
      fakeClient({ requirementKind: "api-key", sources: [], workspaceKind: "specialized" }),
    );

    expect(text()).toContain("Connect account");
    expect(text()).toContain("Read only · 1 of 2 operations");
    expect(text()).not.toContain("connecting also allows this request");
    await click("Connect account");
    expect(text()).toContain("API token");
    expect(text()).not.toContain("connecting also allows this request");
  });

  // The way it could fail: a tap before the key appears; no reason; nothing
  // saying an agent proposed the integration the key is for, since the
  // review that says so is skipped; the twin account of the same name
  // repaired, or a new account made; the agent's request answered, or another
  // account offered, on the person's behalf.
  it.each([false, true])(
    "dismisses a key form without changing accounts or the request (reconnect: %s)",
    async (reconnecting) => {
      const connectionId = "con_00000000-0000-4000-8000-0000000000a1";
      const client = fakeClient({
        connections: reconnecting
          ? [
              keyConnection(connectionId, "2026-09-17T09:12:00.000Z", {
                status: "needs-attention",
                statusDetail: "Slack rejected the saved sign-in",
              }),
            ]
          : [],
        requirementKind: "api-key",
        sources: [],
      });
      const onClose = vi.fn();
      const onResponded = vi.fn();
      await render(client, request("read", reconnecting ? connectionId : undefined), {
        onClose,
        onResponded,
      });
      if (!reconnecting) await click("Connect account");
      typeInto("API token", "discard-this-key");
      await click("Dismiss sheet");
      expect(onClose).toHaveBeenCalledOnce();
      expect(onResponded).not.toHaveBeenCalled();
      expect(client.dispatch).not.toHaveBeenCalled();
      expect(beginIntegrationAuthorization).not.toHaveBeenCalled();
    },
  );

  it("reconnects the exact key account a request names, straight from its key", async () => {
    const requestedId = "con_00000000-0000-4000-8000-0000000000a1";
    const twinId = "con_00000000-0000-4000-8000-0000000000a2";
    const client = fakeClient({
      connections: [
        keyConnection(requestedId, "2026-09-17T09:12:00.000Z", {
          status: "needs-attention",
          statusDetail: "Slack rejected the saved sign-in",
        }),
        keyConnection(twinId, "2026-09-17T09:40:00.000Z"),
      ],
      requirementKind: "api-key",
      sources: [],
    });
    await render(client, {
      ...(request("read", requestedId) as object),
      presentation: { agentProposed: true, kind: "external", title: "Slack access" },
    } as never);

    expect(document.querySelector("h1")?.textContent).toBe("Reconnect Slack");
    expect(text()).toContain("Proposed by an agent");
    expect(text()).toContain("Slack rejected the saved sign-in");
    expect(text()).toContain(mainConnectAllows);
    // The name is shared, so the time it was added is what says which one.
    expect(text()).toMatch(/Added Sep 17, \d{1,2}:\d{2}\s?[AP]M · Needs attention/u);
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Account label (optional)"]')
        ?.value,
    ).toBe("Slack");
    expect(text()).not.toContain("Connect another account");

    typeInto("API token", "replacement-token");
    await click("Reconnect account");

    expect(client.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        input: expect.objectContaining({
          connectionId: requestedId,
          displayName: "Slack",
          values: { apiKey: "replacement-token" },
        }),
        type: "integration.apiKey.connect",
      }),
    );
  });

  // The ways it could fail: a key form for an account that no longer exists;
  // the action named "Dismiss", as if it only hid the sheet, when it declines;
  // words that differ from the browser's for the same request.
  it("says plainly when the account a request names is gone, and lets it be declined", async () => {
    const onResponded = vi.fn();
    const client = fakeClient({
      connections: [
        keyConnection("con_00000000-0000-4000-8000-0000000000a2", "2026-09-17T09:40:00.000Z"),
      ],
      requirementKind: "api-key",
      sources: [],
    });
    await render(client, request("read", "con_00000000-0000-4000-8000-0000000000a1"), {
      onResponded,
    });

    expect(text()).toContain("Account no longer available");
    expect(text()).toContain(
      "This account is no longer available. Decline this request, then ask the agent again when you want to reconnect.",
    );
    expect(text()).not.toContain("Dismiss request");
    expect(text()).not.toContain("Reconnect account");
    expect(text()).not.toContain("Connect another account");
    expect(text()).not.toContain("Use this account");

    await click("Decline request");

    expect(client.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      }),
    );
    expect(onResponded).toHaveBeenCalledOnce();
  });

  it("pins a singleton server before showing account or access controls", async () => {
    const client = fakeClient({ sources: [] });
    await render(client, unpinnedRequest());

    expect(text()).toContain("Choose the Slack server");
    expect(text()).not.toContain("Connect account");
    await click("Continue with live");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: {
          kind: "choice",
          optionId: "server:isv_00000000-0000-4000-8000-000000000001",
        },
        type: "request.respond",
      }),
    );
  });

  it("sends the exact app the person chose to the Host", async () => {
    beginIntegrationAuthorization.mockResolvedValue({
      connectionId: null,
      expiresAt: "2026-09-17T00:10:00.000Z",
      failureCode: null,
      status: "denied",
    });
    const client = fakeClient({ sources: [hosted, personalSource] });
    await render(client);

    await click("Connect account");
    expect(text()).toContain(mainConnectAllows);
    await click("Mattress Deal Finder Bot");
    await click("Continue in browser");

    expect(beginIntegrationAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ applicationSource: personalSource }),
    );
    // A refusal is a refusal, on a phone as anywhere else.
    expect(text()).toContain("Access was not approved.");
    expect(text()).not.toContain("is connected as");
  });

  it("refuses to report a connection the Host did not record", async () => {
    beginIntegrationAuthorization.mockResolvedValue({
      connectionId: "con_00000000-0000-4000-8000-0000000000ff",
      expiresAt: "2026-09-17T00:10:00.000Z",
      failureCode: null,
      status: "completed",
    });
    const client = fakeClient({ selected: hosted, sources: [hosted] });
    await render(client);

    await click("Connect account");
    await click("Continue in browser");

    expect(text()).toContain("no connected account is recorded here");
    expect(text()).not.toContain("is connected as");
  });

  it("shows the account the Host recorded, and still asks about the Workspace", async () => {
    const connectionId = "con_00000000-0000-4000-8000-0000000000aa";
    beginIntegrationAuthorization.mockResolvedValue({
      connectionId,
      expiresAt: "2026-09-17T00:10:00.000Z",
      failureCode: null,
      status: "completed",
    });
    const client = fakeClient({
      connections: [connection(connectionId)],
      selected: hosted,
      sources: [hosted],
    });
    await render(client);

    await click("Connect another account");
    await click("Continue in browser");

    expect(text()).toContain("Slack is connected as Oversteer");
    expect(text()).toContain("T01ABCDEF");
    // The grant is a separate answer, and nothing here has given it.
    expect(client.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "request.respond" }),
    );
  });

  // GitHub's 401 makes the Host record a sign-in-required account; checking
  // that credential again can only be refused again.
  it("returns to sign-in when GitHub rejects the sign-in at the first check", async () => {
    const account = githubConnection(githubConnectionId);
    const client = fakeClient({
      connections: [account],
      provider: "github",
      selected: hosted,
      sources: [hosted],
    });
    client.rpc["integration.repositoryAccess.check"].mockImplementationOnce(async () =>
      rejectSignIn(account),
    );
    beginIntegrationAuthorization.mockResolvedValue(completed(githubConnectionId));
    await render(client);

    await click("Connect account");
    await click("Continue in browser");

    expect(text()).toContain(`This connection did not finish${rejectedSignIn}`);
    expect(buttons()).toContain("Continue in browser");
    expect(buttons()).not.toContain("Recheck repository access");

    await click("Continue in browser");

    expect(beginIntegrationAuthorization).toHaveBeenCalledTimes(2);
  });

  it("returns to sign-in when GitHub rejects the sign-in on a recheck", async () => {
    const account = githubConnection(githubConnectionId);
    const client = fakeClient({
      connections: [account],
      provider: "github",
      selected: hosted,
      sources: [hosted],
    });
    beginIntegrationAuthorization.mockResolvedValue(completed(githubConnectionId));
    await render(client);
    await click("Connect account");
    await click("Continue in browser");
    expect(text()).toContain("Repository access is still required");

    client.rpc["integration.repositoryAccess.check"].mockImplementationOnce(async () =>
      rejectSignIn(account),
    );
    await click("Recheck repository access");

    expect(text()).toContain(`This connection did not finish${rejectedSignIn}`);
    expect(buttons()).toContain("Continue in browser");
    expect(buttons()).not.toContain("Recheck repository access");
  });

  it("keeps the repository step when GitHub fails a recheck without rejecting the sign-in", async () => {
    const unavailable = "GitHub repository access could not be checked. Retry in a moment.";
    const client = fakeClient({
      connections: [githubConnection(githubConnectionId)],
      provider: "github",
      selected: hosted,
      sources: [hosted],
    });
    const reload = vi.spyOn(client.rpc, "integrations.get");
    beginIntegrationAuthorization.mockResolvedValue(completed(githubConnectionId));
    await render(client);
    await click("Connect account");
    await click("Continue in browser");
    const reloads = reload.mock.calls.length;

    // A 5xx changes nothing at the Host: the account still waits for repositories.
    client.rpc["integration.repositoryAccess.check"].mockResolvedValueOnce({
      error: { code: "internal", message: unavailable, retryable: true },
      ok: false,
    });
    await click("Recheck repository access");

    expect(reload).toHaveBeenCalledTimes(reloads + 1);
    expect(text()).toContain(`This connection did not finish${unavailable}`);
    expect(text()).toContain("Repository access is still required");
    expect(buttons()).toContain("Recheck repository access");
    expect(buttons()).not.toContain("Continue in browser");
  });

  it("saves an own app without connecting, and keeps the row the Host wrote", async () => {
    const client = fakeClient({
      applications: [
        application({ id: personalAppId, revision: 3 }),
        application({ id: twinAppId, revision: 1 }),
      ],
      saved: application({ id: twinAppId, revision: 1 }),
      sources: [personalSource, twinSource],
    });
    await render(client);

    await click("Connect account");
    await click("Use my own Slack app");
    typeInto("App name", "Mattress Deal Finder Bot");
    typeInto("Client ID", "1234567890.987");
    typeInto("Client Secret", "shhh");
    await click("Save app");

    expect(text()).toContain("No account is connected yet");
    expect(beginIntegrationAuthorization).not.toHaveBeenCalled();

    await click("Continue in browser");

    // Two registrations share a name and client id; the Host's answer decides.
    expect(beginIntegrationAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ applicationSource: twinSource }),
    );
  });

  it("leads to own-app setup when this deployment offers no sign-in app", async () => {
    const client = fakeClient({ sources: [] });
    await render(client);

    await click("Connect account");

    expect(text()).toContain("No sign-in app is ready yet");
    expect(text()).toContain("Set up my own Slack app");
    expect(text()).not.toContain("Continue in browser");
  });

  it("keeps requested read-write access required when write operations are discovered", async () => {
    const connectionId = "con_00000000-0000-4000-8000-0000000000aa";
    const client = fakeClient({
      connections: [connection(connectionId)],
      selected: hosted,
      sources: [hosted],
      workspaceKind: "specialized",
    });
    await render(client, request("read-write"));

    expect(text()).toContain("This task requires read-write access");
    expect(text()).not.toContain("Allow changes");
    await click("Allow in Support");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({
          value: expect.objectContaining({ access: "read-write", connectionId }),
        }),
        type: "request.respond",
      }),
    );
  });

  it("lets a read request opt into write access", async () => {
    const connectionId = "con_00000000-0000-4000-8000-0000000000aa";
    const client = fakeClient({
      connections: [connection(connectionId)],
      selected: hosted,
      sources: [hosted],
      workspaceKind: "specialized",
    });
    await render(client, request("read"));

    // The access in one line, counted in the grammar a person reads.
    expect(text()).toContain("Read only · 1 of 2 operations");
    expect(text()).not.toContain("1 operations");
    await click("Allow changes");
    expect(text()).toContain("Read and write · 2 operations");
    await click("Allow in Support");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({
          value: expect.objectContaining({ access: "read-write", connectionId }),
        }),
        type: "request.respond",
      }),
    );
  });

  /**
   * The phone is not the Mac, and it does not have to be: turning an app on is
   * a write about a computer, so the request it answers can be finished here.
   */
  it("requests local approval without granting access or finishing the agent request", async () => {
    const client = fakeClient({ machines: [mac()], requirementKind: "computer", sources: [] });
    await render(client);

    expect(text()).toContain("Choose a computer");
    await click("Choose a computer");
    await click("Mac mini");
    await click("Request setup on Mac mini");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        // The safe level, never the one that acts on somebody's behalf.
        input: expect.objectContaining({
          access: "read",
          definitionId: "apple-messages",
          runnerId: macMiniId,
        }),
        type: "integration.computer.setup.request",
      }),
    );
  });

  it("explains a selected Mac permission without blocking connection", async () => {
    const client = fakeClient({
      machines: [mac({ apps: [messagesNeedsFullDiskAccess()] })],
      requirementKind: "computer",
      sources: [],
    });
    await render(client);

    await click("Choose a computer");

    expect(text()).toContain("Agent access");
    expect(text()).toContain("Reading Apple Messages needs macOS Full Disk Access");
    expect(text()).toContain(
      "Reading Apple Messages requires macOS permission. Switching on Opensteer Computer Use in Full Disk Access lets it read Apple Messages on Mac mini for the agents you approve. It does not change the agent access selected for this app. Complete setup on Mac mini.",
    );
    expect(text()).not.toContain("the app that runs Opensteer");
    expect(text()).not.toContain("Open System Settings");

    await click("Request setup on Mac mini");
    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ runnerId: macMiniId }),
        type: "integration.computer.setup.request",
      }),
    );
  });

  it("explains a selected iPhone's Settings without macOS directions", async () => {
    const detail = "Calendar needs full access for Opensteer in iPhone Settings.";
    const client = fakeClient({
      installedPlatform: calendarPlatform(),
      machines: [
        mac({
          apps: [
            {
              definitionId: "apple-calendar",
              operations: [
                {
                  operation: "list_events",
                  detail,
                  remedy: "calendars",
                  state: "permission-required",
                },
              ],
            },
          ],
          device: { form: "phone", platform: "ios" },
          name: "Alex's iPhone",
        }),
      ],
      requirementKind: "computer",
      sources: [],
    });
    await render(client);

    await click("Choose a computer");

    expect(text()).toContain("Calendar needs access on Alex's iPhone");
    expect(text()).toContain(
      `${detail} Allow it in iPhone Settings on Alex's iPhone. It does not change the agent access selected for this app.`,
    );
    expect(text()).not.toContain("macOS Calendars access");
    expect(text()).not.toContain("Opensteer Computer Use");
    // The computer's row names the iPhone's own setting, never a macOS one.
    expect(text()).not.toContain("macOS");
    expect(text()).toContain(`${detail} · chosen`);
  });

  /*
   * Failure: once no computer offers an app a Mac or an iPhone can run, the
   * computer step tells the phone to open "the desktop app" and "Add
   * computer", which an iPhone has neither of. A Mac-only app keeps its
   * desktop-app steps.
   */
  it("says where a Mac or an iPhone adds itself once none offers the app", async () => {
    const client = fakeClient({
      installedPlatform: calendarPlatform(),
      machines: [
        mac({
          apps: [
            {
              definitionId: "apple-calendar",
              operations: [
                { detail: null, operation: "list_events", remedy: null, state: "ready" },
              ],
            },
          ],
          device: { form: "phone", platform: "ios" },
          name: "Alex's iPhone",
        }),
      ],
      requirementKind: "computer",
      sources: [],
    });
    await render(client);

    await click("Choose a computer");
    await act(async () => client.setMachines([]));

    expect(text()).toContain("No computer is offering Calendar yet");
    expect(text()).toContain(
      "Open Opensteer on a Mac or an iPhone, open this deployment, then add it in Settings → Computers. Return here when it appears.",
    );
    expect(text()).not.toContain("desktop app");
    expect(text()).not.toContain("Add computer");
  });

  it("keeps a Mac-only app's desktop-app steps once no Mac offers it", async () => {
    const client = fakeClient({ machines: [mac()], requirementKind: "computer", sources: [] });
    await render(client);

    await click("Choose a computer");
    await act(async () => client.setMachines([]));

    expect(text()).toContain(
      "Open Opensteer on a Mac in the desktop app. Open this deployment, then Settings → Computers → Add computer and follow the steps. Return here when it appears.",
    );
  });

  it("requires an explicit choice before turning on read-write computer access", async () => {
    const client = fakeClient({
      machines: [mac()],
      requirementKind: "computer",
      sources: [],
      workspaceKind: "specialized",
    });
    await render(client);

    await click("Choose a computer");
    await click("Read and send");
    await click("Request setup on Mac mini");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read-write", runnerId: macMiniId }),
        type: "integration.computer.setup.request",
      }),
    );
  });

  it("widens a read-only computer before a read request opts into changes", async () => {
    const client = fakeClient({
      connections: [computerConnection("read")],
      machines: [mac()],
      requirementKind: "computer",
      sources: [],
      workspaceKind: "specialized",
    });
    await render(client, request("read"));

    await click("Allow changes (Read and send)");

    expect(text()).toContain("Request sending access on Mac mini");
    expect(text()).not.toContain("Allow in Support");
    await click("Request sending access on Mac mini");
    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read-write", runnerId: macMiniId }),
        type: "integration.computer.setup.request",
      }),
    );
  });

  it("does not fulfill a Main request just by requesting setup", async () => {
    const onClose = vi.fn();
    const onResponded = vi.fn();
    const client = fakeClient({
      machines: [mac()],
      requestPendingAfterComputerSet: false,
      requirementKind: "computer",
      sources: [],
    });
    await render(client, request("read"), { onClose, onResponded });

    await click("Choose a computer");
    await click("Request setup on Mac mini");

    expect(onResponded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(client.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "request.respond" }),
    );
  });

  it("keeps an insufficient Main request pending after choosing its computer", async () => {
    const onResponded = vi.fn();
    const client = fakeClient({
      machines: [mac()],
      requestPendingAfterComputerSet: true,
      requirementKind: "computer",
      sources: [],
    });
    await render(client, request("read-write"), { onResponded });

    await click("Choose a computer");
    await click("Request setup on Mac mini");

    expect(onResponded).not.toHaveBeenCalled();
    expect(text()).toContain("Setup requested");
  });

  it("does not redirect a request pinned to another account", async () => {
    const requestedId = "con_00000000-0000-4000-8000-0000000000a1";
    const client = fakeClient({
      connections: [
        connection(requestedId, "Requested account"),
        connection("con_other", "Other account"),
      ],
      selected: hosted,
      sources: [hosted],
    });
    await render(client, request("read", requestedId));

    expect(text()).toContain("Requested account");
    expect(text()).not.toContain("Other account");
  });

  it("keeps the chosen computer visible while its setup request awaits approval", async () => {
    const macBookId = "rnr_00000000-0000-4000-8000-0000000000a2";
    const client = fakeClient({
      computerSetVisible: false,
      connections: [computerConnection("read")],
      machines: [mac(), mac({ id: macBookId, name: "MacBook" })],
      requirementKind: "computer",
      sources: [],
      workspaceKind: "specialized",
    });
    await render(client);

    await click("Use another computer");
    await click("Request setup on MacBook");

    expect(text()).toContain("Setup requested. On MacBook");
    expect(text()).not.toContain("Use this account");
  });

  it("requires reselection when the explicitly chosen computer disappears", async () => {
    const macBookId = "rnr_00000000-0000-4000-8000-0000000000a2";
    const client = fakeClient({
      machines: [mac(), mac({ id: macBookId, name: "MacBook" })],
      requirementKind: "computer",
      sources: [],
    });
    await render(client);

    await click("Choose a computer");
    await click("MacBook");
    await act(async () => client.setMachines([mac()]));

    expect(text()).not.toContain("Request setup on Mac mini");
    expect(text()).not.toContain("Request setup on MacBook");
  });

  it("ignores a computer write that finishes after the sheet is dismissed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onClose = vi.fn();
    const onResponded = vi.fn();
    const client = fakeClient({
      computerSetGate: gate,
      machines: [mac()],
      requirementKind: "computer",
      sources: [],
    });
    await render(client, request(), { onClose, onResponded });

    await click("Choose a computer");
    await click("Request setup on Mac mini");
    await click("Dismiss sheet");
    await act(async () => {
      release();
      await gate;
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onResponded).not.toHaveBeenCalled();
  });

  /**
   * A read-only computer has no send tool for any grant to reach, so approving
   * the request would promise an access it cannot carry. Raising the ceiling is
   * its own deliberate act, and it leaves the request exactly as it was pinned.
   */
  it("requires the computer's ceiling to be raised before a send request is allowed", async () => {
    const client = fakeClient({
      connections: [computerConnection("read")],
      machines: [mac()],
      requirementKind: "computer",
      sources: [],
    });
    await render(client, request("read-write"));

    expect(text()).toContain("Allow changes on this computer");
    expect(text()).not.toContain("Use this account");
    await click("Request sending access on Mac mini");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read-write", runnerId: macMiniId }),
        type: "integration.computer.setup.request",
      }),
    );
    expect(client.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "request.respond" }),
    );
  });

  it("allows a no-account integration without claiming an account is missing", async () => {
    const client = fakeClient({ requirementKind: "none", sources: [] });
    await render(client);

    expect(text()).not.toContain("No account is connected yet");
    await click("Use this account");

    expect(client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { kind: "external", value: { connectionId: null, decision: "fulfilled" } },
        type: "request.respond",
      }),
    );
  });

  // The ways it could fail: the person closes the sheet while an install, a
  // server choice, a key or an MCP sign-in is still out, and opens it again;
  // the old operation's failure, arriving now, lands on the fresh sheet.
  it.each<{
    readonly client: () => ReturnType<typeof fakeClient>;
    readonly operation: string;
    readonly request: () => ReturnType<typeof request>;
    readonly start: (client: ReturnType<typeof fakeClient>, held: Promise<never>) => Promise<void>;
  }>([
    {
      client: () => fakeClient({ isAdministrator: true, sources: [] }),
      operation: "an install",
      request: preinstallRequest,
      start: async (client, held) => {
        client.dispatch.mockReturnValueOnce(held);
        await click("Install and continue");
      },
    },
    {
      client: () => fakeClient({ sources: [] }),
      operation: "a server choice",
      request: unpinnedRequest,
      start: async (client, held) => {
        client.dispatch.mockReturnValueOnce(held);
        await click("Continue with live");
      },
    },
    {
      client: () => fakeClient({ requirementKind: "api-key", sources: [] }),
      operation: "a key",
      request,
      start: async (client, held) => {
        await click("Connect account");
        typeInto("API token", "secret-token");
        client.dispatch.mockReturnValueOnce(held);
        await click("Connect account");
      },
    },
    {
      client: () => fakeClient({ requirementKind: "mcp-oauth", sources: [] }),
      operation: "an MCP sign-in",
      request,
      start: async (_client, held) => {
        beginMcpIntegrationAuthorization.mockReturnValueOnce(held);
        await click("Connect account");
      },
    },
  ])("leaves a reopened sheet alone when $operation fails late", async (input) => {
    const client = input.client();
    const currentRequest = input.request();
    let fail!: (reason: Error) => void;
    const held = new Promise<never>((_, reject) => {
      fail = reject;
    });
    await render(client, currentRequest);
    await input.start(client, held);
    await click("Dismiss sheet");
    await reopen(client, currentRequest);

    await act(async () => fail(new Error("The closed sheet's operation failed")));

    expect(text()).not.toContain("The closed sheet's operation failed");
  });
});

async function render(
  client: ReturnType<typeof fakeClient>,
  currentRequest = request(),
  callbacks: { readonly onClose?: () => void; readonly onResponded?: () => void } = {},
): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <IntegrationConnectSheet
        hostClient={client as never}
        onClose={callbacks.onClose ?? vi.fn()}
        onResponded={callbacks.onResponded ?? vi.fn()}
        open
        request={currentRequest}
      />,
    );
  });
}

/** Closes the sheet and opens it again on the same request, as its card does. */
async function reopen(
  client: ReturnType<typeof fakeClient>,
  currentRequest: ReturnType<typeof request>,
): Promise<void> {
  const root = roots.at(-1)!;
  for (const open of [false, true]) {
    await act(async () => {
      root.render(
        <IntegrationConnectSheet
          hostClient={client as never}
          onClose={vi.fn()}
          onResponded={vi.fn()}
          open={open}
          request={currentRequest}
        />,
      );
    });
  }
}

function text(): string {
  return document.body.textContent ?? "";
}

function buttons(): readonly string[] {
  return [...document.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

async function click(label: string): Promise<void> {
  const target = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
  if (!target) throw new Error(`No control labelled ${label} in: ${text()}`);
  await act(async () => {
    target.click();
  });
}

function typeInto(label: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`No field labelled ${label}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const threadId = "thr_00000000-0000-4000-8000-000000000001";
const requestId = "req_00000000-0000-4000-8000-000000000001";

function request(
  access: "read" | "read-write" = "read",
  requestedConnectionId: string | null = null,
) {
  return {
    createdAt: "2026-09-17T00:00:00.000Z",
    id: requestId,
    kind: "integration.access",
    mode: "live",
    originatingThreadId: threadId,
    payload: {
      access,
      installationId: "iin_00000000-0000-4000-8000-000000000001",
      kind: "integration.access",
      reason: "Read the deals channel.",
      requestedConnectionId,
      requestedServerId: "isv_00000000-0000-4000-8000-000000000001",
    },
    presentation: { kind: "external", title: "Connect Slack" },
    status: "pending",
    targetWorkspaceId: "wsp_00000000-0000-4000-8000-000000000001",
  } as never;
}

/** A request for an installation with more than one server, naming none. */
function unpinnedRequest() {
  return {
    ...(request() as unknown as object),
    payload: {
      access: "read",
      installationId: "iin_00000000-0000-4000-8000-000000000001",
      kind: "integration.access",
      manifest: null,
      reason: "Use one server",
      requestedConnectionId: null,
      requestedServerId: null,
    },
  } as never;
}

function preinstallRequest() {
  return {
    ...(request() as unknown as object),
    payload: {
      access: "read",
      installationId: null,
      kind: "integration.access",
      manifest: {
        definition: {
          adapter: "openapi",
          authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
          description: "Scheduling for the test suite.",
          id: "test-calendar",
          name: "Test Calendar",
          provider: "google",
        },
        digest: "c".repeat(43),
        kind: "catalog",
      },
      requestedConnectionId: null,
      requestedServerId: null,
      reason: "Read the calendar",
    },
  } as never;
}

function fakeClient(input: {
  readonly applications?: readonly ReturnType<typeof application>[];
  readonly connections?: readonly (
    | ReturnType<typeof connection>
    | ReturnType<typeof computerConnection>
    | ReturnType<typeof keyConnection>
  )[];
  readonly saved?: ReturnType<typeof application>;
  readonly selected?: typeof hosted | typeof personalSource;
  readonly machines?: readonly ReturnType<typeof mac>[];
  readonly computerSetGate?: Promise<void>;
  /** The installed apps the Host lists, when not one of `platform`'s fixtures. */
  readonly installedPlatform?: ReturnType<typeof calendarPlatform>;
  readonly computerSetVisible?: boolean;
  readonly requestPendingAfterComputerSet?: boolean;
  readonly sources: readonly (typeof hosted | typeof personalSource)[];
  readonly requirementKind?: "api-key" | "computer" | "mcp-oauth" | "none" | "provider";
  readonly isAdministrator?: boolean;
  readonly multipleServers?: boolean;
  readonly provider?: "github" | "slack";
  /** Attached from another device, as a phone always is to a Personal Opensteer. */
  readonly remote?: boolean;
  readonly workspaceKind?: "main" | "specialized";
}) {
  const provider = input.provider ?? "slack";
  let sources = input.sources;
  const connections = [...(input.connections ?? [])];
  const requestPending = true;
  const listeners = new Set<() => void>();
  let snapshot = {
    machines: [...(input.machines ?? [])],
    workspaces: [
      {
        id: "wsp_00000000-0000-4000-8000-000000000001",
        kind: input.workspaceKind ?? "main",
        name: input.workspaceKind === "specialized" ? "Support" : "Main",
      },
    ],
  };
  const dispatch = vi.fn(
    async (command: {
      readonly input?: { readonly access?: "read" | "read-write"; readonly runnerId?: string };
      readonly type: string;
    }) => {
      if (command.type === "integration.providerApplication.save") {
        sources = input.sources;
        return { application: input.saved, type: command.type };
      }
      if (command.type === "integration.computer.setup.request") {
        await input.computerSetGate;
        return { type: command.type, request: { id: "test-setup-request" } };
      }
      return { type: command.type };
    },
  );
  return {
    dispatch,
    getSnapshot: () => snapshot,
    rpc: {
      "integration.platform.get": async () => {
        const data =
          input.installedPlatform ??
          platform(input.requirementKind ?? "provider", input.multipleServers ?? false, provider);
        return {
          ok: true,
          data: input.remote ? { ...data, authorizationSurface: "personal-remote" } : data,
        };
      },
      "integration.repositoryAccess.check": vi.fn(
        async (): Promise<
          | { readonly data: unknown; readonly ok: true }
          | { readonly error: unknown; readonly ok: false }
        > => ({ data: { installationUrl: null, installations: [], ready: false }, ok: true }),
      ),
      "integrations.get": async () => ({
        ok: true,
        data: {
          applications: input.applications ?? [application({ id: personalAppId, revision: 3 })],
          authorizationSurface: "canonical",
          callbackUrls: {
            [provider]: `https://deployment.test/v1/integrations/oauth/callback/${provider}`,
          },
          connections,
          hostedOAuthDisclosure: "Opensteer brokers the authorization only.",
          isAdministrator: input.isAdministrator ?? false,
          providerAuthorizations: {
            [provider]: {
              availableSources: sources,
              code: input.selected ? "READY" : "PROVIDER_APPLICATION_REQUIRED",
              detail: input.selected
                ? "Ready to connect"
                : "Configure and enable this deployment's OAuth application",
              hostedOAuthStatus: "available",
              selectedSource: input.selected ?? null,
              selectedSourceKind: input.selected?.kind ?? null,
            },
          },
          providers: [
            {
              description: "Slack apps",
              hostedOAuthCapable: true,
              label: "Slack",
              provider,
              secretFields: ["clientSecret"],
              setupLabel: "Slack app",
              setupSteps: ["Create an app from a manifest."],
              setupUrl: "https://api.slack.com/apps",
            },
          ],
        },
      }),
      "thread.requests.list": async () => ({
        ok: true,
        data: {
          requests: requestPending ? [{ id: requestId, status: "pending" }] : [],
          threadId,
          window: {
            byteCount: 2,
            hasMore: false,
            itemCount: requestPending ? 1 : 0,
            nextBefore: null,
            threadId,
            totalItems: requestPending ? 1 : 0,
          },
        },
      }),
    },
    setMachines(machines: readonly ReturnType<typeof mac>[]) {
      snapshot = { ...snapshot, machines: [...machines] };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function platform(
  requirementKind: "api-key" | "computer" | "mcp-oauth" | "none" | "provider",
  multipleServers = false,
  provider: "github" | "slack" = "slack",
) {
  if (requirementKind === "computer") return computerPlatform();
  const name = provider === "github" ? "GitHub" : "Slack";
  return {
    authorizationSurface: "canonical",
    catalog: [],
    connections: [],
    installations: [
      {
        installation: {
          id: "iin_00000000-0000-4000-8000-000000000001",
          manifest: {
            definition: {
              adapter: "openapi",
              apiKey:
                requirementKind === "api-key"
                  ? { destinations: ["https://slack.com"], check: false }
                  : null,
              authMethods:
                requirementKind === "api-key"
                  ? [
                      {
                        id: "api-key",
                        inputs: [{ label: "API token", secret: true, variable: "apiKey" }],
                        kind: "api-key",
                        label: "API key",
                        placements: [
                          { carrier: "header", name: "Authorization", variable: "apiKey" },
                        ],
                      },
                    ]
                  : [
                      {
                        id: "oauth",
                        kind: "oauth",
                        label: "Install Slack app",
                        oauth: {
                          authorizationUrl: "https://slack.com/oauth/v2/authorize",
                          clientAuth: "body",
                          identity: { identityPath: "bot_user_id", source: "token-response" },
                          scopeSeparator: ",",
                          scopes: ["channels:history", "chat:write"],
                          tokenUrl: "https://slack.com/api/oauth.v2.access",
                          usesPkce: false,
                        },
                        placements: [
                          { carrier: "header", name: "Authorization", variable: "accessToken" },
                        ],
                      },
                    ],
              description: "Read conversations and post messages in Slack workspaces.",
              id: provider,
              name,
              provider,
            },
          },
          status: "active",
          title: name,
        },
        servers: [
          {
            connectionRequirement:
              requirementKind === "none"
                ? { kind: "none" }
                : requirementKind === "mcp-oauth"
                  ? { kind: "mcp-oauth" }
                  : {
                      definitionId: provider,
                      kind: "provider",
                      provider,
                      providerApplicationRequired: requirementKind !== "api-key",
                    },
            id: "isv_00000000-0000-4000-8000-000000000001",
            name: "live",
            status: "active",
          },
          ...(multipleServers
            ? [
                {
                  connectionRequirement: { kind: "none" as const },
                  id: "isv_00000000-0000-4000-8000-000000000002",
                  name: "archive",
                  status: "active" as const,
                },
              ]
            : []),
        ],
        skills: [],
        tools: [
          {
            annotations: { readOnlyHint: true },
            connectionId: null,
            description: "Read messages",
            id: "itl_00000000-0000-4000-8000-000000000001",
            name: "read_messages",
            schemaDigest: "d".repeat(43),
            serverId: "isv_00000000-0000-4000-8000-000000000001",
            status: "active",
            title: "Read messages",
          },
          {
            annotations: { readOnlyHint: false },
            connectionId: null,
            description: "Post messages",
            id: "itl_00000000-0000-4000-8000-000000000002",
            name: "post_messages",
            schemaDigest: "e".repeat(43),
            serverId: "isv_00000000-0000-4000-8000-000000000001",
            status: "active",
            title: "Post messages",
          },
        ],
      },
    ],
  };
}

const macMiniId = "rnr_00000000-0000-4000-8000-0000000000a1";
const messagesConnectionId = "con_00000000-0000-4000-8000-0000000000c1";

function messagesNeedsFullDiskAccess() {
  return {
    definitionId: "apple-messages",
    operations: [
      {
        operation: "list_conversations",
        detail: "Reading Apple Messages requires macOS permission.",
        remedy: "full-disk-access",
        state: "permission-required",
      },
      {
        operation: "read_messages",
        detail: "Reading Apple Messages requires macOS permission.",
        remedy: "full-disk-access",
        state: "permission-required",
      },
      {
        operation: "send_message",
        detail: "Reading Apple Messages requires macOS permission.",
        remedy: "full-disk-access",
        state: "permission-required",
      },
    ],
  };
}

/** A Mac that is here and reporting the app, as the Host projects it. */
function mac(
  overrides: {
    readonly apps?: readonly object[];
    readonly device?: object;
    readonly id?: string;
    readonly name?: string;
    readonly status?: string;
  } = {},
) {
  return {
    ...(overrides.device === undefined ? {} : { device: overrides.device }),
    apps: overrides.apps ?? [
      {
        definitionId: "apple-messages",
        operations: [
          { operation: "list_conversations", detail: null, remedy: null, state: "ready" },
          { operation: "read_messages", detail: null, remedy: null, state: "ready" },
          { operation: "send_message", detail: null, remedy: null, state: "ready" },
        ],
      },
    ],
    id: overrides.id ?? macMiniId,
    // The module the computer advertises is what makes silence mean "checking"
    // rather than "not available", so the fixture states it.
    modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
    name: overrides.name ?? "Mac mini",
    status: overrides.status ?? "online",
  };
}

function computerConnection(
  access: "read" | "read-write",
  overrides: {
    readonly displayName?: string;
    readonly id?: string;
    readonly runnerId?: string;
  } = {},
) {
  return {
    accountIdentifier: null,
    applicationSource: null,
    authMethodId: "computer",
    authorizationDigest: null,
    computer: { access, runnerId: overrides.runnerId ?? macMiniId },
    connectionMethod: "computer",
    createdAt: "2026-09-17T00:00:00.000Z",
    definitionId: "apple-messages",
    displayName: overrides.displayName ?? "Mac mini",
    externalIdentityId: null,
    externalTenantId: null,
    grantedScopes: [],
    id: overrides.id ?? messagesConnectionId,
    provider: "apple-messages",
    providerApplicationId: null,
    status: "connected",
    statusDetail: null,
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}

/**
 * A newer Host's installed Calendar, which also lists an iPhone and a platform
 * this client has never heard of.
 */
function calendarPlatform() {
  const base = computerPlatform();
  const [entry] = base.installations;
  return {
    ...base,
    installations: [
      {
        ...entry!,
        installation: {
          ...entry!.installation,
          manifest: {
            definition: {
              adapter: "computer",
              apiKey: null,
              authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
              computerApp: {
                accessLabels: { read: "Can read", readWrite: "Can read and change" },
                accessLevels: ["read", "read-write"],
                operations: [
                  { name: "list_events", effect: "read" },
                  { name: "create_event", effect: "write" },
                ],
                accessSummaries: {
                  read: "Allows reading calendars and events.",
                  readWrite: "Allows reading calendars and events, and changing events.",
                },
                platforms: ["darwin", "ios", "future-phone-os"],
              },
              description: "Read and change Calendar.",
              id: "apple-calendar",
              name: "Calendar",
              provider: "apple-calendar",
            },
          },
          title: "Calendar",
        },
        servers: entry!.servers.map((server) => ({
          ...server,
          connectionRequirement: { definitionId: "apple-calendar", kind: "computer" },
        })),
      },
    ],
  };
}

/** The installed Messages app, exactly as the catalog describes it. */
function computerPlatform() {
  return {
    authorizationSurface: "canonical",
    catalog: [],
    connections: [],
    installations: [
      {
        installation: {
          id: "iin_00000000-0000-4000-8000-000000000001",
          manifest: {
            definition: {
              adapter: "computer",
              authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
              computerApp: {
                accessLabels: { read: "Read only", readWrite: "Read and send" },
                accessLevels: ["read", "read-write"],
                operations: [
                  { name: "list_conversations", effect: "read" },
                  { name: "read_messages", effect: "read" },
                  { name: "send_message", effect: "write" },
                ],
                accessSummaries: {
                  read: "Agents can search and read your conversations.",
                  readWrite:
                    "Agents can search and read your conversations, and send messages as you. Sending may ask for permission on this Mac.",
                },
                platforms: ["darwin"],
              },
              description: "Search, read, and send Apple Messages through an enrolled Mac.",
              id: "apple-messages",
              name: "Apple Messages",
              provider: "apple-messages",
            },
          },
          status: "active",
          title: "Apple Messages",
        },
        servers: [
          {
            connectionRequirement: { definitionId: "apple-messages", kind: "computer" },
            id: "isv_00000000-0000-4000-8000-000000000001",
            name: "live",
            status: "active",
          },
        ],
        skills: [],
        tools: [
          {
            annotations: { readOnlyHint: true },
            connectionId: messagesConnectionId,
            description: "Read messages",
            id: "itl_00000000-0000-4000-8000-000000000001",
            name: "read_messages",
            schemaDigest: "d".repeat(43),
            serverId: "isv_00000000-0000-4000-8000-000000000001",
            status: "active",
            title: "Read messages",
          },
        ],
      },
    ],
  };
}

function application(input: { readonly id: string; readonly revision: number }) {
  return {
    availability: "personal",
    callbackUrl: "https://deployment.test/v1/integrations/oauth/callback/slack",
    canManage: true,
    clientId: "1234567890.987",
    configuredSecretFields: ["clientSecret"],
    createdAt: "2026-09-17T00:00:00.000Z",
    displayName: "Mattress Deal Finder Bot",
    id: input.id,
    ownerUserId: "usr_1",
    provider: "slack",
    revision: input.revision,
    status: "active",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}

function keyConnection(
  id: string,
  createdAt: string,
  state: {
    readonly status: "connected" | "needs-attention";
    readonly statusDetail: string | null;
  } = {
    status: "connected",
    statusDetail: null,
  },
) {
  return {
    ...connection(id, "Slack"),
    accountIdentifier: null,
    applicationSource: { kind: "api-key" as const },
    authMethodId: "api-key",
    connectionMethod: "api-key",
    createdAt,
    externalIdentityId: null,
    externalTenantId: null,
    grantedScopes: [],
    ...state,
  };
}

const githubConnectionId = "con_00000000-0000-4000-8000-0000000000b1";
const rejectedSignIn = "GitHub rejected the saved sign-in";

/** A GitHub sign-in that worked, waiting for its app to reach a repository. */
function githubConnection(id: string) {
  return {
    ...connection(id, "steerlabs"),
    accountIdentifier: "steerlabs",
    definitionId: "github",
    provider: "github",
    status: "needs-attention",
    statusReason: "permissions" as string | null,
  };
}

/** The Host's answer to GitHub's 401: the account needs a new sign-in. */
function rejectSignIn(account: ReturnType<typeof githubConnection>) {
  account.statusDetail = rejectedSignIn;
  account.statusReason = null;
  return {
    error: { code: "conflict", message: rejectedSignIn, retryable: false },
    ok: false as const,
  };
}

function completed(connectionId: string) {
  return {
    connectionId,
    expiresAt: "2026-09-17T00:10:00.000Z",
    failureCode: null,
    status: "completed",
  };
}

function connection(id: string, displayName = "Oversteer") {
  return {
    accountIdentifier: "oversteer.slack.com",
    applicationSource: hosted,
    authMethodId: "oauth",
    authorizationDigest: "a".repeat(43),
    connectionMethod: "managed-oauth",
    createdAt: "2026-09-17T00:00:00.000Z",
    definitionId: "slack",
    displayName,
    externalIdentityId: "B01BOT",
    externalTenantId: "T01ABCDEF",
    grantedScopes: ["chat:write"],
    id,
    provider: "slack",
    providerApplicationId: null,
    status: "connected",
    statusDetail: null as string | null,
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}
