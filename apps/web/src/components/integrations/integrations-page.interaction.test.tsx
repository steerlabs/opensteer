// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAgentProposedDetail } from "@opensteer/core";
import {
  MockHostClient,
  mockGitHubRevoked,
  mockGmailProposal,
  mockMcpProposal,
  mockSlackMcp,
  mockVapi,
} from "@opensteer/client/mock";
import { ConnectedAppsLayout } from "../settings/connected-apps.js";
import { installationRowId } from "./catalog-section.js";
import { IntegrationsPage } from "./integrations-page.js";
import { ToastProvider } from "../toast.js";

const shellState = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../app-shell.js", () => ({ useShell: () => shellState.current }));

const mountedRoots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  shellState.current = null;
});

describe("Settings manages an agent-proposed integration like any other", () => {
  // The ways it could fail: the proposal missing from the services, or listed
  // twice (as a service and as an installed row); nothing saying an agent
  // proposed it, or a catalog Install offered for what is installed already;
  // the broken account offering only Disconnect; Reconnect opening a blank key
  // form that adds a third account, or binding the same-named twin; the old
  // name lost, the button reading Connect; the destination, the check, or the
  // agent's guidance unattributed or missing; the waiting task left waiting;
  // a status chip that reads "needs attention" here and "Needs attention" on
  // the card; the provenance chip unexplained, or the page header repeating
  // the Connected apps heading and tab above it; where to make the key said
  // twice, or without a link; what agents can call counted as "tools" here and
  // as "operations" on the request card.
  it("repairs the rejected key in place from Your accounts, and the waiting task settles", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const connectionsBefore = await mockConnections(client);
    expect(client.getSnapshot().requests[mockVapi.threadId]).toHaveLength(1);
    const container = await mountSettings(client);

    const cards = [...container.querySelectorAll(".intg-card")].filter((card) =>
      card.textContent?.includes("Vapi API"),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain("Proposed by an agent");
    expect(cards[0]?.querySelector(".intg-card__meta .chip[title]")?.getAttribute("title")).toBe(
      requestAgentProposedDetail,
    );
    expect(cards[0]?.textContent).toContain("Needs attention");
    expect(container.textContent).not.toContain("Apps agents can use");
    expect(container.querySelector("h1")).toBeNull();
    expect(cards[0]?.textContent).not.toContain("Install");
    expect(container.querySelector(`#${installationRowId(mockVapi.installationId)}`)).toBeNull();

    const vapiRows = accountRows(container).filter((row) => row.textContent?.includes("Vapi API"));
    expect(vapiRows).toHaveLength(2);
    const rejected = vapiRows.find((row) =>
      row.textContent?.includes("Vapi API rejected the saved key"),
    );
    const twin = vapiRows.find((row) => row !== rejected);
    if (!rejected || !twin) throw new Error("Both Vapi accounts are listed.");
    expect(rejected.querySelector(".chip")?.textContent).toBe("Needs attention");
    expect(twin.querySelector(".chip")?.textContent).toBe("Connected");
    expect(buttonWithText(twin, "Reconnect")).toBeNull();
    expect(buttonWithText(twin, "Manage")).not.toBeNull();
    await click(buttonWithText(rejected, "Reconnect"));

    expect(container.textContent).toContain("Replace the key for Vapi API");
    const hero = container.querySelector(".intg-hero");
    expect(hero?.textContent).toContain("Proposed by an agent");
    expect(hero?.querySelector(".intg-provenance")?.getAttribute("title")).toBe(
      requestAgentProposedDetail,
    );
    expect(hero?.querySelector(".intg-hero__provenance")?.textContent).toBe(
      requestAgentProposedDetail,
    );
    expect(container.textContent).not.toContain("Grants are always scoped");
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="Vapi API account"]')?.value,
    ).toBe("Vapi API");
    expect(buttonWithText(container, "Reconnect account")?.getAttribute("type")).toBe("submit");
    expect(buttonWithText(container, "Connect Vapi API")).toBeNull();
    expect(buttonWithText(container, "Install Vapi API")).toBeNull();
    expect(container.textContent).toContain(
      "From the agent’s proposal: Use the private key from the Vapi dashboard, not the public one.",
    );
    // Where to make the key is said once, linked by the setup page's host.
    const setup = [...container.querySelectorAll("p")].filter((line) =>
      line.textContent?.includes("paste it here"),
    );
    expect(setup.map((line) => line.textContent)).toEqual([
      "Get your API key at dashboard.vapi.ai, then paste it here.",
    ]);
    expect(setup[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://dashboard.vapi.ai/org/api-keys",
    );
    expect(
      container.querySelectorAll('a[href="https://dashboard.vapi.ai/org/api-keys"]'),
    ).toHaveLength(1);
    // What agents can call is shown by the agent's request, not listed here.
    expect(container.textContent).not.toContain("What agents can do");
    expect(container.textContent).toContain(
      "Your key is stored encrypted by your Opensteer and sent to api.vapi.ai when used.",
    );
    expect(container.textContent).toContain(
      "Opensteer checks the key with Vapi API before saving it.",
    );

    const key = container.querySelector<HTMLInputElement>('input[type="password"]');
    if (!key) throw new Error("The key field is shown at once.");
    await typeInto(key, "replacement-key");
    await act(async () => key.form?.requestSubmit());

    await vi.waitFor(() => expect(container.textContent).toContain("Vapi API connected"));
    const connectionsAfter = await mockConnections(client);
    expect(connectionsAfter).toHaveLength(connectionsBefore.length);
    expect(connectionsAfter.find(({ id }) => id === mockVapi.connectionId)).toMatchObject({
      displayName: "Vapi API",
      status: "connected",
      statusDetail: null,
    });
    expect(connectionsAfter.find(({ id }) => id === mockVapi.twinConnectionId)).toEqual(
      connectionsBefore.find(({ id }) => id === mockVapi.twinConnectionId),
    );
    expect(client.getSnapshot().requests[mockVapi.threadId] ?? []).toEqual([]);
    const repaired = accountRows(container).filter((row) => row.textContent?.includes("Vapi API"));
    expect(repaired).toHaveLength(2);
    expect(repaired.some((row) => buttonWithText(row, "Reconnect"))).toBe(false);
  });

  it("reconnects a key from the integration's own page and lets an administrator uninstall it", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);

    const card = [...container.querySelectorAll<HTMLButtonElement>(".intg-card")].find(
      (candidate) => candidate.textContent?.includes("Vapi API"),
    );
    await click(card ?? null);

    // The accounts share a name, so each says when it was added; only the
    // rejected one is offered a new key, and nothing offers an empty one that
    // would become a third account until the person asks for another.
    const rows = sectionRows(container, "Accounts").filter((row) =>
      row.textContent?.includes("Vapi API"),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.textContent).toMatch(/Added Aug 9/u);
    const rejected = rows.find((row) => accountReason(row)?.includes("rejected the saved key"));
    expect(rows.filter((row) => buttonWithText(row, "Reconnect"))).toEqual([rejected]);
    expect(container.textContent).toContain("Add another key");
    // Where the key is made is linked by the key form, the one place it is needed.
    const setupLinks = () =>
      container.querySelectorAll('a[href="https://dashboard.vapi.ai/org/api-keys"]');
    expect(setupLinks()).toHaveLength(0);
    await click(buttonWithText(rejected ?? container, "Reconnect"));
    expect(container.textContent).toContain("Replace the key for Vapi API");
    expect(buttonWithText(container, "Reconnect account")).not.toBeNull();
    expect(setupLinks()).toHaveLength(1);

    await click(buttonWithText(container, "Uninstall Vapi API"));
    await click(buttonWithText(container, "Confirm uninstall"));

    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "2 connected accounts removed, 1 pending request cancelled.",
      ),
    );
    expect(container.textContent).not.toContain("Vapi API");
    expect(
      (await mockConnections(client)).filter(({ definitionId }) => definitionId === "vapi-api"),
    ).toEqual([]);
  });
});

