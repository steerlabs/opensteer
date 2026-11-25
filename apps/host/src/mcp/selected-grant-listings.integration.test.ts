import { Effect } from "effect";
import {
  AppId,
  AppSlug,
  OwnerId,
  VersionId,
  type PluginEngine,
} from "@opensteer/plugin-engine-sdk/core";
import {
  createId,
  DeviceIdSchema,
  OpensteerError,
  TabSchema,
  type AgentGrant,
  type BrowserProfileId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { machineAccessPolicyDefault } from "@opensteer/protocol";
import { AgentSessionService } from "../agent-sessions/agent-session-service.js";
import { requireDeviceAccess } from "../administration/device-access.js";
import { BrowserScriptConfinement, BrowserToolHandlers } from "./handlers/browser.js";
import { TabToolHandlers } from "./handlers/tabs.js";
import { SessionPersonTools } from "./handlers/session-person.js";
import type { TabServicePort } from "../tabs/ports.js";
import { tabReadAuthority } from "../tabs/tab-authority.js";
import { createIntegrationId } from "@opensteer/integration-core";
import { describeStore, enrollTestRunner } from "@opensteer/database/test-support/store";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "../administration/administration-service.js";
import { LocalServerRegistry } from "../local-servers/local-server-registry.js";
import { compositeBackend } from "../plugins/engine-backend.js";
import type { engineAccounts } from "../plugins/engine-accounts.js";
import { PluginToolHandlers } from "./handlers/plugins.js";
import { PluginAuthority } from "../plugins/plugin-authority.js";
import type { ConnectionCaller } from "./agent-caller.js";
import { connection, expectUnknownTool, serveMcp } from "./connection-caller.test-support.js";
import { AdministrationToolHandlers } from "./handlers/administration.js";
import { localServerToolHandlers } from "./handlers/local-servers.js";

/** What a connection holding `grant` is, as the caller resolver builds it. */
function selectedCaller(userId: UserId, connectionId: string, grant: AgentGrant): ConnectionCaller {
  return {
    kind: "connection",
    key: `connection:${connectionId}`,
    connectionId,
    grant,
    grantRevision: 1,
    userId,
    accessMode: "full-access",
  };
}
/** Nothing in `output` names any of `hidden`, in any field. */
function names(output: unknown, hidden: readonly string[]) {
  const text = JSON.stringify(output);
  return hidden.filter((value) => text.includes(value));
}

describeStore("a selected grant's listings show only what it names", (it) => {
  it("computer_apps: only granted Macs, apps and phones, also when one Mac's apps are paged", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("listing-computer-apps");
    const [granted, other, phone, otherPhone] = [0, 1, 2, 3].map(() =>
      DeviceIdSchema.parse(createId("device")),
    );
    const [notes, mail, safari, screen] = [0, 1, 2, 3].map(() => createIntegrationId("connection"));
    const machine = (deviceId: string, name: string, apps: readonly (readonly string[])[]) => ({
      deviceId,
      definitionId: "macos-app",
      name,
      state: "ready",
      appApproval: "ask",
      apps: apps.map(([connectionId, appName, bundleId]) => ({
        connectionId,
        name: appName,
        bundleId,
        teamId: null,
        access: "read-write",
      })),
    });
    const inventory = {
      machines: [
        machine(granted!, "Granted Mac", [
          [notes!, "Notes", "com.apple.Notes"],
          [mail!, "Mail", "com.apple.mail"],
        ]),
        machine(other!, "Hidden Mac", [[safari!, "Safari", "com.apple.Safari"]]),
      ],
      phones: [
        {
          deviceId: phone,
          definitionId: "iphone-screen",
          name: "Granted iPhone",
          state: "ready",
          connection: { connectionId: screen, access: "read-write" },
          blockedByOwner: false,
        },
        {
          deviceId: otherPhone,
          definitionId: "android-phone",
          name: "Hidden Pixel",
          state: "ready",
          connection: null,
          blockedByOwner: false,
        },
      ],
    };
    const installed = [
      { identity: { displayName: "Notes", bundleId: "com.apple.Notes" } },
      { identity: { displayName: "Calculator", bundleId: "com.apple.calculator" } },
      { identity: { displayName: "Mail", bundleId: "com.apple.mail" } },
    ];
    const windows = Array.from({ length: 51 }, (_, index) =>
      TabSchema.parse({
        tabId: `window-${index}`,
        kind: "window",
        title: `Notes ${index}`,
        computer: { computerId: granted, name: "Granted Mac" },
        bundleId: "com.apple.Notes",
        appName: "Notes",
        groupId: null,
        state: "open",
        openedBy: "person",
        usedBy: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const url = await serveMcp(storeFixture, {
      discoverSources: {
        tabs: { project: async () => ({ tabs: windows, layout: { revision: 0, items: [] } }) },
      },
      computerApps: {
        computerUseInventory: async () => inventory,
        installedComputerApps: (async (input: { offset: number; limit: number }) => ({
          apps: installed.slice(input.offset, input.offset + input.limit),
          total: installed.length,
        })) as never,
      },
    });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: {
        scope: "selected",
        tasks: false,
        resources: [
          {
            kind: "computer-app",
            approvalId: notes!,
            deviceId: granted!,
            app: { kind: "mac-app", bundleId: "com.apple.Notes", teamId: null },
          },
          {
            kind: "computer-app",
            approvalId: screen!,
            deviceId: phone!,
            app: { kind: "phone-screen", definitionId: "iphone-screen" },
          },
        ],
      },
    });
    const hidden = [other!, "Hidden Mac", "Safari", "Mail", mail!, otherPhone!, "Hidden Pixel"];
    const overview = await agent.client.callTool({ name: "discover", arguments: {} });
    expect(overview.isError, JSON.stringify(overview.content)).not.toBe(true);
    expect(overview.structuredContent).toMatchObject({
      items: [
        { kind: "app", name: "Notes", use: { computerId: granted } },
        { kind: "phone", id: phone },
      ],
    });
    expect(names(overview, hidden)).toEqual([]);

    // One Mac's installed apps, a page at a time: only the granted app, and a total that counts
    // only it, so paging reveals nothing else installed there.
    const pages: unknown[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await agent.client.callTool({
        name: "discover",
        arguments: { id: granted, ...(cursor ? { cursor } : {}) },
      });
      expect(page.isError, JSON.stringify(page.content)).not.toBe(true);
      pages.push(page.structuredContent);
      cursor = (page.structuredContent as { nextCursor: string | null }).nextCursor;
    } while (cursor);
    expect(pages).toEqual([
      expect.objectContaining({
        nextCursor: expect.any(String),
        items: windows.slice(0, 50).map((tab) => expect.objectContaining({ id: tab.tabId })),
      }),
      expect.objectContaining({
        nextCursor: null,
        items: [
          expect.objectContaining({ id: windows[50]!.tabId }),
          expect.objectContaining({ name: "Notes", kind: "app" }),
        ],
      }),
    ]);
    expect(names(pages, [...hidden, "Calculator"])).toEqual([]);
    // A Mac outside the grant reads exactly as one that does not exist.
    const foreign = await agent.client.callTool({
      name: "discover",
      arguments: { id: other },
    });
    const unknownId = DeviceIdSchema.parse(createId("device"));
    const unknown = await agent.client.callTool({
      name: "discover",
      arguments: { id: unknownId },
    });
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
    expect(foreign.structuredContent).toMatchObject({ error: { code: "not_found", next: null } });
  });

  it("computer_list and browser_profile_list: only granted Devices and profiles, no shells or sign-in sites", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("listing-administration");
    // The hosting computer's enrollment, as a real Home has it, so the person's whole inventory
    // is listable and only the grant decides what the agent sees.
    await storeFixture.database
      .insertInto("runnerEnrollments")
      .values({
        id: `ren_${randomUUID()}`,
        name: "Hosting computer",
        runnerId: f.runnerId,
        tokenHash: "sha256:listing-home",
        allowedModules: sql`'["agents"]'::jsonb`,
        createdBy: null,
        ownerKind: "deployment",
        ownerUserId: null,
        idempotencyKey: "listing-home",
        requestFingerprint: "sha256:listing-home",
        runnerKind: "main",
        expiresAt: new Date(),
        consumedAt: new Date(),
        createdAt: new Date(),
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    await storeFixture.database
      .updateTable("personalRemoteAccess")
      .set({ mode: "private", routeOrigin: "https://personal.mcp.test", generation: 1 })
      .execute();
    const [granted, hidden] = [createId("runner"), createId("runner")];
    for (const [runnerId, name] of [
      [granted, "Granted Mac"],
      [hidden, "Hidden Mac"],
    ] as const)
      await enrollTestRunner(storeFixture.store, {
        createdBy: f.userId,
        environmentId: createId("environment"),
        runnerId,
        runnerKind: "local",
        allowedModules: ["browser", "integrations", "messaging", "shell"],
        modules: { browser: { runtimeId: "browser", wireVersion: 2 } },
        name,
        tokenSuffix: runnerId,
      });
    const [profile, hiddenProfile] = [createId("browserProfile"), createId("browserProfile")];
    const phoneId = createId("device");
    const screenApproval = createIntegrationId("connection");
    const deployment = await storeFixture.database
      .selectFrom("deployments")
      .select("id")
      .executeTakeFirstOrThrow();
    await storeFixture.database
      .insertInto("devices")
      .values({
        id: phoneId,
        deploymentId: deployment.id,
        ownerKind: "user",
        ownerUserId: f.userId,
        name: "Shared iPhone",
        kind: "phone",
        platform: "ios",
        form: "phone",
        accessPolicy: sql`${JSON.stringify({ ...machineAccessPolicyDefault, apps: true })}::jsonb`,
        accessPolicyRevision: 1,
        removedAt: null,
      })
      .execute();
    await storeFixture.database
      .insertInto("deviceDrivers")
      .values({
        deviceId: phoneId,
        role: "screen",
        runnerId: hidden,
        generation: 1,
        detachedAt: null,
      })
      .execute();
    const [approval, staleApproval] = [
      createIntegrationId("connection"),
      createIntegrationId("connection"),
    ];
    const grant: AgentGrant = {
      scope: "selected",
      tasks: false,
      resources: [
        {
          kind: "computer-app",
          approvalId: approval,
          deviceId: DeviceIdSchema.parse(granted),
          app: { kind: "mac-app", bundleId: "com.apple.Notes", teamId: null },
        },
        // Granted once, but the person has since revoked the app's approval on that Mac.
        {
          kind: "computer-app",
          approvalId: staleApproval,
          deviceId: DeviceIdSchema.parse(hidden),
          app: { kind: "mac-app", bundleId: "com.apple.Notes", teamId: null },
        },
        { kind: "browser-profile", profileId: profile },
      ],
    };
    const approvals = [
      { id: approval, status: "active", computer: { deviceId: granted, blockedAt: null } },
      { id: staleApproval, status: "revoked", computer: { deviceId: hidden, blockedAt: null } },
      {
        id: screenApproval,
        status: "active",
        definitionId: "iphone-screen",
        computer: { deviceId: phoneId, blockedAt: null, access: "read-write" },
      },
    ];
    // A shell on every computer: none of them is the selected agent's to see.
    const store = new Proxy(storeFixture.store, {
      get(target, property) {
        if (property === "listActiveShellSessions")
          return async () => [{ sessionId: "shell-session-secret", cwd: "/Users/secret" }];
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const profileRow = (id: BrowserProfileId, name: string) => ({
      id,
      name,
      home: { runnerId: hidden, name: "Hidden Mac", reachable: true },
    });
    const handler = new AdministrationToolHandlers(
      new AdministrationService(
        {
          store,
          runners: {
            asleepSince: () => null,
            agentsStoppedSince: () => null,
            identityForRunner: () => undefined,
            isRunnerConnected: () => true,
            moduleReadiness: () => "ready",
          },
          computerApps: { status: () => [], attached: () => false, deviceStatus: () => null },
          integrations: { devices: { deviceConnections: async () => approvals } },
          browser: {
            listAgentProfiles: async () => [
              profileRow(profile, "Granted profile"),
              profileRow(hiddenProfile, "Hidden profile"),
            ],
          },
          browserSources: { listState: async () => ({ sites: [{ site: "bank.example" }] }) },
        } as unknown as AdministrationDependencies,
        () => {},
      ),
      () => true,
    );
    const caller = selectedCaller(f.userId, "listing", grant);
    const computers = await handler.computer_list({ caller, input: {}, operationKey: "list" });
    expect(computers.computers.map((computer) => computer.computerId)).toEqual([granted]);
    expect(computers.nextCursor).toBeNull();
    // Nothing about the granted Mac beyond that it exists: no drivers, switches or capabilities.
    expect(computers.computers[0]).toMatchObject({
      sessions: [],
      drivers: [],
      selfRunnerId: null,
      capabilities: [],
      hosting: false,
    });
    expect(computers.computers[0]).not.toHaveProperty("link");
    expect(
      names(computers, [hidden, "Hidden Mac", f.runnerId, "shell-session-secret", "/Users/secret"]),
    ).toEqual([]);
    const profiles = await handler.browser_profile_list({
      caller,
      input: {},
      operationKey: "profiles",
    });
    expect(profiles).toEqual({
      profiles: [expect.objectContaining({ id: profile, name: "Granted profile" })],
      sites: [],
    });
    expect(profiles.profiles[0]?.home).toEqual({ reachable: true });
    expect(
      names(profiles, [hidden, "Hidden Mac", hiddenProfile, "Hidden profile", "bank.example"]),
    ).toEqual([]);

    const phoneGrant: AgentGrant = {
      scope: "selected",
      tasks: false,
      resources: [
        { kind: "browser-profile", profileId: profile },
        {
          kind: "computer-app",
          approvalId: screenApproval,
          deviceId: phoneId,
          app: { kind: "phone-screen", definitionId: "iphone-screen" },
        },
      ],
    };
    const phoneCaller = selectedCaller(f.userId, "phone-screen", phoneGrant);
    const phoneList = await handler.computer_list({
      caller: phoneCaller,
      input: {},
      operationKey: "phone-list",
    });
    expect(phoneList).toMatchObject({
      nextCursor: null,
      computers: [
        {
          computerId: phoneId,
          phoneDisplay: { driver: null, setup: { location: "driver-mac" } },
        },
      ],
    });
    expect(phoneList.computers).toHaveLength(1);
    expect(names(phoneList, [hidden, "Hidden Mac"])).toEqual([]);

    await storeFixture.database
      .insertInto("browserProfiles")
      .values([
        { id: profile, ownerId: f.userId, homeRunnerId: f.runnerId, name: "Granted profile" },
        { id: hiddenProfile, ownerId: f.userId, homeRunnerId: f.runnerId, name: "Hidden profile" },
      ])
      .execute();
    const tabComputerId = await storeFixture.store.requireSelfDeviceId(f.runnerId);
    const hiddenTab = "hidden-tab-title-and-id";
    const shownTab = TabSchema.parse({
      tabId: "shared-profile-tab",
      title: "Shared page",
      kind: "page",
      computer: { computerId: hidden, name: "Hidden Mac" },
      groupId: null,
      state: "open",
      openedBy: "person",
      usedBy: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      url: "https://example.test/",
      profile: { profileId: profile, name: "Granted profile" },
    });
    const privateTab = TabSchema.parse({
      ...shownTab,
      tabId: hiddenTab,
      title: "Hidden page",
      profile: { profileId: hiddenProfile, name: "Hidden profile" },
    });
    const list: TabServicePort["list"] = async (actor, _input, _mayName, select) => {
      if (actor.kind !== "browser-binding") throw new Error("Expected a direct session");
      const allowed = await tabReadAuthority(actor, storeFixture.database);
      const tabs = [];
      for (const tab of [shownTab, privateTab]) {
        if (
          (await allowed({
            ownerId: f.userId,
            id: tab.tabId,
            kind: "page",
            title: tab.title,
            computerId: tabComputerId,
            profileId: tab.profile!.profileId,
            openedBy: { taskId: actor.threadId },
          })) &&
          (!select || select(tab))
        )
          tabs.push(tab);
      }
      return { tabs, groups: [], nextCursor: null };
    };
    const tabs = {
      list,
      connectionTab: async (_actor: unknown, id: string) => {
        if (id !== shownTab.tabId)
          throw new OpensteerError({ code: "not_found", message: "Tab not found." });
        return { kind: "page", generation: 1, profileId: profile, openedBy: "person" };
      },
    } as unknown as TabServicePort;
    const sessions = new AgentSessionService({ store: storeFixture.store, holdMs: 0 });
    const toolErrors: unknown[] = [];
    const url = await serveMcp(storeFixture, {
      onToolError: (error) => toolErrors.push(error),
      administration: handler,
      tabHandlers: new TabToolHandlers(tabs, sessions),
      browser: new BrowserToolHandlers({
        sessions,
        tabs: tabs as never,
        scripts: {} as never,
        confinement: new BrowserScriptConfinement(),
        profiles: async () => [
          profileRow(profile, "Granted profile"),
          profileRow(hiddenProfile, "Hidden profile"),
        ],
        requireDevice: async (runnerId) => {
          const deviceId = await storeFixture.store.requireSelfDeviceId(runnerId);
          await requireDeviceAccess(storeFixture.database, deviceId, "browser", false, {
            stopped: true,
          });
          return deviceId;
        },
        issueTicket: async () => {
          throw new Error("A refused call must not open a connection.");
        },
        origin: new URL("https://personal.mcp.test"),
      }),
      sessionPerson: new SessionPersonTools({
        tabs,
        store: storeFixture.store,
        sessions,
        browser: {
          signInTarget: async () => ({
            live: true,
            profileId: hiddenProfile,
            profileName: "Hidden profile",
            computer: { runnerId: hidden, name: "Hidden Mac" },
            tabUrl: "https://bank.example/",
          }),
        } as never,
        logins: {} as never,
      }),
      computerApps: {
        computerUseInventory: async () => ({
          machines: [],
          phones: [
            {
              deviceId: phoneId,
              connectionId: screenApproval,
              name: "Shared iPhone",
              definitionId: "iphone-screen",
              state: "unavailable",
              availability: { state: "unavailable", reason: { kind: "driver-stopped" } },
              setup: {
                location: "driver-mac",
                driverRunnerName: "Hidden Mac",
                driverRunnerId: hidden,
              },
            },
          ],
        }),
      },
    });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant: phoneGrant,
    });
    const call = (name: string, args: Record<string, unknown> = {}) =>
      agent.client.callTool({ name, arguments: args });
    const offered = await agent.client.listTools();
    expect(offered.tools.map(({ name }) => name)).not.toContain("tab_open");
    expect(offered.tools.map(({ name }) => name)).not.toContain("tab_close");
    for (const name of ["browser_profile_list", "computer_apps", "computer_list", "tab_list"])
      await expectUnknownTool(agent.client, name);
    const shared = await call("discover");
    expect(shared.isError, toolErrors.map(String).join("\n")).not.toBe(true);
    expect(shared.structuredContent).toMatchObject({
      items: [
        { id: profile, name: "Granted profile", kind: "browser-profile", reachable: true },
        {
          id: phoneId,
          kind: "phone",
          phoneSetup: { location: "driver-mac" },
          reachable: false,
          blocked: {
            code: "computer_stopped",
            message: "Agents are stopped on the Mac connected to Shared iPhone.",
          },
        },
      ],
    });
    const allTabs = await new TabToolHandlers(tabs, sessions).tab_list({
      caller: selectedCaller(f.userId, agent.id, phoneGrant),
      input: {},
      operationKey: "all-selected-tabs",
    });
    expect(allTabs).toMatchObject({
      tabs: [{ tabId: shownTab.tabId }],
      groups: [],
      nextCursor: null,
    });
    expect(names(allTabs, [hidden, hiddenProfile, hiddenTab, "Hidden Mac"])).toEqual([]);
    const tabsResult = await call("discover", { id: profile });
    expect(tabsResult.isError, toolErrors.map(String).join("\n")).not.toBe(true);
    expect(tabsResult.structuredContent).toMatchObject({
      items: [{ id: shownTab.tabId, kind: "tab", untrusted: true }],
      nextCursor: null,
    });
    const refusals = await Promise.all([
      call("discover", { id: hidden }),
      call("browser_connect", { profileId: hiddenProfile }),
      call("browser_connect", { profileId: profile }),
      call("browser_use", { profileId: hiddenProfile, code: "print(await pages())" }),
      call("browser_use", { profileId: profile, code: "print(await pages())" }),
      call("computer_use", { code: "print(await apps())" }),
      call("saved_login_request", { tabId: hiddenTab, site: "bank.example", reason: "Sign in" }),
      call("card_request", { tabId: hiddenTab, site: "bank.example", reason: "Pay" }),
      call("ask_person", {
        title: "Choose",
        questions: [{ question: "Which one?", multiSelect: true }],
      }),
      call("opensteer_task_list"),
      call("browser_profile_request", {
        suggestion: { kind: "existing", profileId: hiddenProfile },
        reason: "Open a page",
      }),
    ]);
    for (const refusal of refusals) expect(refusal.isError).toBe(true);
    expect(refusals[2]?.structuredContent).toMatchObject({ error: { code: "computer_stopped" } });
    expect(refusals[4]?.structuredContent).toMatchObject({ error: { code: "computer_stopped" } });
    expect(
      names(
        [offered, shared, tabsResult, ...refusals],
        [
          hidden,
          "Hidden Mac",
          granted,
          "Granted Mac",
          f.runnerId,
          "Hosting computer",
          hiddenProfile,
          "Hidden profile",
          hiddenTab,
          "bank.example",
          "shell-session-secret",
          "/Users/secret",
        ],
      ),
    ).toEqual([]);
  });

  it("local_server_list: only the local servers the grant names", async ({ storeFixture }) => {
    const f = await storeFixture.startRunFixture("listing-local-servers");
    const [shown, hidden] = [createIntegrationId("server"), createIntegrationId("server")];
    const server = (id: string, installationId: string) => ({
      id,
      installationId,
      installationTitle: id,
      runnerName: "Mac",
      deviceId: null,
      status: "enabled",
      declined: false,
      statusDetail: null,
      approvedLaunchDigest: "digest",
      launchDigest: "digest",
      launch: { type: "stdio" },
    });
    const registry = new LocalServerRegistry({
      store: {
        plugins: {
          list: async () => [
            { id: "plg_shown", name: "Shown server", installedBy: f.userId },
            { id: "plg_hidden", name: "Hidden server", installedBy: f.userId },
          ],
        },
        localMcp: { list: async () => [server(shown, "ins_shown"), server(hidden, "ins_hidden")] },
        listInstallations: async () => [
          { id: "ins_shown", pluginId: "plg_shown", manifest: null },
          { id: "ins_hidden", pluginId: "plg_hidden", manifest: null },
        ],
      },
    } as unknown as LocalServerRegistry["options"]);
    const grant: AgentGrant = {
      scope: "selected",
      tasks: false,
      resources: [
        { kind: "plugin", target: { kind: "local-server", serverId: shown }, access: "read" },
      ],
    };
    const listInstalled = vi.fn(async () => []);
    const plugins = new PluginToolHandlers({
      authority: new PluginAuthority({
        store: storeFixture.store,
        settings: { settings: async () => [] } as never,
        owner: async () => f.userId,
      }),
      service: { list: listInstalled } as never,
      localProviders: {
        providers: async () => [
          {
            id: `app_server_${shown}`,
            slug: "shown-server",
            name: "Shown server",
            tools: [],
            version: "fixture",
          },
          {
            id: `app_server_${hidden}`,
            slug: "hidden-server",
            name: "Hidden server",
            tools: [],
            version: "fixture",
          },
        ],
      },
      settings: { settings: async () => [] } as never,
      store: storeFixture.store,
      executions: {} as never,
      folder: () => {
        throw new Error("Unexpected folder");
      },
      exportFiles: () => {
        throw new Error("Unexpected export");
      },
    });
    const url = await serveMcp(storeFixture, { plugins });
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant,
    });
    await expectUnknownTool(agent.client, "local_server_list");
    const discovered = await agent.client.callTool({ name: "discover", arguments: {} });
    expect(discovered.isError, JSON.stringify(discovered.content)).not.toBe(true);
    expect(discovered.structuredContent).toMatchObject({
      items: [{ id: 'tools["shown-server"]', name: "Shown server", kind: "plugin" }],
      nextCursor: null,
    });
    expect(names(discovered, [hidden, "Hidden server", "hidden-server"])).toEqual([]);
    expect(listInstalled).not.toHaveBeenCalled();
    const listed = await localServerToolHandlers(registry).local_server_list!({
      caller: {
        kind: "run",
        userId: f.userId,
        accessMode: "full-access",
        key: `run:${f.runId}`,
        thread: f.thread,
        claims: {} as never,
        agentConnection: {
          agentConnectionId: agent.id,
          grant,
          grantRevision: 1,
          consentVersion: 1,
          accessMode: "full-access",
        },
      },
      input: {},
      operationKey: "local-servers",
    });
    expect(listed).toEqual({ servers: [expect.objectContaining({ name: "Shown server" })] });
    expect(names(listed, [hidden, "Hidden server", "plg_hidden"])).toEqual([]);
  });

  it("plugin listApps: only granted plugins and local servers, with no blocked markers for the rest", async ({
    storeFixture,
  }) => {
    const f = await storeFixture.startRunFixture("listing-plugins");
    const url = await serveMcp(storeFixture);
    const shownServer = createIntegrationId("server");
    const hiddenServer = createIntegrationId("server");
    const grant: AgentGrant = {
      scope: "selected",
      tasks: false,
      resources: [
        { kind: "plugin", target: { kind: "installed", pluginId: "app_shown" }, access: "read" },
        {
          kind: "plugin",
          target: { kind: "local-server", serverId: shownServer },
          access: "read",
        },
      ],
    };
    const agent = await connection(storeFixture.store, url, {
      userId: f.userId,
      accessMode: "full-access",
      grant,
    });
    const authority = new PluginAuthority({
      store: storeFixture.store as OpensteerStore,
      settings: { settings: async () => [] } as never,
      owner: async () => f.userId,
    });
    const caller = { ...selectedCaller(f.userId, agent.id, grant), key: `connection:${agent.id}` };
    const app = (slug: string) => ({
      id: AppId.make(`app_${slug}`),
      slug: AppSlug.make(slug),
      name: `${slug} plugin`,
      activeVersion: VersionId.make("dpl_fixture"),
    });
    const provider = (serverId: string, name: string) => ({
      id: `app_server_${serverId}`,
      name,
      slug: name.toLowerCase().replace(/\s/gu, "-"),
      version: "dpl_fixture",
      tools: [],
    });
    const listed = await authority.scoped(caller, async () => {
      const context = authority.admit(caller);
      const backend = compositeBackend(
        {
          apps: { list: () => Effect.succeed([app("shown"), app("hidden")]) },
        } as never as PluginEngine,
        {} as ReturnType<typeof engineAccounts>,
        OwnerId.make(f.userId),
        context,
        {
          authorize: (input) => Effect.promise(() => authority.authorize({ ...context, ...input })),
          providers: () =>
            Effect.succeed([
              provider(shownServer, "Shown server"),
              provider(hiddenServer, "Hidden server"),
            ]),
          call: () => Effect.die("Unexpected call"),
        },
      );
      return Effect.runPromise(backend.listApps());
    });
    expect(listed.map((entry) => entry.id)).toEqual(["app_shown", `app_server_${shownServer}`]);
    expect(listed.some((entry) => "blocked" in entry)).toBe(false);
    expect(names(listed, ["app_hidden", "hidden plugin", hiddenServer, "Hidden server"])).toEqual(
      [],
    );
  });
});
