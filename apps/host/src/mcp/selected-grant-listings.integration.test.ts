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
  type AgentGrant,
  type BrowserProfileId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { createIntegrationId } from "@opensteer/integration-core";
import { describeStore, enrollTestRunner } from "@opensteer/database/test-support/store";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "../administration/administration-service.js";
import { LocalServerRegistry } from "../local-servers/local-server-registry.js";
import { compositeBackend } from "../plugins/engine-backend.js";
import type { engineAccounts } from "../plugins/engine-accounts.js";
import { PluginAuthority } from "../plugins/plugin-authority.js";
import type { ConnectionCaller } from "./agent-caller.js";
import { connection, errorText, serveMcp } from "./connection-caller.test-support.js";
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
    const url = await serveMcp(storeFixture, {
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
    const overview = await agent.client.callTool({ name: "computer_apps", arguments: {} });
    expect(overview.isError, JSON.stringify(overview.content)).not.toBe(true);
    expect(overview.structuredContent).toMatchObject({
      computers: [{ computerId: granted, apps: [{ name: "Notes" }] }],
      phones: [{ computerId: phone }],
    });
    expect(names(overview, hidden)).toEqual([]);

    // One Mac's installed apps, a page at a time: only the granted app, and a total that counts
    // only it, so paging reveals nothing else installed there.
    const pages: unknown[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await agent.client.callTool({
        name: "computer_apps",
        arguments: { computerId: granted, limit: 1, ...(cursor ? { cursor } : {}) },
      });
      expect(page.isError, JSON.stringify(page.content)).not.toBe(true);
      pages.push(page.structuredContent);
      cursor = (page.structuredContent as { nextCursor: string | null }).nextCursor;
    } while (cursor);
    expect(pages).toEqual([
      expect.objectContaining({
        total: 1,
        nextCursor: null,
        computer: expect.objectContaining({ apps: [expect.objectContaining({ name: "Notes" })] }),
      }),
    ]);
    expect(names(pages, [...hidden, "Calculator"])).toEqual([]);
    // A Mac outside the grant reads exactly as one that does not exist.
    const foreign = await agent.client.callTool({
      name: "computer_apps",
      arguments: { computerId: other },
    });
    const unknownId = DeviceIdSchema.parse(createId("device"));
    const unknown = await agent.client.callTool({
      name: "computer_apps",
      arguments: { computerId: unknownId },
    });
    expect(errorText(foreign).replace(other!, "")).toBe(errorText(unknown).replace(unknownId, ""));
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
    const grant: AgentGrant = {
      scope: "selected",
      tasks: false,
      resources: [
        {
          kind: "computer-app",
          approvalId: createIntegrationId("connection"),
          deviceId: DeviceIdSchema.parse(granted),
          app: { kind: "mac-app", bundleId: "com.apple.Notes", teamId: null },
        },
        { kind: "browser-profile", profileId: profile },
      ],
    };
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
      home: { runnerId: granted, name: "Granted Mac", reachable: true },
    });
    const handler = new AdministrationToolHandlers(
      new AdministrationService(
        {
          store,
          runners: {
            asleepSince: () => null,
            identityForRunner: () => undefined,
            isRunnerConnected: () => true,
            moduleReadiness: () => "ready",
          },
          computerApps: { status: () => [], attached: () => false, deviceStatus: () => null },
          integrations: { devices: { deviceConnections: async () => [] } },
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
    expect(computers.computers[0]!.sessions).toEqual([]);
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
    expect(names(profiles, [hiddenProfile, "Hidden profile", "bank.example"])).toEqual([]);
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
    const listed = await localServerToolHandlers(registry).local_server_list!({
      caller: selectedCaller(f.userId, "local-servers", {
        scope: "selected",
        tasks: false,
        resources: [
          { kind: "plugin", target: { kind: "local-server", serverId: shown }, access: "read" },
        ],
      }),
      input: {},
      operationKey: "local-servers",
    } as never);
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