describe("Settings describes an installed integration by what it installed", () => {
  // The way it could fail: the key form naming the catalog's projection, the
  // provider's name, instead of the hosts the installed snapshot sends the key to.
  it("discloses where a preset's key goes from its installed snapshot", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);

    await click(card(container, "Notion"));
    await click(buttonWithText(container, "Use an API key"));

    expect(container.textContent).toContain("Or use an API key");
    expect(container.textContent).toContain(
      "Get your Internal integration secret at www.notion.so, then paste it here.",
    );
    const setup = container.querySelector('a[href="https://www.notion.so/my-integrations"]');
    expect(setup?.textContent).toBe("www.notion.so");
    expect(container.textContent).toContain(
      "Your key is stored encrypted by your Opensteer and sent to api.notion.com when used.",
    );
    expect(container.textContent).not.toContain("sent to Notion when used");
  });

  // The ways it could fail: installing a preset keeps the catalog's projection,
  // which knows no hosts, so the installed key form has nothing true to say;
  // the install notice speaking of snapshots and interfaces instead of what
  // installing does and what comes next.
  it("discloses an installed preset's hosts once an administrator installs it", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);

    await click(card(container, "Resend REST"));
    expect(container.textContent).toContain(
      "Install Resend REST so agents can use it. You’ll add your key next. Installing doesn’t give any Workspace access.",
    );
    expect(container.textContent).not.toContain("snapshots");
    expect(container.textContent).not.toContain("stored encrypted by your Opensteer");
    await click(buttonWithText(container, "Install Resend REST"));

    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Your key is stored encrypted by your Opensteer and sent to api.resend.com when used.",
      ),
    );
    expect(container.textContent).toContain("Get your API key at resend.com, then paste it here.");
  });

  // The ways it could fail: an unavailable preset reading as connectable, its
  // reason hidden, or nothing an administrator can do short of the database.
  it("shows why a preset is unavailable and lets an administrator reinstall it", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const reason = "Opensteer can’t tell where this integration sends its key.";
    withNotionUnavailable(client, reason);
    const dispatch = vi.spyOn(client, "dispatch");
    const container = await mountSettings(client);

    await click(card(container, "Notion"));

    expect(container.textContent).toContain("Notion is unavailable");
    expect(container.textContent).toContain(reason);
    await click(buttonWithText(container, "Reinstall Notion"));
    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ definitionId: "notion" }),
          type: "integration.catalog.install",
        }),
      ),
    );
  });
});

describe("Settings manages a proposed MCP server's accounts", () => {
  // The ways it could fail: the card offering a connection, or Install, while
  // an MCP account is connected; the page saying no account is connected, or
  // not listing it, or listing it twice; Disconnect missing, or sent as a
  // provider disconnect the Host cannot match; the page not settling back to
  // "No account yet" once the account is gone, or saying it as a warning. For
  // an account that needs authorizing again: the card reading Connected, the
  // page offering a Reconnect it cannot start, or not saying where authorizing
  // happens.
  it("reads as connected, lists the account, and disconnects it", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);
    const trellis = "mcp.trellis.example";

    const cardBefore = card(container, trellis);
    expect(cardBefore?.textContent).toContain("Proposed by an agent");
    expect(cardBefore?.textContent).toContain("Connected");
    expect(cardBefore?.textContent).not.toContain("No account yet");
    expect(cardBefore?.textContent).not.toContain("Install");
    expect(
      container.querySelector(`#${installationRowId(mockMcpProposal.installationId)}`),
    ).toBeNull();
    await click(cardBefore);

    expect(container.querySelector(".intg-hero")?.textContent).toContain("Proposed by an agent");
    expect(container.textContent).not.toContain("No account yet");
    expect(container.textContent).not.toContain(`Authorize ${trellis} again`);
    const rows = sectionRows(container, "Accounts");
    expect(rows).toHaveLength(1);
    // Named by who it is at the provider, with one word for its state.
    expect(rows[0]?.querySelector(".intg-account__title")?.textContent).toBe("alex@example.com");
    expect(accountStatus(rows[0])).toBe("Connected");
    expect(container.textContent).not.toContain("List boards");

    await click(buttonWithText(rows[0] ?? container, "Disconnect"));
    await click(buttonWithText(rows[0] ?? container, "Confirm disconnect"));

    await vi.waitFor(() => expect(container.textContent).toContain("No account yet"));
    expect(container.querySelector(".notice--warn")).toBeNull();
    expect(container.textContent).toContain(
      "When an agent first needs this integration, you’ll review the tools it wants to use and sign in.",
    );
    expect(container.textContent).not.toContain("OAuth flow");
    expect(() => sectionRows(container, "Accounts")).toThrow();
    const platform = await client.rpc["integration.platform.get"]({});
    if (!platform.ok) throw new Error("The mock Host lists installations.");
    expect(
      platform.data.connections.find(
        ({ connectionId }) => connectionId === mockMcpProposal.connectionId,
      )?.status,
    ).toBe("revoked");

    await click(container.querySelector<HTMLButtonElement>(".page__back"));
    expect(cardState(container, trellis)).toBe("No account yet");
    expect(card(container, trellis)?.querySelector(".intg-card__state .chip")?.className).toBe(
      "chip",
    );
  });

  it("says an account that needs authorizing again is repaired from an agent's request", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    withMcpAccountNeedingAuthorization(client);
    const container = await mountSettings(client);
    const trellis = "mcp.trellis.example";

    const cardBefore = card(container, trellis);
    expect(cardBefore?.textContent).toContain("Needs attention");
    expect(cardBefore?.textContent).not.toContain("Connected");
    await click(cardBefore);

    const rows = sectionRows(container, "Accounts");
    expect(rows).toHaveLength(1);
    expect(accountStatus(rows[0])).toBe("Needs attention");
    expect(buttonWithText(rows[0] ?? container, "Disconnect")).not.toBeNull();
    expect(buttonWithText(container, "Reconnect")).toBeNull();
    expect(container.textContent).not.toContain("No account yet");
    expect(container.textContent).toContain(`Authorize ${trellis} again`);
    expect(container.textContent).toContain(
      `The next request that needs ${trellis} asks you to authorize it again.`,
    );
  });
});

describe("Settings puts what the user has, and what needs them, first", () => {
  // The ways it could fail: the catalog of presets ahead of the services this
  // deployment has; an installed service listed among presets, or a preset
  // among installed services; a service that needs someone buried behind
  // ready ones; account repair below the presets; two sections both called
  // installed; a broken installation's card reading the same as a broken
  // account's, or a turned-off one reading as unavailable.
  it("lists installed services, attention first, then accounts, and presets last", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);

    expect(sectionTitles(container)).toEqual([
      "Installed services",
      "Your accounts",
      "Apps on your computers",
      "Workspace access",
      "Agent Plugins and MCP servers",
      "Add a service",
    ]);

    const installed = sectionCards(container, "Installed services");
    const states = installed.map((service) => service.querySelector(".intg-card__state"));
    const needsSomeone = states.map((state) =>
      ["Needs attention", "Unavailable", "Turned off"].includes(state?.textContent ?? ""),
    );
    expect(needsSomeone.indexOf(false)).toBeGreaterThan(0);
    expect(needsSomeone.slice(needsSomeone.indexOf(false))).not.toContain(true);
    expect(installed.some((service) => service.textContent?.includes("Install"))).toBe(false);
    expect(cardState(container, "Gmail API")).toBe("Unavailable");
    expect(cardState(container, "Slack MCP")).toBe("Turned off");
    expect(cardState(container, "Google Calendar")).toBe("Needs attention");
    expect(cardState(container, "Linear GraphQL")).toBe("Connected");

    // Every catalog preset not yet installed, in catalog order. The Host lists
    // its whole catalog, so the apps that run on a person's own device are
    // offered too, and each says which device it needs: someone with no iPhone
    // reads that a Mac serves it, and an installed app is never offered again.
    const available = sectionCards(container, "Add a service");
    expect(
      available.map((preset) => [
        preset.querySelector(".intg-card__name")?.textContent,
        preset.querySelector(".intg-card__requirement")?.textContent ?? null,
        preset.querySelector(".intg-card__state")?.textContent,
      ]),
    ).toEqual([
      ["Contacts", "Requires a Mac or an iPhone", "Install"],
      ["Calendar", "Requires a Mac or an iPhone", "Install"],
      ["Reminders", "Requires a Mac or an iPhone", "Install"],
      ["Location", "Requires an iPhone", "Install"],
      ["Photos", "Requires an iPhone", "Install"],
      ["Resend REST", null, "Install"],
    ]);
  });
});

