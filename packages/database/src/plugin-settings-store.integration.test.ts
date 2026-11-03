import { pauseAfterLock } from "./lock-race.test-support.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createTestWorkspace } from "./workspace-fixture.test-support.js";
import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { jsonValue } from "./store-primitives.js";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { KyselyPlugin } from "kysely";
import { PluginSettingsStore, pluginTargetKey } from "./plugin-settings-store.js";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { testOpenApiAdapterContract } from "./store.integration.test-support.js";
import { integrationDefinitionSummary } from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { describeStore } from "./store.integration.test-support.js";

describeStore("plugin Settings authority", (test) => {
  test("server roles cannot discover another person's private accounts, policy or source files", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("settings-role-matrix");
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "shared-visible",
      actorUserId: run.userId,
      workspaceId: run.workspace.id,
      source: { directory: "/private/owner-skill-files" },
      digest: "shared",
      manifest: { name: "shared-visible", skills: [{ name: "shared-skill" }] },
    });
    const contract = testOpenApiAdapterContract({
      definitionId: "private-records",
      provider: "records",
    });
    const opened = await platform.requests.createIntegrationInstallRequest({
      callId: "private-request",
      manifest: {
        kind: "catalog",
        definition: integrationDefinitionSummary(contract.definition),
        digest: integrationDefinitionDigest(contract.definition),
      },
      originatingRunId: run.run.id,
      originatingThreadId: run.thread.id,
      originatingWorkspaceId: run.workspace.id,
      targetWorkspaceId: run.workspace.id,
      requestedBy: run.userId,
      reason: "Private request sentinel",
    });
    const ownerDetail = await platform.settings.detail(run.userId, { kind: "plugin", pluginId });
    expect(ownerDetail.sourceFolder).toBe("/private/owner-skill-files");
    for (const role of ["owner", "admin", "member", "non-member"] as const) {
      const viewer = role === "owner" ? run.userId : await f.store.createUser(role);
      if (role === "admin")
        await f.database
          .updateTable("users")
          .set({ instanceRole: "administrator" })
          .where("id", "=", viewer)
          .execute();
      if (role === "admin" || role === "member")
        await f.database
          .insertInto("workspaceMemberships")
          .values({
            id: createId("workspaceMembership"),
            workspaceId: run.workspace.id,
            userId: viewer,
            role: "collaborator",
            state: "active",
            generation: 1,
            invitedBy: run.userId,
            joinedAt: new Date(),
            revokedAt: null,
            revokedBy: null,
            updatedAt: new Date(),
          })
          .execute();
      const overview = await platform.settings.overview(viewer);
      expect(overview.rows).toHaveLength(role === "non-member" ? 0 : 1);
      expect(JSON.stringify(overview)).not.toContain("/private/owner-skill-files");
      const pending = await platform.requests.waitingOnUserPage({ userId: viewer, limit: 100 });
      expect(pending.requests.some((r) => r.request.id === opened.request.id)).toBe(
        role === "admin",
      );
      expect(
        await platform.settings.affectedViewers({ requestId: opened.request.id }),
      ).not.toContain(role === "non-member" || role === "member" ? viewer : "absent");
      if (role !== "owner" && role !== "non-member") {
        const detail = await platform.settings.detail(viewer, { kind: "plugin", pluginId });
        expect(detail.sourceFolder).toBeNull();
        expect(detail.accounts).toEqual([]);
        expect(detail.permissions).toEqual([]);
        await f.database
          .updateTable("workspaceMemberships")
          .set({ state: "revoked", revokedAt: new Date(), revokedBy: run.userId })
          .where("workspaceId", "=", run.workspace.id)
          .where("userId", "=", viewer)
          .execute();
        expect((await platform.settings.overview(viewer)).rows).toEqual([]);
        expect(
          (await platform.requests.waitingOnUserPage({ userId: viewer, limit: 100 })).requests,
        ).toEqual([]);
        expect(
          await platform.settings.affectedViewers({ requestId: opened.request.id }),
        ).not.toContain(viewer);
        await expect(
          platform.settings.detail(viewer, { kind: "plugin", pluginId }),
        ).rejects.toMatchObject({ code: "forbidden" });
      }
    }
  });

  test("overview is set based, membership scoped and never exposes source paths", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-viewer");
    const plugins = new IntegrationPlatformStore(f.database).plugins;
    let queries = 0;
    const counter: KyselyPlugin = {
      transformQuery({ node }) {
        queries++;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    };
    const settings = new PluginSettingsStore(f.database.withPlugin(counter));
    const install = (name: string) =>
      plugins.install({
        id: randomUUID(),
        name,
        actorUserId: run.userId,
        workspaceId: run.workspace.id,
        source: { directory: "/private/plugin-source" },
        digest: name,
        manifest: { name, skills: [] },
      });
    await install("first");
    queries = 0;
    expect((await settings.overview(run.userId)).rows).toHaveLength(1);
    const small = queries;
    for (let i = 0; i < 15; i++) await install(`package-${i}`);
    queries = 0;
    const overview = await settings.overview(run.userId);
    expect(overview.rows).toHaveLength(16);
    expect(queries).toBe(small);
    expect(JSON.stringify(overview)).not.toContain("/private/plugin-source");
    const outsider = await f.store.createUser("outsider");
    expect((await settings.overview(outsider)).rows).toEqual([]);
    await f.database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", outsider)
      .execute();
    expect((await settings.overview(outsider)).rows).toEqual([]);
    const hidden = overview.rows[0]!.target;
    await expect(settings.detail(outsider, hidden)).rejects.toMatchObject({ code: "forbidden" });
  });

  test("membership removal hides Workspace package rows and detail even from their installer", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-membership");
    const project = await createTestWorkspace(f.store, {
      backing: { ...run.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: run.userId,
      idempotencyKey: "private-package-project",
      kind: "project",
      name: "Private project",
      status: "ready",
    });
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "hidden-package",
      actorUserId: run.userId,
      workspaceId: project.id,
      source: { directory: "/private/hidden-package" },
      digest: "hidden",
      manifest: { name: "hidden-package", skills: [{ name: "hidden-skill" }] },
    });
    expect((await platform.settings.overview(run.userId)).rows).toHaveLength(1);
    const successor = await f.store.createUser("Successor");
    const membership = await f.database
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", project.id)
      .where("userId", "=", run.userId)
      .executeTakeFirstOrThrow();
    await f.database
      .insertInto("workspaceMemberships")
      .values({ ...membership, id: createId("workspaceMembership"), userId: successor })
      .execute();
    await f.database
      .updateTable("workspaceMemberships")
      .set({
        state: "revoked",
        revokedAt: new Date(),
        revokedBy: successor,
        generation: membership.generation + 1,
      })
      .where("workspaceId", "=", project.id)
      .where("userId", "=", run.userId)
      .execute();
    expect((await platform.settings.overview(run.userId)).rows).toEqual([]);
    await expect(
      platform.settings.detail(run.userId, { kind: "plugin", pluginId }),
    ).rejects.toThrow("unavailable");
  });

  test("Off and Main exclusion invalidate cached connectionless tools", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-connectionless");
    const platform = new IntegrationPlatformStore(f.database);
    const installationId = createIntegrationId("installation");
    await platform.install({
      actorUserId: run.userId,
      adapterSnapshot: null,
      requestId: "install-connectionless",
      installation: {
        id: installationId,
        name: "records-installation",
        title: "Records",
        description: "",
        version: "1",
        sourceKind: "built-in",
        status: "active",
        trust: "built-in",
        manifest: { definition: { id: "records" } },
        provenance: {},
      },
      servers: [
        {
          id: createIntegrationId("server"),
          name: "default",
          status: "active",
          statusDetail: null,
          connectionRequirement: { kind: "none" },
          transport: { type: "streamable-http", url: "https://records.example/mcp", headers: {} },
          catalog: {
            definitions: {},
            tools: [
              {
                id: createIntegrationId("tool"),
                name: "read",
                title: "Read",
                description: "",
                annotations: { readOnlyHint: true },
                connectionId: null,
                inputSchema: { type: "object" },
                outputSchema: null,
                status: "active",
              },
            ],
          },
        },
      ],
    });
    await platform.createGrant({
      access: "read",
      alias: "records",
      connectionId: null,
      createdBy: run.userId,
      installationId,
      isDefault: true,
      ownerUserId: run.userId,
      providerAuthorizations: {},
      workspaceId: run.workspace.id,
    });
    const scope = {
      ownerUserId: run.userId,
      workspaceId: run.workspace.id,
      threadId: run.thread.id,
      providerAuthorizations: {},
    };
    await f.database
      .updateTable("integrationInstallations")
      .set({ status: "needs-attention" })
      .where("id", "=", installationId)
      .execute();
    expect((await platform.settings.overview(run.userId)).rows[0]?.issues).toEqual([
      "invalid-installation",
    ]);
    await f.database
      .updateTable("integrationInstallations")
      .set({ status: "active" })
      .where("id", "=", installationId)
      .execute();
    const cached = await platform.listCallableTools(scope);
    expect(cached).toHaveLength(1);
    const target = { kind: "service" as const, definitionId: "records" };
    expect(
      (await platform.settings.detail(run.userId, target)).row.placement.revision,
    ).toBeGreaterThan(0);
    await platform.settings.setEnabled(run.userId, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      enabled: false,
      idempotencyKey: "off-connectionless",
    });
    expect(await platform.listCallableTools(scope)).toEqual([]);
    expect((await platform.settings.detail(run.userId, target)).grants).toHaveLength(1);
    await platform.settings.setEnabled(run.userId, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      enabled: true,
      idempotencyKey: "on-connectionless",
    });
    expect(await platform.listCallableTools(scope)).toHaveLength(1);
    await platform.settings.setPlacement(
      run.userId,
      {
        type: "settings.plugin.placement.set",
        target,
        expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement
          .revision,
        mainIncluded: false,
        projects: [],
        personalEverywhere: null,
        idempotencyKey: "exclude-main-connectionless",
      },
      {},
    );
    expect(await platform.listCallableTools(scope)).toEqual([]);
    const detail = await platform.settings.detail(run.userId, target);
    await platform.revokeGrant({
      grantId: detail.grants[0]!.id,
      ownerUserId: run.userId,
      workspaceId: run.workspace.id,
      requestId: "legacy-revoke",
    });
    expect(
      (await platform.settings.detail(run.userId, target)).row.placement.revision,
    ).toBeGreaterThan(detail.row.placement.revision);
  });
  test("specialist placement preserves existing registrations and applies Personal future consent", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-specialist", {
      deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
      workspaceBacking: "local-directory",
    });
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "specialist",
      actorUserId: run.userId,
      source: {},
      digest: "a".repeat(64),
      manifest: { name: "specialist" },
      specialistManifest: {
        version: 1,
        fallback: "none",
        models: [{ engine: "claude", model: "haiku" }],
        access: [],
      },
    });
    const registration = await platform.specialists.add({
      workspaceId: run.workspace.id,
      pluginId,
      actorUserId: run.userId,
    });
    const target = { kind: "specialist" as const, pluginId, ownerUserId: run.userId };
    await platform.settings.setPlacement(
      run.userId,
      {
        type: "settings.plugin.placement.set",
        target,
        expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement
          .revision,
        mainIncluded: true,
        projects: [],
        personalEverywhere: { accounts: [] },
        idempotencyKey: "specialist-everywhere",
      },
      {},
    );
    await platform.settings.setEnabled(run.userId, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      enabled: false,
      idempotencyKey: "specialist-off",
    });
    const project = await createTestWorkspace(f.store, {
      backing: { ...run.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: run.userId,
      idempotencyKey: "future-specialist",
      name: "Future",
      kind: "project",
      status: "ready",
    });
    const future = await platform.specialists.list(project.id, run.userId);
    expect(future).toHaveLength(1);
    await expect(
      platform.specialists.assertRunnable(future[0]!.id, project.id, run.userId),
    ).rejects.toMatchObject({ code: "forbidden" });
    await platform.settings.setEnabled(run.userId, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      enabled: true,
      idempotencyKey: "specialist-on",
    });
    expect((await platform.specialists.list(run.workspace.id, run.userId))[0]?.id).toBe(
      registration.id,
    );
    expect(
      (await platform.specialists.assertRunnable(future[0]!.id, project.id, run.userId)).id,
    ).toBe(future[0]!.id);
  });
  test("Off preserves activation, owner management and idempotent results while filtering the Run plan", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-off");
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "off-plugin",
      actorUserId: run.userId,
      workspaceId: run.workspace.id,
      source: { directory: "/private/source" },
      digest: "off",
      manifest: { name: "off-plugin", skills: [{ name: "summarize" }] },
    });
    const target = { kind: "plugin" as const, pluginId };
    const initialRevision = (await platform.settings.detail(run.userId, target)).row.placement
      .revision;
    const command = {
      type: "settings.plugin.enabled.set" as const,
      target,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      enabled: false,
      idempotencyKey: "disable-plugin",
    };
    expect(await platform.settings.setEnabled(run.userId, command)).toMatchObject({
      placement: { enabled: false, revision: initialRevision + 1 },
    });
    expect(await platform.plugins.current(run.workspace.id, run.userId)).toEqual([]);
    expect(await platform.plugins.current(run.workspace.id)).toHaveLength(1);
    expect(await platform.settings.detail(run.userId, target)).toMatchObject({
      sourceFolder: "/private/source",
      contents: [{ name: "summarize", kind: "skill" }],
      row: { permissions: { canUpdate: true }, placement: { enabled: false } },
    });
    expect(await platform.settings.setEnabled(run.userId, command)).toMatchObject({
      placement: { revision: initialRevision + 1 },
    });
    await expect(
      platform.settings.setEnabled(run.userId, { ...command, enabled: true }),
    ).rejects.toThrow();
    await platform.settings.setEnabled(run.userId, {
      ...command,
      enabled: true,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      idempotencyKey: "enable-plugin",
    });
    expect(await platform.plugins.current(run.workspace.id, run.userId)).toHaveLength(1);
    expect(pluginTargetKey(target)).toBe(pluginTargetKey({ pluginId, kind: "plugin" }));
  });
  test("legacy activation changes advance revisions and reject stale Settings consent", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-legacy-revision");
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "legacy-revision",
      actorUserId: run.userId,
      source: {},
      digest: "a".repeat(64),
      manifest: { name: "legacy-revision" },
    });
    const target = { kind: "plugin" as const, pluginId };
    const before = (await platform.settings.detail(run.userId, target)).row.placement.revision;
    await platform.plugins.setActivation({
      pluginId,
      workspaceId: run.workspace.id,
      actorUserId: run.userId,
      active: true,
    });
    const after = (await platform.settings.detail(run.userId, target)).row.placement.revision;
    expect(after).toBeGreaterThan(before);
    await expect(
      platform.settings.setEnabled(run.userId, {
        type: "settings.plugin.enabled.set",
        target,
        expectedRevision: before,
        enabled: false,
        idempotencyKey: "stale-legacy",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await platform.plugins.setActivation({
      pluginId,
      workspaceId: run.workspace.id,
      actorUserId: run.userId,
      active: false,
    });
    expect(
      (await platform.settings.detail(run.userId, target)).row.placement.revision,
    ).toBeGreaterThan(after);
  });
  test("Main exclusion filters an explicit package activation without removing it", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-main");
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "main-plugin",
      actorUserId: run.userId,
      source: {},
      digest: "main",
      manifest: { name: "main-plugin" },
    });
    await platform.plugins.setActivation({
      pluginId,
      workspaceId: run.workspace.id,
      actorUserId: run.userId,
      active: true,
    });
    const target = { kind: "plugin" as const, pluginId };
    await platform.settings.setPlacement(
      run.userId,
      {
        type: "settings.plugin.placement.set",
        target,
        expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement
          .revision,
        idempotencyKey: "exclude-main",
        mainIncluded: false,
        projects: [],
        personalEverywhere: null,
      },
      {},
    );
    expect(await platform.plugins.current(run.workspace.id, run.userId)).toEqual([]);
    expect(await platform.plugins.current(run.workspace.id)).toHaveLength(1);
  });

  test("Personal Everywhere grants future Projects under explicit package consent; server refuses", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-future", {
      deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
      workspaceBacking: "local-directory",
    });
    const platform = new IntegrationPlatformStore(f.database);
    await f.database
      .updateTable("deployments")
      .set({ deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" } })
      .execute();
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "future-plugin",
      actorUserId: run.userId,
      source: {},
      digest: "future",
      manifest: { name: "future-plugin" },
    });
    const target = { kind: "plugin" as const, pluginId };
    const command = {
      type: "settings.plugin.placement.set" as const,
      target,
      expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement.revision,
      idempotencyKey: "everywhere",
      mainIncluded: true,
      projects: [],
      personalEverywhere: { accounts: [] },
    };
    await platform.settings.setPlacement(run.userId, command, {});
    const project = await createTestWorkspace(f.store, {
      backing: { ...run.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: run.userId,
      idempotencyKey: "future-project",
      kind: "project",
      name: "Future",
      status: "ready",
    });
    expect(await platform.plugins.current(project.id, run.userId)).toHaveLength(1);
    const barrier = pauseAfterLock(
      f.database,
      (node) => node.includes('"name":"users"') && node.includes("ForNoKeyUpdate"),
    );
    const edit = new PluginSettingsStore(barrier.database).setPlacement(
      run.userId,
      {
        ...command,
        expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement
          .revision,
        idempotencyKey: "clear-future-consent",
        projects: [{ workspaceId: project.id, accounts: [] }],
        personalEverywhere: null,
      },
      {},
    );
    let creating: ReturnType<typeof createTestWorkspace> | undefined;
    try {
      await withTimeout(barrier.reached, 3000, {
        timeoutError: () => new Error("Consent edit never locked its owner"),
      });
      creating = createTestWorkspace(f.store, {
        backing: { ...run.workspace.backing, bindingId: createId("workspaceBinding") },
        createdBy: run.userId,
        idempotencyKey: "concurrent-project",
        kind: "project",
        name: "Concurrent",
        status: "ready",
      });
    } finally {
      barrier.release();
      await edit;
    }
    if (!creating) throw new Error("Concurrent Project creation never started");
    const concurrent = await withTimeout(creating, 5000, {
      timeoutError: () => new Error("Project creation never observed committed consent"),
    });
    expect(await platform.plugins.current(concurrent.id, run.userId)).toEqual([]);
    await f.database
      .updateTable("deployments")
      .set({ deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" } })
      .execute();
    await expect(
      platform.settings.setPlacement(
        run.userId,
        {
          ...command,
          expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement
            .revision,
          idempotencyKey: "server-everywhere",
          projects: [{ workspaceId: project.id, accounts: [] }],
        },
        {},
      ),
    ).rejects.toThrow("explicit consent");
  });
  test("future account consent grants only exact accounts and ceilings, atomically with Project creation", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("settings-future-accounts", {
      deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
      workspaceBacking: "local-directory",
    });
    const platform = new IntegrationPlatformStore(f.database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    await platform.install({
      adapterSnapshot: null,
      actorUserId: run.userId,
      requestId: "install-account-fixture",
      installation: {
        id: installationId,
        name: "records",
        title: "Records",
        description: "Records",
        version: "1",
        sourceKind: "built-in",
        status: "active",
        trust: "built-in",
        manifest: { definition: { id: "records" } },
        provenance: {},
      },
      servers: [
        {
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          connectionRequirement: {
            kind: "provider",
            provider: "records",
            definitionId: "records",
            providerApplicationRequired: false,
          },
          transport: { type: "streamable-http", url: "https://records.example/mcp", headers: {} },
          catalog: { definitions: {}, tools: [] },
        },
      ],
    });
    const connections = [createIntegrationId("connection"), createIntegrationId("connection")];
    for (const id of connections)
      await f.database
        .insertInto("integrationConnections")
        .values({
          id,
          ownerUserId: run.userId,
          provider: "records",
          integrationDefinitionId: "records",
          connectionKind: "provider-account",
          connectionMethod: "api-key",
          status: "connected",
          displayName: id,
          accountIdentifier: null,
          applicationSource: jsonValue({ kind: "api-key" }),
          authMethodId: "api-key",
          authorizationDigest: "a".repeat(43),
          credentialId: null,
          computerAccess: null,
          computerBlockedAt: null,
          integrationServerId: null,
          providerApplicationId: null,
          externalIdentityId: id,
          externalTenantId: null,
          capabilities: jsonValue([]),
          grantedScopes: jsonValue([]),
          runnerId: null,
          statusDetail: null,
          transportKind: null,
          updatedAt: new Date(),
        })
        .execute();
    // Private accounts remain private even when an administrator shares the source Workspace.
    await f.database
      .updateTable("deployments")
      .set({ deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" } })
      .execute();
    for (const role of ["administrator", "member"] as const) {
      const viewer = await f.store.createUser(`private-account-${role}`);
      if (role === "administrator")
        await f.database
          .updateTable("users")
          .set({ instanceRole: role })
          .where("id", "=", viewer)
          .execute();
      await f.database
        .insertInto("workspaceMemberships")
        .values({
          id: createId("workspaceMembership"),
          workspaceId: run.workspace.id,
          userId: viewer,
          role: "collaborator",
          state: "active",
          generation: 1,
          invitedBy: run.userId,
          joinedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          updatedAt: new Date(),
        })
        .execute();
      expect((await platform.settings.overview(viewer)).rows).toEqual([]);
      await expect(
        platform.settings.detail(viewer, { kind: "service", definitionId: "records" }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    await f.database
      .updateTable("deployments")
      .set({ deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" } })
      .execute();
    const target = { kind: "service" as const, definitionId: "records" };
    await platform.settings.setPlacement(
      run.userId,
      {
        type: "settings.plugin.placement.set",
        target,
        expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement
          .revision,
        idempotencyKey: "account-everywhere",
        mainIncluded: true,
        projects: [],
        personalEverywhere: { accounts: [{ connectionId: connections[0]!, access: "read" }] },
      },
      {},
    );
    expect(
      await f.database
        .selectFrom("integrationGrants")
        .select("id")
        .where("workspaceId", "=", run.workspace.id)
        .execute(),
    ).toEqual([]);
    const project = await createTestWorkspace(f.store, {
      backing: { ...run.workspace.backing, bindingId: createId("workspaceBinding") },
      createdBy: run.userId,
      idempotencyKey: "future-account-project",
      kind: "project",
      name: "Future accounts",
      status: "ready",
    });
    const grants = await f.database
      .selectFrom("integrationGrants")
      .selectAll()
      .where("workspaceId", "=", project.id)
      .execute();
    expect(grants.map(({ connectionId, access }) => ({ connectionId, access }))).toEqual([
      { connectionId: connections[0], access: "read" },
    ]);
    await f.database
      .updateTable("integrationConnections")
      .set({ status: "revoked" })
      .where("id", "=", connections[0]!)
      .execute();
    await expect(
      createTestWorkspace(f.store, {
        backing: { ...run.workspace.backing, bindingId: createId("workspaceBinding") },
        createdBy: run.userId,
        idempotencyKey: "revoked-account-project",
        kind: "project",
        name: "Must roll back",
        status: "ready",
      }),
    ).rejects.toThrow("unavailable");
    expect(
      await f.database
        .selectFrom("workspaces")
        .select("id")
        .where("name", "=", "Must roll back")
        .execute(),
    ).toEqual([]);
    expect(await platform.settings.detail(run.userId, target)).toMatchObject({
      row: { issues: ["needs-sign-in"], permissions: { canPlace: true } },
    });
    await platform.settings.setPlacement(
      run.userId,
      {
        type: "settings.plugin.placement.set",
        target,
        expectedRevision: (await platform.settings.detail(run.userId, target)).row.placement
          .revision,
        idempotencyKey: "clear-revoked-consent",
        mainIncluded: true,
        projects: [],
        personalEverywhere: null,
      },
      {},
    );
  });
});