describe("Settings explains an installation that is not active", () => {
  // The ways it could fail: the page saying nothing about why the proposal
  // cannot be used, or hiding the reason the Host stored; offering to connect
  // an account, or to reinstall something that is not a preset; listing what
  // agents can do with it; leaving no way out but the database.
  it("says why an agent's proposal is unavailable, and offers only Uninstall", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);

    await click(card(container, "Gmail API"));

    const notice = container.querySelector('[role="alert"]');
    expect(notice?.querySelector("strong")?.textContent).toBe("Gmail API is unavailable");
    expect(notice?.textContent).toContain(mockGmailProposal.reason);
    expect(container.textContent).toContain("Proposed by an agent");
    expect(container.textContent).not.toContain("Connect your account");
    expect(buttonWithText(container, "Connect Gmail API")).toBeNull();
    expect(buttonWithText(container, "Reinstall Gmail API")).toBeNull();
    expect(container.textContent).not.toContain("What agents can do");

    await click(buttonWithText(container, "Uninstall Gmail API"));
    await click(buttonWithText(container, "Confirm uninstall"));
    await vi.waitFor(() => expect(card(container, "Gmail API")).toBeNull());
  });

  // The ways it could fail: the retired preset reading "No account yet" and
  // promising a sign-in nothing can start; "unavailable" for something that
  // was turned off; a notice that says neither why nor what to do next;
  // Reinstall offered for a preset the catalog no longer has.
  it("says a turned-off installation is turned off, and offers no way to connect it", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);

    await click(card(container, "Slack MCP"));

    const notice = container.querySelector('[role="alert"]');
    expect(notice?.querySelector("strong")?.textContent).toBe("Slack MCP is turned off");
    expect(notice?.querySelector("p")?.textContent).toBe(mockSlackMcp.reason);
    expect(container.textContent).not.toContain("No account yet");
    expect(container.textContent).not.toContain("sign in");
    expect(buttonWithText(container, "Reinstall Slack MCP")).toBeNull();
    expect(buttonWithText(container, "Uninstall Slack MCP")).not.toBeNull();
  });
});

describe("Settings reconnects an OAuth account by signing in again", () => {
  // The ways it could fail: a row that says "reconnect this account" offering
  // only Disconnect; Reconnect on the overview dropping the user on a page
  // with no matching button; the sheet not saying which account to sign in
  // as; the sign-in adding a third account instead of repairing this one, or
  // repairing its same-named twin; a key account losing its key form.
  it("starts the sign-in from the account's row, and repairs that account in place", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const dispatch = vi.spyOn(client, "dispatch");
    vi.spyOn(window, "open").mockReturnValue(authorizationTab());
    const container = await mountSettings(client);
    const before = await googleCalendarAccounts(client);
    expect(before.map(({ status }) => status)).toEqual(["needs-attention", "needs-attention"]);

    await click(card(container, "Google Calendar"));
    const rows = sectionRows(container, "Accounts");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // What to do, in one line; the Host's reason stays on hover.
      expect(accountStatus(row)).toBe("Sign in again to keep using it");
      expect(row.querySelector(".intg-account__status")?.getAttribute("title")).toBe(
        "Opensteer changed how this service connects. Reconnect this account to keep using it.",
      );
      expect(buttonWithText(row, "Disconnect")).not.toBeNull();
    }
    const broken = rows.find((row) => row.textContent?.includes("alex@example.com"));
    await click(buttonWithText(broken ?? container, "Reconnect"));

    // The Host has an app selected, so the tap goes straight to sign-in.
    expect(window.open).toHaveBeenCalledOnce();
    expect(buttonWithText(document.body, "Continue to Google Calendar")).toBeNull();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("alex@example.com is connected"),
    );
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ definitionId: "google-calendar" }),
        type: "integration.authorization.begin",
      }),
    );
    const after = await googleCalendarAccounts(client);
    expect(after.map(({ id }) => id)).toEqual(before.map(({ id }) => id));
    expect(after.find(({ id }) => id === before[0]?.id)?.status).toBe("connected");
    expect(after.find(({ id }) => id === before[1]?.id)).toEqual(before[1]);
  });

  it("starts the same sign-in from Your accounts, without leaving the overview", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    vi.spyOn(window, "open").mockReturnValue(authorizationTab());
    const container = await mountSettings(client);

    const row = accountRows(container).find((candidate) =>
      candidate.textContent?.includes("alex@opensteer.example · Google Calendar"),
    );
    expect(row?.querySelector(".chip")?.textContent).toBe("Needs attention");
    expect(buttonWithText(row ?? container, "Manage")).not.toBeNull();
    await click(buttonWithText(row ?? container, "Reconnect"));

    expect(window.open).toHaveBeenCalledOnce();
    // The provider names the account that comes back, and the toast says which.
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("alex@example.com is connected"),
    );
    expect(container.textContent).toContain("Installed services");
    expect(container.textContent).not.toContain("All integrations");
  });
});

describe("Settings signs in from another device", () => {
  // The ways it could fail: a phone or another computer attached through
  // Connect told to go back to the Mac for Opensteer's own sign-in, which
  // returns to the Account service and finishes anywhere; or offered a Reconnect
  // for an app whose sign-in returns to the Mac's loopback address, which it
  // can only start and never finish.
  it("reconnects through Opensteer's app from another device", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    asRemoteSession(client, { loopbackOnly: false });
    vi.spyOn(window, "open").mockReturnValue(authorizationTab());
    const container = await mountSettings(client);
    await click(card(container, "Google Calendar"));

    const broken = sectionRows(container, "Accounts").find((row) =>
      row.textContent?.includes("alex@example.com"),
    );
    await click(buttonWithText(broken ?? container, "Reconnect"));
    expect(window.open).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("alex@example.com is connected"),
    );
    expect(container.querySelector(".intg-account__elsewhere")).toBeNull();
  });

  it("says where a sign-in that returns to the Mac's loopback address finishes", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    asRemoteSession(client, { loopbackOnly: true });
    const container = await mountSettings(client);
    await click(card(container, "Google Calendar"));

    expect(container.querySelector<HTMLButtonElement>(".intg-account--add")?.disabled).toBe(true);
    for (const row of sectionRows(container, "Accounts")) {
      expect(buttonWithText(row, "Reconnect")?.disabled).toBe(true);
    }
    expect(container.querySelector(".intg-account__elsewhere")?.textContent).toContain(
      "so connect or reconnect accounts there",
    );
  });
});

/**
 * The Host's answer to a session attached from another device: Google's managed
 * sign-in as the mock seeds it, or only an app whose sign-in returns to the
 * Mac's loopback address, which the Host reports must be finished there.
 */
function asRemoteSession(client: MockHostClient, input: { readonly loopbackOnly: boolean }) {
  const read = client.rpc["integrations.get"];
  const loopback = {
    callbackUrl: "http://127.0.0.1:4310/v1/integrations/oauth/callback/google",
    kind: "deployment-oauth" as const,
    providerApplicationId: "ipa_00000000-0000-4000-8000-000000000001",
    providerApplicationRevision: 1,
  };
  withRpc(client, {
    "integrations.get": async (request: unknown) => {
      const answer = await read(request as Parameters<typeof read>[0]);
      if (!answer.ok) return answer;
      const google = answer.data.providerAuthorizations.google!;
      return {
        ...answer,
        data: {
          ...answer.data,
          authorizationSurface: "personal-remote",
          providerAuthorizations: {
            ...answer.data.providerAuthorizations,
            google: input.loopbackOnly
              ? {
                  ...google,
                  availableSources: [loopback],
                  code: "CANONICAL_SURFACE_REQUIRED",
                  detail:
                    "This sign-in returns to the computer running Opensteer, so finish it there.",
                  selectedSource: loopback,
                  selectedSourceKind: "deployment-oauth",
                }
              : google,
          },
        },
      };
    },
  });
}

describe("Settings says which integration an agent proposed wherever one is chosen", () => {
  // The ways it could fail: an agent names its proposal "Google Calendar", and
  // the Workspace grant selector offers two identical "Google Calendar"
  // options, so access goes to the wrong one; the marker missing from the
  // accounts listed under Your accounts, from a proposed MCP server's account,
  // or from the grant it was given; the marker put on the catalog's own
  // integration, or unexplained.
  it("marks the proposal in Your accounts, the grant selector and its grant", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    withProposalNamed(client, "Google Calendar");
    const container = await mountSettings(client);

    const marked = (row: HTMLElement) =>
      [...row.querySelectorAll<HTMLElement>(".chip")].find(
        (chip) => chip.textContent === "Proposed by an agent",
      );
    const named = (name: string) => (row: HTMLElement) =>
      row.querySelector(".card__row-title")?.textContent?.startsWith(name) === true;
    const vapiRows = accountRows(container).filter(named("Vapi API"));
    expect(vapiRows).toHaveLength(2);
    for (const row of vapiRows) {
      expect(row.textContent).toContain("Google Calendar");
      expect(marked(row)?.getAttribute("title")).toBe(requestAgentProposedDetail);
    }
    const catalogCalendar = (await googleCalendarAccounts(client)).map(({ displayName }) =>
      accountRows(container).find(named(displayName)),
    );
    expect(catalogCalendar.length).toBeGreaterThan(0);
    for (const row of catalogCalendar) expect(row && marked(row)).toBeUndefined();
    const mcpAccount = accountRows(container).find((row) =>
      row.textContent?.includes("mcp.trellis.example"),
    );
    expect(mcpAccount && marked(mcpAccount)).toBeTruthy();

    const workspace = [...container.querySelectorAll<HTMLSelectElement>("select")].find((select) =>
      [...select.options].some((option) => option.textContent === "Customer launch"),
    );
    await choose(workspace ?? null, "wsp_00000000-0000-4000-8000-000000000002");
    await click(
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Allow an integration"),
      ) ?? null,
    );
    const integration = container.querySelector<HTMLSelectElement>(".card__form select");
    const labels = [...(integration?.options ?? [])].map((option) => option.textContent);
    expect(labels.filter((label) => label === "Google Calendar")).toHaveLength(1);
    expect(
      labels.filter((label) => label === "Google Calendar · Proposed by an agent"),
    ).toHaveLength(1);

    const before = sectionRows(container, "Workspace access").length;
    await choose(integration, mockVapi.installationId);
    await click(buttonWithText(container, "Allow access"));
    await vi.waitFor(() =>
      expect(sectionRows(container, "Workspace access")).toHaveLength(before + 1),
    );
    const grants = sectionRows(container, "Workspace access").filter((row) =>
      [...row.querySelectorAll(".chip")].some((chip) => chip.textContent === "Google Calendar"),
    );
    expect(grants.filter((row) => marked(row))).toHaveLength(1);
    expect(grants.map((row) => marked(row)?.getAttribute("title") ?? null)).toContain(
      requestAgentProposedDetail,
    );
  });
});

describe("Settings repairs each GitHub account the way the Host says it needs", () => {
  const appGone =
    "The OAuth app used by this account changed or is unavailable. Reconnect the account.";
  const noRepositories =
    "Install or configure this GitHub App for at least one repository you can access, then check again.";
  // The ways it could fail: every GitHub account that needs attention offered
  // "Set up repositories", including one whose OAuth app is gone, so the
  // check refuses it and nothing offers Reconnect; the account waiting only
  // for repositories sent to sign in again instead; the overview and the
  // account's own page offering different repairs; either repair reaching
  // the other account.
  it("offers repositories to the account waiting for them, and a sign-in to the other", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const checked = repositoryChecks(client);
    vi.spyOn(window, "open").mockReturnValue(authorizationTab());
    const container = await mountSettings(client);
    const github = (await mockConnections(client)).filter(
      ({ definitionId }) => definitionId === "github",
    );
    const waiting = github.find(({ statusReason }) => statusReason === "permissions");
    if (!waiting) throw new Error("The mock seeds a GitHub account waiting for repositories.");

    const repairs = (rows: readonly HTMLElement[]) =>
      ["octocat", "opensteer-release-bot", "opensteer-docs"].map((name) => {
        const row = rows.find((candidate) =>
          candidate.querySelector(".card__row-title")?.textContent?.startsWith(name),
        );
        return [
          name,
          row?.querySelector(".chip")?.textContent,
          ["Reconnect", "Set up repositories"].filter((label) => buttonWithText(row!, label)),
        ];
      });
    const expected = [
      ["octocat", "Connected", []],
      ["opensteer-release-bot", "Needs attention", ["Reconnect"]],
      ["opensteer-docs", "Needs attention", ["Set up repositories"]],
    ];
    expect(repairs(accountRows(container))).toEqual(expected);
    expect(accountRows(container).find((row) => row.textContent?.includes(appGone))).toBeTruthy();

    await click(card(container, "GitHub REST"));
    const rows = sectionRows(container, "Accounts");
    // The integration's own page says what to do rather than why.
    expect(
      ["octocat", "opensteer-release-bot", "opensteer-docs"].map((name) => {
        const row = rows.find(
          (candidate) => candidate.querySelector(".intg-account__title")?.textContent === name,
        );
        return [
          name,
          accountStatus(row),
          ["Reconnect", "Set up repositories"].filter((label) => buttonWithText(row!, label)),
        ];
      }),
    ).toEqual([
      ["octocat", "Connected", []],
      ["opensteer-release-bot", "Sign in again to keep using it", ["Reconnect"]],
      ["opensteer-docs", "Choose repositories to finish connecting", ["Set up repositories"]],
    ]);
    expect(rows.find((row) => accountReason(row)?.includes(noRepositories))).toBeTruthy();

    const docs = rows.find(
      (row) => row.querySelector(".intg-account__title")?.textContent === "opensteer-docs",
    );
    await click(buttonWithText(docs ?? container, "Set up repositories"));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Repository access is still required"),
    );
    expect(checked).toEqual([waiting.id]);

    const bot = accountRows(container).find((row) =>
      row.textContent?.startsWith("opensteer-release-bot"),
    );
    vi.spyOn(window, "open").mockReturnValue(authorizationTab());
    await click(buttonWithText(bot ?? container, "Reconnect"));
    // Signing in again goes straight to GitHub; it is not a repository check.
    expect(window.open).toHaveBeenCalledOnce();
  });

  // The ways it could fail: GitHub has revoked the token of an account waiting
  // for repositories, and after the check says so the account still offers
  // "Set up repositories", which can only be refused again; nothing says why;
  // the sign-in it is offered instead naming some other account.
  it("sends an account whose token GitHub refused to sign in again", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const checked = repositoryChecks(client);
    vi.spyOn(window, "open").mockReturnValue(authorizationTab());
    const container = await mountSettings(client);
    const revoked = () =>
      accountRows(container).find((row) =>
        row.querySelector(".card__row-title")?.textContent?.startsWith("opensteer-ci"),
      ) ?? null;

    await click(buttonWithText(revoked() ?? container, "Set up repositories"));

    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "GitHub REST rejected the saved sign-in",
      ),
    );
    await vi.waitFor(() => expect(buttonWithText(revoked()!, "Reconnect")).not.toBeNull());
    expect(buttonWithText(revoked()!, "Set up repositories")).toBeNull();
    expect(revoked()?.textContent).toContain("GitHub REST rejected the saved sign-in");
    expect(checked).toEqual([mockGitHubRevoked.connectionId]);

    await click(buttonWithText(revoked()!, "Reconnect"));
    expect(window.open).toHaveBeenCalledOnce();
  });

  // The ways it could fail: the reload after a refused recheck left detached,
  // so the step stops reading "Checking…" before the account is known again,
  // and a reload that fails goes unhandled; the step closed although the Host
  // was never asked what the refusal did to the account.
  it("keeps checking until the account is reloaded, and keeps the step when it cannot be", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const unavailable = "GitHub repository access could not be checked. Retry in a moment.";
    const container = await mountSettings(client);
    const docs = accountRows(container).find((row) =>
      row.textContent?.startsWith("opensteer-docs"),
    );
    await click(buttonWithText(docs ?? container, "Set up repositories"));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Repository access is still required"),
    );

    let failReload!: (reason: Error) => void;
    withRpc(client, {
      "integration.repositoryAccess.check": async () => ({
        error: { code: "internal", message: unavailable, retryable: false },
        ok: false,
      }),
      "integrations.get": () =>
        new Promise((_, reject) => {
          failReload = reject;
        }),
    });
    await click(buttonWithText(container, "Recheck repository access"));

    expect(buttonWithText(container, "Checking…")?.disabled).toBe(true);
    await act(async () => failReload(new Error("This deployment could not be reached.")));

    expect(
      [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
    ).toEqual(["This deployment could not be reached.", unavailable]);
    expect(container.textContent).toContain("Repository access is still required");
    expect(buttonWithText(container, "Recheck repository access")?.disabled).toBe(false);
  });

  // The ways it could fail: a refusal about one account closing the
  // repository step open for another, or leaving the refused account
  // offering the step it was refused.
  it("closes only the refused account's own repository step", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);
    const row = (name: string) =>
      accountRows(container).find((candidate) =>
        candidate.querySelector(".card__row-title")?.textContent?.startsWith(name),
      ) ?? null;
    await click(buttonWithText(row("opensteer-docs") ?? container, "Set up repositories"));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Repository access is still required"),
    );

    await click(buttonWithText(row("opensteer-ci") ?? container, "Set up repositories"));

    await vi.waitFor(() =>
      expect(buttonWithText(row("opensteer-ci")!, "Reconnect")).not.toBeNull(),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "GitHub REST rejected the saved sign-in",
    );
    expect(container.textContent).toContain("Repository access is still required");
    expect(buttonWithText(container, "Recheck repository access")).not.toBeNull();
  });

  // The ways it could fail: the browser returns from a GitHub sign-in, and
  // while its repository check is out the person starts another sign-in,
  // which cancels the return. The check, refused only now, leaves its error
  // behind the new sheet, where nothing clears it even once that one connects.
  it("leaves a sign-in opened since alone when the cancelled return's check is refused", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const reconnecting = "Sign in to GitHub REST as opensteer-release-bot to reconnect it.";
    const check = client.rpc["integration.repositoryAccess.check"];
    let answerCheck = () => {};
    const held = vi.fn(
      (input: unknown) =>
        new Promise((resolve) => {
          answerCheck = () => resolve(check(input as Parameters<typeof check>[0]));
        }),
    );
    const returned = "ioa_00000000-0000-4000-8000-0000000000a1";
    withRpc(client, {
      // The returned sign-in completed; the one started since is still at GitHub.
      "integration.authorization.get": async (input: unknown) => ({
        data: {
          connectionId:
            (input as { attemptId: string }).attemptId === returned
              ? mockGitHubRevoked.connectionId
              : null,
          // Still inside its window, whenever the test runs.
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          failureCode: null,
          status:
            (input as { attemptId: string }).attemptId === returned ? "completed" : "launched",
        },
        ok: true,
      }),
      "integration.repositoryAccess.check": held,
    });
    vi.spyOn(window, "open").mockReturnValue(authorizationTab());
    const container = await mountSettings(client, {
      path: `/settings/apps/tools?integrationAttempt=${returned}`,
    });
    await vi.waitFor(() => expect(held).toHaveBeenCalledTimes(1));
    const bot = accountRows(container).find((row) =>
      row.textContent?.startsWith("opensteer-release-bot"),
    );
    await click(buttonWithText(bot ?? container, "Reconnect"));
    expect(document.body.textContent).toContain(reconnecting);

    await act(async () => answerCheck());

    expect(document.body.textContent).toContain(reconnecting);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // The ways it could fail: the browser returns from signing in as one
  // account, and while its repository check is out the person opens another
  // account's repository step. The return's answer, either one, closes that
  // step or puts its own in its place, and a recheck reaches the wrong account.
  it.each([true, false])(
    "leaves another account's repository step alone when the return answers ready=%s",
    async (ready) => {
      const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
      const docs = (await mockConnections(client)).find(({ accountIdentifier, displayName }) =>
        (accountIdentifier ?? displayName).startsWith("opensteer-docs"),
      );
      if (!docs) throw new Error("The mock seeds opensteer-docs waiting for repositories.");
      const answerReturn = withHeldReturnCheck(client, mockGitHubRevoked.connectionId);
      const checked = repositoryChecks(client);
      const container = await mountSettings(client, {
        path: `/settings/apps/tools?integrationAttempt=${returnedAttempt}`,
      });
      await vi.waitFor(() => expect(container.textContent).toContain("could not be checked"));
      const row = accountRows(container).find((candidate) =>
        candidate.textContent?.startsWith("opensteer-docs"),
      );
      await click(buttonWithText(row ?? container, "Set up repositories"));
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Repository access is still required"),
      );

      await act(async () => answerReturn(ready));

      expect(container.textContent).toContain("Repository access is still required");
      expect(container.textContent).not.toContain("returned-org");
      await click(buttonWithText(container, "Recheck repository access"));
      expect(checked.at(-1)).toBe(docs.id);
    },
  );

  // The ways it could fail: while the return's first check is out, the
  // person rechecks and the recheck finds the repositories; the first check,
  // answering late that they are missing, opens the closed step again and
  // takes away the notice that the account is connected.
  it("keeps what a recheck found when the return's first check answers later", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const answerReturn = withHeldReturnCheck(client, mockGitHubRevoked.connectionId);
    const container = await mountSettings(client, {
      path: `/settings/apps/tools?integrationAttempt=${returnedAttempt}`,
    });
    await vi.waitFor(() => expect(container.textContent).toContain("could not be checked"));
    await click(buttonWithText(container, "Recheck repository access"));
    await vi.waitFor(() => expect(container.textContent).toContain("Github connected"));
    expect(container.textContent).not.toContain("Recheck repository access");

    await act(async () => answerReturn(false));

    expect(container.textContent).toContain("Github connected");
    expect(container.textContent).not.toContain("Recheck repository access");
  });

  // The ways it could fail: a recheck takes the step from the return and
  // finds the repositories, and before the return's own check answers the
  // person opens and closes another account's sign-in. The return runs again:
  // it checks once more and reopens the step the recheck finished.
  it("finishes the return when a recheck takes its step, before its own check answers", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const answerReturn = withHeldReturnCheck(client, mockGitHubRevoked.connectionId);
    const checked = repositoryChecks(client);
    const container = await mountSettings(client, {
      path: `/settings/apps/tools?integrationAttempt=${returnedAttempt}`,
    });
    await vi.waitFor(() => expect(container.textContent).toContain("could not be checked"));
    await click(buttonWithText(container, "Recheck repository access"));
    await vi.waitFor(() => expect(container.textContent).toContain("Github connected"));

    const bot = accountRows(container).find((row) =>
      row.textContent?.startsWith("opensteer-release-bot"),
    );
    withPendingSignIns(client, returnedAttempt);
    await click(buttonWithText(bot ?? container, "Reconnect"));
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'));

    expect(checked).toHaveLength(2);
    expect(container.textContent).not.toContain("Recheck repository access");
    await act(async () => answerReturn(false));

    expect(checked).toHaveLength(2);
    expect(container.textContent).not.toContain("Recheck repository access");
  });

  // The ways it could fail: the return's first check is refused, and while
  // the account reload that follows is out the person rechecks and the
  // recheck finds the repositories. The older reload, answering last, puts the
  // account back as it read it, waiting for repositories or needing a sign-in
  // with that error shown again, under the notice that it is connected.
  it.each([
    ["waiting for repositories", { statusDetail: noRepositories, statusReason: "permissions" }],
    [
      "needing a sign-in",
      { statusDetail: "GitHub REST rejected the saved sign-in", statusReason: null },
    ],
  ] as const)(
    "keeps what a recheck found when the refused return's reload reads the account %s",
    async (_, earlier) => {
      const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
      const docs = (await mockConnections(client)).find(({ accountIdentifier }) =>
        accountIdentifier?.startsWith("opensteer-docs"),
      );
      if (!docs) throw new Error("The mock seeds opensteer-docs waiting for repositories.");
      const integrationsGet = client.rpc["integrations.get"];
      let checks = 0;
      let answerReload: (() => void) | null = null;
      withRpc(client, {
        "integration.authorization.get": async () => ({
          data: {
            connectionId: docs.id,
            expiresAt: "2026-10-17T20:00:00.000Z",
            failureCode: null,
            status: "completed",
          },
          ok: true,
        }),
        "integration.repositoryAccess.check": async () =>
          ++checks === 1
            ? { error: { code: "internal", message: "Check refused", retryable: true }, ok: false }
            : { data: { installationUrl: null, installations: [], ready: true }, ok: true },
        "integrations.get": async () => {
          const answer = await integrationsGet({});
          if (!answer.ok) return answer;
          const reading = (account: object) => ({
            ...answer,
            data: {
              ...answer.data,
              connections: answer.data.connections.map((row) =>
                row.id === docs.id ? { ...row, ...account } : row,
              ),
            },
          });
          if (checks > 1) {
            return reading({ status: "connected", statusDetail: null, statusReason: null });
          }
          if (checks === 1 && answerReload === null) {
            return new Promise((resolve) => {
              answerReload = () => resolve(reading(earlier));
            });
          }
          return answer;
        },
      });
      const container = await mountSettings(client, {
        path: `/settings/apps/tools?integrationAttempt=${returnedAttempt}`,
      });
      await vi.waitFor(() => expect(answerReload).not.toBeNull());

      await click(buttonWithText(container, "Recheck repository access"));
      await vi.waitFor(() => expect(container.textContent).toContain("Github connected"));
      await act(async () => answerReload?.());

      const row = accountRows(container).find((candidate) =>
        candidate.querySelector(".card__row-title")?.textContent?.startsWith("opensteer-docs"),
      );
      expect(row?.querySelector(".chip")?.textContent).toBe("Connected");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain("Github connected");
      expect(container.textContent).not.toContain("Recheck repository access");
    },
  );
});

describe("Settings shows the selected Workspace's access", () => {
  // The ways it could fail: disconnecting an account with Main selected
  // reloads the page, and the person picks a specialist before that reload,
  // or the disconnect itself, answers. A read for Main answers last and
  // replaces the specialist's grants, which disappear under its name.
  it.each(["reload", "disconnect"] as const)(
    "keeps a specialist's grants when Main's %s answers after the switch",
    async (late) => {
      const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
      const specialist = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized");
      if (!specialist) throw new Error("The mock seeds a specialist.");
      const container = await mountSettings(client);
      let answer: (() => void) | null = null;
      const hold = <T,>(work: () => Promise<T>) =>
        new Promise<T>((resolve) => {
          answer = () => resolve(work());
        });
      if (late === "reload") {
        const grants = client.rpc["integration.grants.list"];
        let held = false;
        withRpc(client, {
          "integration.grants.list": (input) => {
            const read = () => grants(input as Parameters<typeof grants>[0]);
            if (held) return read();
            held = true;
            return hold(read);
          },
        });
      } else {
        const dispatch = client.dispatch.bind(client);
        vi.spyOn(client, "dispatch").mockImplementationOnce((command) =>
          hold(() => dispatch(command)),
        );
      }
      const row = accountRows(container).find((candidate) =>
        buttonWithText(candidate, "Disconnect"),
      );
      await click(buttonWithText(row ?? container, "Disconnect"));
      await click(buttonWithText(row ?? container, "Confirm disconnect"));
      await vi.waitFor(() => expect(answer).not.toBeNull());

      const workspace = workspaceSelect(container);
      await choose(workspace, specialist.id);
      await vi.waitFor(() => expect(container.querySelectorAll(".intg-grant").length).toBe(2));
      await act(async () => answer?.());

      expect(workspace?.value).toBe(specialist.id);
      expect(container.querySelectorAll(".intg-grant").length).toBe(2);
    },
  );

  // The ways it could fail: Main's reload after a disconnect stalls, and the
  // person picks a specialist, whose access loads. The disconnect waits for
  // Main's read all the same, and every change on the page stays disabled
  // under access that has already loaded.
  it("lets the person change access once a newer read loads, while an older one stalls", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const specialist = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized");
    if (!specialist) throw new Error("The mock seeds a specialist.");
    const container = await mountSettings(client);
    const grants = client.rpc["integration.grants.list"];
    let answerMain: (() => void) | null = null;
    withRpc(client, {
      "integration.grants.list": (input) => {
        const read = () => grants(input as Parameters<typeof grants>[0]);
        if (answerMain) return read();
        return new Promise((resolve) => {
          answerMain = () => resolve(read());
        });
      },
    });
    const row = accountRows(container).find((candidate) => buttonWithText(candidate, "Disconnect"));
    await click(buttonWithText(row ?? container, "Disconnect"));
    await click(buttonWithText(row ?? container, "Confirm disconnect"));
    await vi.waitFor(() => expect(answerMain).not.toBeNull());

    await choose(workspaceSelect(container), specialist.id);
    await vi.waitFor(() => expect(container.querySelectorAll(".intg-grant").length).toBe(2));

    expect(buttonWithText(container, "Revoke")?.disabled).toBe(false);
    await act(async () => answerMain?.());
    expect(container.querySelectorAll(".intg-grant").length).toBe(2);
    expect(buttonWithText(container, "Revoke")?.disabled).toBe(false);
  });

  // The ways it could fail: the person picks a specialist that has access,
  // and while that access loads, or once its read fails, the page says
  // nothing is allowed there; or it stops saying so where nothing is.
  it.each(["fails", "finds nothing"] as const)(
    "says nothing is allowed only once a read finds nothing, not while one loads or %s",
    async (answer) => {
      const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
      const specialist = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized");
      if (!specialist) throw new Error("The mock seeds a specialist.");
      const nothing = "Nothing is allowed here yet";
      const failed = "Workspace access could not be read";
      const container = await mountSettings(client);
      let answerRead = () => {};
      withRpc(client, {
        "integration.grants.list": () =>
          new Promise((resolve) => {
            answerRead = () =>
              resolve(
                answer === "fails"
                  ? { error: { code: "internal", message: failed, retryable: true }, ok: false }
                  : { data: { grants: [] }, ok: true },
              );
          }),
      });

      await choose(workspaceSelect(container), specialist.id);

      expect(container.textContent).not.toContain(nothing);
      expect(container.querySelector('[aria-label="Loading Workspace access"]')).not.toBeNull();
      await act(async () => answerRead());

      expect(container.querySelector('[aria-label="Loading Workspace access"]')).toBeNull();
      if (answer === "fails") {
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(failed);
        expect(container.textContent).not.toContain(nothing);
      } else {
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.textContent).toContain(nothing);
      }
    },
  );
});

describe("Settings retires only the page read failure that a newer read supersedes", () => {
  it("shows a failed sheet-close refresh on the detail page until a later read succeeds", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);
    await click(card(container, "Google Calendar"));
    const reconnect = () => {
      const row = sectionRows(container, "Accounts").find((account) =>
        account.textContent?.includes("alex@example.com"),
      );
      return buttonWithText(row ?? container, "Reconnect");
    };
    withPendingSignIns(client);
    await click(reconnect());
    const read = client.rpc["integrations.get"];
    const failed = "The integration account could not be refreshed";
    withRpc(client, {
      "integrations.get": async () => ({
        ok: false,
        error: { code: "internal", message: failed, retryable: true },
      }),
    });
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'));
    await vi.waitFor(() =>
      expect(
        [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
      ).toEqual([failed]),
    );
    expect(sectionRows(container, "Accounts")).toHaveLength(2);

    withRpc(client, { "integrations.get": () => read({}) });
    await click(reconnect());
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'));
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
    expect(sectionRows(container, "Accounts")).toHaveLength(2);
  });

  it.each([false, true])(
    "reports a failed post-disconnect refresh once and recovers (overlapping Workspace read: %s)",
    async (overlap) => {
      const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
      const specialist = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized");
      const main = client.getSnapshot().workspaces.find(({ kind }) => kind === "main");
      if (!specialist || !main) throw new Error("Both Workspaces exist.");
      const container = await mountSettings(client);
      const read = client.rpc["integration.grants.list"];
      const dispatch = vi.spyOn(client, "dispatch");
      const failed = "Post-disconnect read failed";
      const failure = () => ({
        ok: false,
        error: { code: "internal", message: failed, retryable: true },
      });
      let finishOld = () => {};
      withRpc(client, {
        "integration.grants.list": overlap
          ? (input) =>
              new Promise((resolve) => {
                finishOld = () => resolve(read(input as Parameters<typeof read>[0]));
              })
          : async () => failure(),
      });
      const row = accountRows(container).find((account) => buttonWithText(account, "Disconnect"));
      await click(buttonWithText(row ?? container, "Disconnect"));
      await click(buttonWithText(row ?? container, "Confirm disconnect"));
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "integration.mcp.disconnect" }),
      );
      if (overlap) {
        withRpc(client, { "integration.grants.list": async () => failure() });
        await choose(workspaceSelect(container), specialist.id);
      }
      await vi.waitFor(() => expect(container.textContent).toContain(failed));
      const alerts = () =>
        [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
      expect(alerts()).toEqual([failed]);
      if (overlap) {
        await act(async () => finishOld());
        expect(alerts()).toEqual([failed]);
      }
      withRpc(client, {
        "integration.grants.list": (input) => read(input as Parameters<typeof read>[0]),
      });
      await choose(workspaceSelect(container), overlap ? main.id : specialist.id);
      await choose(workspaceSelect(container), specialist.id);
      await vi.waitFor(() => expect(container.querySelectorAll(".intg-grant")).toHaveLength(2));
      expect(alerts()).toEqual([]);
      expect(row?.isConnected).toBe(false);
    },
  );

  // Failures: a retry keeps the old alert, a Workspace change hides loading,
  // an old completion wins, or a successful read erases a repository error.
  it.each(["grants", "empty"] as const)(
    "recovers the selected Workspace with %s",
    async (result) => {
      const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
      const specialist = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized");
      const main = client.getSnapshot().workspaces.find(({ kind }) => kind === "main");
      if (!specialist || !main) throw new Error("Both Workspaces exist.");
      const container = await mountSettings(client);
      const read = client.rpc["integration.grants.list"];
      const failed = "Workspace access could not be read";
      withRpc(client, {
        "integration.grants.list": async () => ({
          ok: false,
          error: { code: "internal", message: failed, retryable: true },
        }),
      });
      await choose(workspaceSelect(container), specialist.id);
      await vi.waitFor(() =>
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(failed),
      );
      let finish = () => {};
      withRpc(client, {
        "integration.grants.list": (input) =>
          new Promise((resolve) => {
            finish = () =>
              resolve(
                result === "empty"
                  ? { ok: true, data: { grants: [] } }
                  : read(input as Parameters<typeof read>[0]),
              );
          }),
      });
      await choose(workspaceSelect(container), main.id);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await choose(workspaceSelect(container), specialist.id);
      expect(container.querySelector('[aria-label="Loading Workspace access"]')).not.toBeNull();
      await act(async () => finish());
      expect(container.querySelector('[role="alert"]')).toBeNull();
      if (result === "empty")
        expect(container.textContent).toContain("Nothing is allowed here yet");
      else expect(container.querySelectorAll(".intg-grant")).toHaveLength(2);
    },
  );

  it("ignores an older success after the newest Workspace read fails", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const specialist = client.getSnapshot().workspaces.find(({ kind }) => kind === "specialized");
    const main = client.getSnapshot().workspaces.find(({ kind }) => kind === "main");
    if (!specialist || !main) throw new Error("Both Workspaces exist.");
    const container = await mountSettings(client);
    const read = client.rpc["integration.grants.list"];
    let finishOld = () => {};
    withRpc(client, {
      "integration.grants.list": (input) =>
        new Promise((resolve) => {
          finishOld = () => resolve(read(input as Parameters<typeof read>[0]));
        }),
    });
    await choose(workspaceSelect(container), specialist.id);
    withRpc(client, {
      "integration.grants.list": async () => ({
        ok: false,
        error: { code: "internal", message: "Latest read failed", retryable: true },
      }),
    });
    await choose(workspaceSelect(container), main.id);
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Latest read failed"),
    );
    await act(async () => finishOld());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Latest read failed");
    expect(container.querySelectorAll(".intg-grant")).toHaveLength(0);
    expect(container.textContent).not.toContain("Nothing is allowed here yet");
  });

  it("keeps the repository rejection after a successful reload", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);
    const docs = accountRows(container).find((row) =>
      row.textContent?.startsWith("opensteer-docs"),
    );
    await click(buttonWithText(docs ?? container, "Set up repositories"));
    const failed = "GitHub repository access could not be checked. Retry in a moment.";
    withRpc(client, {
      "integration.repositoryAccess.check": async () => ({
        ok: false,
        error: { code: "internal", message: failed, retryable: true },
      }),
    });
    await click(buttonWithText(container, "Recheck repository access"));
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(failed),
    );
    expect(container.textContent).toContain("Repository access is still required");
  });
});

describe("Settings cancels key replacement without changing the account", () => {
  it.each(["overview", "detail", "adding"] as const)(
    "cancels Reconnect opened from %s and discards its key",
    async (source) => {
      const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
      const before = await mockConnections(client);
      const requests = client.getSnapshot().requests[mockVapi.threadId];
      const dispatch = vi.spyOn(client, "dispatch");
      const container = await mountSettings(client);
      if (source !== "overview") await click(card(container, "Vapi API"));
      if (source === "adding") await click(buttonWithText(container, "Add another key"));
      const rejected = (
        source === "overview" ? accountRows(container) : sectionRows(container, "Accounts")
      ).find((row) => row.textContent?.includes("rejected the saved key"));
      await click(buttonWithText(rejected ?? container, "Reconnect"));
      expect(sectionTitles(container)).toContain("Replace the key for Vapi API");
      const key = container.querySelector<HTMLInputElement>('input[type="password"]');
      if (!key) throw new Error("The replacement form is open");
      await typeInto(key, "discard-this-replacement");
      await click(buttonWithText(container, "Cancel"));
      expect(container.querySelector('input[type="password"]')).toBeNull();
      expect(sectionTitles(container)).not.toContain("Replace the key for Vapi API");
      expect(buttonWithText(container, "Add another key")).not.toBeNull();
      expect(dispatch).not.toHaveBeenCalled();
      expect(await mockConnections(client)).toEqual(before);
      expect(client.getSnapshot().requests[mockVapi.threadId]).toEqual(requests);
      const retained = sectionRows(container, "Accounts").find((row) =>
        row.textContent?.includes("rejected the saved key"),
      );
      await click(buttonWithText(retained ?? container, "Reconnect"));
      expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    },
  );
});

describe("Settings keeps a new key behind a button once an account exists", () => {
  // The ways it could fail: a full key form open under a broken account's
  // Reconnect, so a pasted key becomes a second account; no way to add another
  // key at all; Cancel leaving the form open; the empty key field showing
  // bullets as though a key were in it; Reconnect not showing its form at
  // once; an integration with no account hiding its only form behind a button.
  it("opens the form on request, closes it on Cancel, and shows an empty key as empty", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client);

    await click(card(container, "Vapi API"));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(sectionTitles(container)).not.toContain("Add another key");

    await click(buttonWithText(container, "Add another key"));
    const key = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(key?.value).toBe("");
    expect(key?.getAttribute("placeholder")).toBeNull();
    expect(sectionTitles(container)).toContain("Add another key");
    expect(buttonWithText(container, "Connect Vapi API")?.disabled).toBe(true);
    await click(buttonWithText(container, "Cancel"));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(buttonWithText(container, "Add another key")).not.toBeNull();

    const rejected = sectionRows(container, "Accounts").find((row) =>
      row.textContent?.includes("rejected the saved key"),
    );
    await click(buttonWithText(rejected ?? container, "Reconnect"));
    expect(sectionTitles(container)).toContain("Replace the key for Vapi API");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(buttonWithText(container, "Add another key")).toBeNull();

    await click(container.querySelector<HTMLButtonElement>("button.page__back"));
    await click(card(container, "Resend REST"));
    await click(buttonWithText(container, "Install Resend REST"));
    await vi.waitFor(() => expect(sectionTitles(container)).toContain("Add your API key"));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(buttonWithText(container, "Add another key")).toBeNull();
    expect(buttonWithText(container, "Cancel")).toBeNull();
  });
});

describe("Settings opens each integration's page at its top", () => {
  // The ways it could fail: an integration opened from far down the overview
  // keeps that offset and lands on "What agents can do" or Uninstall, hiding
  // its name, provenance and key guidance; going back lands mid-page too.
  it("starts the page and the overview it returns to at the top", async () => {
    const client = new MockHostClient({ automations: "absent", latencyMs: 0 });
    const container = await mountSettings(client, { layout: true });
    const scroller = container.querySelector<HTMLElement>(".connected-apps__inner");
    if (!scroller) throw new Error("Connected apps has one scroll owner.");

    scroller.scrollTop = 1_200;
    await click(card(container, "Vapi API"));
    expect(container.querySelector(".intg-hero")?.textContent).toContain("Vapi API");
    expect(scroller.scrollTop).toBe(0);

    scroller.scrollTop = 800;
    await click(container.querySelector<HTMLButtonElement>("button.page__back"));
    expect(container.textContent).toContain("Installed services");
    expect(scroller.scrollTop).toBe(0);
  });
});

async function mountSettings(
  client: MockHostClient,
  options: { readonly layout?: boolean; readonly path?: string } = {},
): Promise<HTMLElement> {
  // Connect and Reconnect open the sign-in tab from the click; a test reads the
  // durable attempt, never the tab, so no real page is navigated.
  if (!vi.isMockFunction(window.open)) vi.spyOn(window, "open").mockReturnValue(authorizationTab());
  shellState.current = {
    desktopBridge: null,
    desktopDeployment: null,
    hostClient: client,
    localExecutionStatus: null,
    openMobileNavigation: vi.fn(),
    snapshot: client.getSnapshot(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <ToastProvider>
        {options.layout ? (
          <MemoryRouter initialEntries={["/settings/apps/tools"]}>
            <Routes>
              <Route element={<ConnectedAppsLayout />} path="/settings/apps">
                <Route element={<IntegrationsPage embedded />} path="tools" />
              </Route>
            </Routes>
          </MemoryRouter>
        ) : (
          <MemoryRouter initialEntries={[options.path ?? "/"]}>
            <IntegrationsPage embedded />
          </MemoryRouter>
        )}
      </ToastProvider>,
    );
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Your accounts"));
  return container;
}

async function mockConnections(client: MockHostClient) {
  const result = await client.rpc["integrations.get"]({});
  if (!result.ok) throw new Error("The mock Host lists integrations.");
  return result.data.connections;
}

/** The Host marks an MCP authorization the server stopped accepting; the mock never does. */
function withMcpAccountNeedingAuthorization(client: MockHostClient): void {
  const rpc = client.rpc;
  const platform = rpc["integration.platform.get"];
  Object.defineProperty(client, "rpc", {
    value: new Proxy(rpc, {
      get: (target, key) =>
        key === "integration.platform.get"
          ? async (input: Parameters<typeof platform>[0]) => {
              const result = await platform(input);
              if (!result.ok) return result;
              return {
                ...result,
                data: {
                  ...result.data,
                  connections: result.data.connections.map((connection) =>
                    connection.connectionId === mockMcpProposal.connectionId
                      ? { ...connection, status: "needs-attention" as const }
                      : connection,
                  ),
                },
              };
            }
          : Reflect.get(target, key),
    }),
  });
}

/** An agent may give its proposal any name, the catalog's own included. */
function withProposalNamed(client: MockHostClient, name: string): void {
  const rpc = client.rpc;
  const platform = rpc["integration.platform.get"];
  Object.defineProperty(client, "rpc", {
    value: new Proxy(rpc, {
      get: (target, key) =>
        key === "integration.platform.get"
          ? async (input: Parameters<typeof platform>[0]) => {
              const result = await platform(input);
              if (!result.ok) return result;
              return {
                ...result,
                data: {
                  ...result.data,
                  installations: result.data.installations.map((entry) =>
                    entry.installation.id === mockVapi.installationId
                      ? {
                          ...entry,
                          installation: {
                            ...entry.installation,
                            manifest: {
                              ...entry.installation.manifest,
                              definition: {
                                ...(entry.installation.manifest["definition"] as object),
                                name,
                              },
                            },
                            title: name,
                          },
                        }
                      : entry,
                  ),
                },
              };
            }
          : Reflect.get(target, key),
    }),
  });
}

/** The connections the page asks the Host to check GitHub repository access for. */
function repositoryChecks(client: MockHostClient): readonly string[] {
  const checked: string[] = [];
  const rpc = client.rpc;
  const check = rpc["integration.repositoryAccess.check"];
  Object.defineProperty(client, "rpc", {
    value: new Proxy(rpc, {
      get: (target, key) =>
        key === "integration.repositoryAccess.check"
          ? (input: { readonly connectionId: string }) => {
              checked.push(input.connectionId);
              return check(input as Parameters<typeof check>[0]);
            }
          : Reflect.get(target, key),
    }),
  });
  return checked;
}

/** Answers the named rpc members from the test; the mock answers every other one. */
function withRpc(
  client: MockHostClient,
  answers: Readonly<Record<string, (input: unknown) => Promise<unknown>>>,
): void {
  const rpc = client.rpc;
  Object.defineProperty(client, "rpc", {
    value: new Proxy(rpc, {
      get: (target, key) =>
        typeof key === "string" && key in answers ? answers[key] : Reflect.get(target, key),
    }),
  });
}

const returnedAttempt = "ioa_00000000-0000-4000-8000-0000000000a1";

/**
 * Every sign-in started from now on stays at the provider, so its sheet stays
 * open until the person closes it. An attempt `except` names reads as before.
 */
function withPendingSignIns(client: MockHostClient, except?: string): void {
  const read = client.rpc["integration.authorization.get"];
  withRpc(client, {
    "integration.authorization.get": async (input: unknown) =>
      (input as { attemptId: string }).attemptId === except
        ? read(input as Parameters<typeof read>[0])
        : {
            // Still inside its window, whenever the test runs.
            data: {
              connectionId: null,
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              failureCode: null,
              status: "launched",
            },
            ok: true,
          },
  });
}

/**
 * The browser returns from signing in as `connectionId`: its first repository
 * check waits for the test's answer, and every later check of it finds the
 * repositories. Other accounts are checked by the mock.
 */
function withHeldReturnCheck(
  client: MockHostClient,
  connectionId: string,
): (ready: boolean) => void {
  const check = client.rpc["integration.repositoryAccess.check"];
  let answer: (ready: boolean) => void = () => {};
  let held = false;
  withRpc(client, {
    "integration.authorization.get": async () => ({
      data: {
        connectionId,
        expiresAt: "2026-10-17T20:00:00.000Z",
        failureCode: null,
        status: "completed",
      },
      ok: true,
    }),
    "integration.repositoryAccess.check": (input) => {
      if ((input as { readonly connectionId: string }).connectionId !== connectionId) {
        return check(input as Parameters<typeof check>[0]);
      }
      const access = (ready: boolean) => ({
        data: {
          installationUrl: null,
          installations: ready
            ? []
            : [
                {
                  accountLogin: "returned-org",
                  configureUrl:
                    "https://github.com/organizations/returned-org/settings/installations/1",
                  id: "1",
                  repositoryCount: 0,
                  repositorySelection: "selected",
                  suspended: false,
                },
              ],
          ready,
        },
        ok: true,
      });
      if (held) return Promise.resolve(access(true));
      held = true;
      return new Promise((resolve) => {
        answer = (ready) => resolve(access(ready));
      });
    },
  });
  return (ready) => answer(ready);
}

/** The Host marks a preset whose snapshot it cannot use; the mock never does. */
function withNotionUnavailable(client: MockHostClient, reason: string): void {
  const rpc = client.rpc;
  const platform = rpc["integration.platform.get"];
  Object.defineProperty(client, "rpc", {
    value: new Proxy(rpc, {
      get: (target, key) =>
        key === "integration.platform.get"
          ? async (input: Parameters<typeof platform>[0]) => {
              const result = await platform(input);
              if (!result.ok) return result;
              return {
                ...result,
                data: {
                  ...result.data,
                  installations: result.data.installations.map((entry) =>
                    entry.installation.name === "notion"
                      ? {
                          ...entry,
                          installation: {
                            ...entry.installation,
                            status: "needs-attention" as const,
                          },
                          servers: entry.servers.map((server) => ({
                            ...server,
                            status: "needs-attention" as const,
                            statusDetail: reason,
                          })),
                        }
                      : entry,
                  ),
                },
              };
            }
          : Reflect.get(target, key),
    }),
  });
}

async function googleCalendarAccounts(client: MockHostClient) {
  return (await mockConnections(client)).filter(
    ({ definitionId, status }) => definitionId === "google-calendar" && status !== "revoked",
  );
}

/** The tab a web sign-in opens; the mock Host completes the attempt itself. */
function authorizationTab(): Window {
  return {
    close: vi.fn(),
    closed: true,
    location: { replace: vi.fn() },
    opener: null,
  } as unknown as Window;
}

function sectionTitles(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll("section.section > .section__head .section__title")].map(
    (title) => title.textContent ?? "",
  );
}

function sectionCards(container: HTMLElement, title: string): readonly HTMLElement[] {
  const section = [...container.querySelectorAll<HTMLElement>("section.section")].find(
    (candidate) => candidate.querySelector(".section__title")?.textContent === title,
  );
  if (!section) throw new Error(`${title} is listed.`);
  return [...section.querySelectorAll<HTMLElement>(".intg-card")];
}

function cardState(container: HTMLElement, name: string): string | null {
  return card(container, name)?.querySelector(".intg-card__state")?.textContent ?? null;
}

function card(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>(".intg-card")].find(
      (candidate) => candidate.querySelector(".intg-card__name")?.textContent === name,
    ) ?? null
  );
}

/** The rows of "Your accounts", each one account. */
function accountRows(container: HTMLElement): readonly HTMLElement[] {
  return sectionRows(container, "Your accounts");
}

/** The Host's own words for an account's repair, which its row keeps on hover. */
function accountReason(row: HTMLElement): string | null {
  return row.querySelector(".intg-account__status")?.getAttribute("title") ?? null;
}

/** The one line an account's row gives its state. */
function accountStatus(row: HTMLElement | undefined): string | undefined {
  return row?.querySelector(".intg-account__status")?.textContent ?? undefined;
}

function sectionRows(container: HTMLElement, title: string): readonly HTMLElement[] {
  const section = [...container.querySelectorAll<HTMLElement>("section.section")].find(
    (candidate) => candidate.querySelector(".section__title")?.textContent === title,
  );
  if (!section) throw new Error(`${title} is listed.`);
  // The row that adds an account is not one.
  return [...section.querySelectorAll<HTMLElement>(".card__row:not(.intg-account--add)")];
}

function workspaceSelect(container: HTMLElement): HTMLSelectElement | null {
  return (
    [...container.querySelectorAll("select")].find((select) =>
      select.closest("label")?.textContent?.startsWith("Workspace"),
    ) ?? null
  );
}

function buttonWithText(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    ) ?? null
  );
}

async function click(button: HTMLElement | null): Promise<void> {
  if (!button) throw new Error("The button is shown.");
  await act(async () => button.click());
}

async function choose(select: HTMLSelectElement | null, value: string): Promise<void> {
  if (!select) throw new Error("The select is shown.");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
