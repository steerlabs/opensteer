import { channelProviderCatalog } from "@opensteer/channel-core";
import { createId, type RequestId } from "@opensteer/core";
import { createBrowserSessionId } from "@opensteer/protocol";
import { sql } from "kysely";
import {
  createIntegrationId,
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
  pluginDeviceFromManifest,
} from "@opensteer/integration-core";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { computerAppAccessPresentation } from "./computer-app-setup.js";
import {
  computerConnectionTargetInTransaction,
  writeComputerConnectionInTransaction,
} from "./computer-connection-writes.js";
import { integrationConnectionFromRow } from "./integration-connections.js";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { needsYouPage } from "./needs-you-store.js";
import { requestFromRow } from "./request-persistence.js";
import { testRunnerDescriptor } from "./runner-fixture.test-support.js";
import { personalReachableGrant } from "./runner-store.js";
import { TabStore } from "./tab-store.js";
import {
  describeStore,
  liveRequest,
  pendingEvent,
  testMessagingRunnerId,
  testModelSelection,
} from "./store.integration.test-support.js";

/**
 * A name from outside enters the Home clean (`outsideName`), so no answer carries one dirty: the
 * forged names the re-check used, a zero-width joiner, a tab and a 5,000-character name go in
 * through each entrance, and every name in what the Home then answers is read.
 */
const forged = [
  "Helper\u202E\nDisconnected",
  "#ops\u202E\nOnly you can message this chat",
  "Work\u200DOps",
  "Tab\tName",
  "x".repeat(5_000),
];
const nameKeys = new Set([
  "label",
  "clientName",
  "displayName",
  "conversationName",
  "accountName",
  "accountHandle",
  "handle",
  "title",
  "name",
]);
/** Every name in `value`, by its key. */
function names(value: unknown, found: string[] = [], key = ""): string[] {
  if (typeof value === "string") {
    if (nameKeys.has(key)) found.push(value);
  } else if (Array.isArray(value)) for (const item of value) names(item, found, key);
  else if (value && typeof value === "object")
    for (const [entry, item] of Object.entries(value)) names(item, found, entry);
  return found;
}
const dirty = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const cleaned = [
  "Helper Disconnected",
  "#ops Only you can message this chat",
  "WorkOps",
  "Tab Name",
];
const boundedNames = forged.slice(0, cleaned.length);

describeStore("a name from outside enters the Home clean", (it) => {
  it("keeps device and Runner names clean on enrollment, replay, rename and reporting (the wire caps length)", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const {
      userId,
      runnerId: mainRunnerId,
      environmentId,
    } = await storeFixture.createRunFixture("outside-devices");
    await storeFixture.enablePersonalRemoteAccess();
    const sessionId = createId("authSession");
    await database
      .insertInto("authSessions")
      .values({
        id: sessionId,
        userId,
        token: sessionId,
        deviceLabel: "Test",
        userAgent: null,
        ipAddress: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 120_000),
      })
      .execute();
    const actual: unknown[] = [];
    const expected: string[] = [];
    function check(value: unknown, name: string) {
      actual.push(value);
      expected.push(name);
    }
    for (const [index, name] of boundedNames.entries()) {
      const expectedName = cleaned[index]!;
      const renamed = boundedNames[(index + 1) % boundedNames.length]!;
      const expectedRename = cleaned[(index + 1) % cleaned.length]!;
      const runnerId = createId("runner");
      const enrollment = {
        allowedModules: personalReachableGrant,
        createdBy: userId,
        expiresAt: new Date(Date.now() + 60_000),
        id: `outside-${runnerId}`,
        idempotencyKey: runnerId,
        name,
        requestFingerprint: runnerId,
        runnerKind: "local" as const,
        tokenHash: runnerId,
      };
      const issuance = await store.createRunnerEnrollment(enrollment);
      expect(await store.createRunnerEnrollment(enrollment)).toEqual(issuance);
      const pending = await store.listPendingRunnerEnrollments({
        includeDeployment: false,
        limit: 100,
        ownerId: userId,
      });
      check(pending.find((row) => row.id === issuance.id)?.name, expectedName);
      const descriptor = {
        ...testRunnerDescriptor({
          runnerId,
          runnerKind: "local",
          name,
          environmentId: createId("environment"),
          modules: { integrations: { platform: "darwin", screenDrivers: 1 } },
        }),
        device: { platform: "macos" as const, form: "desktop" as const, app: "opensteer" as const },
      };
      const connection = await store.enrollRunnerConnection({
        descriptor,
        enrollmentTokenHash: enrollment.tokenHash,
        publicKeyPem: `test-key-${runnerId}`,
        publicKeyFingerprint: `test-fingerprint-${runnerId}`,
      });
      const deviceId = await store.requireSelfDeviceId(runnerId);
      const listName = async () =>
        (
          await store.listRunners({ includeDeployment: false, limit: 100, ownerId: userId })
        ).runners.find((row) => row.id === runnerId)?.name;
      check(await listName(), expectedName);
      check((await store.getDevice(deviceId))?.name, expectedName);
      const phone = await store.attachIphoneScreen({
        sessionId,
        userId,
        driverRunnerId: runnerId,
        driverConnectionGeneration: connection.connectionGeneration,
        negotiatedScreenDrivers: 1,
        idempotencyKey: runnerId,
        target: { kind: "new", name },
      });
      check((await store.getDevice(phone.deviceId))?.name, expectedName);
      await store.renameDevice(phone.deviceId, userId, renamed);
      check((await store.getDevice(phone.deviceId))?.name, expectedRename);
      await store.renameDevice(deviceId, userId, renamed);
      check(await listName(), expectedRename);
      check((await store.getDevice(deviceId))?.name, expectedRename);
      await store.renameRunner(mainRunnerId, userId, name, { allowDeployment: true });
      check(
        (await store.listEnvironments()).find((row) => row.id === environmentId)?.name,
        expectedName,
      );
      await store.authenticateRunnerConnection({
        ...descriptor,
        modules: { integrations: { platform: "android", protocolVersion: 4 } },
      });
      check(await listName(), expectedName);
      check((await store.getDevice(deviceId))?.name, expectedName);
    }
    expect(actual).toEqual(expected);
  });

  it("keeps no control or format character, line break or overlong name in any answer", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { channels, fixture } = await storeFixture.createChannelDeliveryFixture("outside", {
      bridge: false,
    });
    const connections = new AgentConnectionStore(database);
    const { upsertChannelIdentity } = await import("./channel-store.js");
    const { commitPersonalMutation } = await import("./personal-mutation.js");
    const answers: unknown[] = [];
    // A task with a question for the person, so Needs you names it.
    const asking = await storeFixture.startRunFixture("outside-asking");
    await storeFixture.openLiveRequest(asking, createId("request") as RequestId);
    for (const [index, name] of forged.entries()) {
      // A messaging account and its connection, as its provider names them.
      const { account, connection } = await channels.createConnection({
        account: {
          displayName: name,
          externalAccountId: `T-outside-${index}`,
          handle: name,
          routingMode: "dedicated",
        },
        connection: {
          runnerId: testMessagingRunnerId,
          connectionMethod: "bring-your-own",
          displayName: name,
          externalIdentityId: `U-outside-${index}`,
          externalTenantId: `T-outside-${index}`,
          provider: "slack",
          transportKind: "socket",
        },
        createdBy: fixture.userId,
        credential: {
          encryptedPayload: Buffer.from(`outside-${index}`),
          encryptionKeyVersion: 1,
          id: createId("credential"),
          name: `Outside ${index}`,
          ownerId: fixture.userId,
          provider: "channel:slack",
        },
      });
      await channels.setRuntimeConnectionHealth({
        connectionId: connection.id,
        detail: null,
        reason: null,
        runnerId: testMessagingRunnerId,
        status: "connected",
      });
      // A connected agent's own name and the label the person typed at consent.
      await connections.create({
        userId: fixture.userId,
        label: name,
        clientName: name,
        accessMode: "approval-required",
        resource: "https://home.example/mcp",
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      // A chat for a conversation the provider names.
      await connections.createBridge({
        userId: fixture.userId,
        accountId: account.id,
        conversation: { id: `C-outside-${index}`, name },
        senders: "anyone",
        accessMode: "approval-required",
        grant: { scope: "selected", tasks: true, resources: [] },
      });
      // A sender's name, as the bridge takes it in.
      await commitPersonalMutation(database, (tx) =>
        upsertChannelIdentity(tx, {
          accountId: account.id,
          displayName: name,
          externalUserId: `U-sender-${index}`,
        } as never),
      );
      // A task titled from a chat's message.
      const { thread } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: `outside-${index}`,
        modelSelection: testModelSelection,
        title: name,
      });
      answers.push(await store.getThreadForOwner(thread.id, fixture.userId));
      // A task renamed to it, as Needs you then names that task. A title longer than a title may
      // be is refused where it arrives, never stored.
      const rename = store.renameThread({
        threadId: asking.threadId,
        requestedBy: asking.userId,
        idempotencyKey: `outside-rename-${index}`,
        title: name,
      });
      if (name.length > 240) await expect(rename).rejects.toThrow();
      else await rename;
      answers.push(await needsYouPage(database, { userId: asking.userId }));
      // A message's sender and conversation, as the provider sends them (a name longer than the
      // wire allows is refused there, never stored).
      if (name.length <= 160) {
        const { ingressId } = await channels.commitIngress(connection.id, {
          accountExternalId: `T-outside-${index}`,
          actor: { displayName: name, externalUserId: `U-sender-${index}` },
          content: [{ type: "text", text: "hello" }],
          conversation: {
            displayName: name,
            externalConversationId: `C-outside-${index}`,
            externalScopeId: null,
            externalThreadId: null,
            type: "channel",
          },
          eventId: `E-outside-${index}`,
          occurredAt: new Date().toISOString(),
          provider: "slack",
          providerMessageId: `M-outside-${index}`,
          trigger: "mention",
        });
        answers.push(
          await database
            .selectFrom("channelIngressEvents")
            .select("event")
            .where("id", "=", ingressId)
            .executeTakeFirstOrThrow(),
        );
      }
    }
    answers.push(await connections.list(fixture.userId, { includeRevoked: true }));
    answers.push(
      await channels.dashboard(fixture.userId, channelProviderCatalog, [testMessagingRunnerId]),
    );
    const served = names(answers);
    expect(served.length).toBeGreaterThan(forged.length * 6);
    expect(served.filter((name) => dirty.test(name))).toEqual([]);
    expect(served.filter((name) => Array.from(name).length > 240)).toEqual([]);
    expect(served).toContain("Helper Disconnected");
    expect(served).toContain("#ops Only you can message this chat");
  });

  it("keeps the stored Mac app connection label clean (the wire caps length)", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const { userId, runnerId, run, threadId, environmentId } =
      await storeFixture.startRunFixture("outside-mac-app");
    const deviceId = await store.requireSelfDeviceId(runnerId);
    const definition = integrationDefinitionSummary(
      IntegrationDefinitionSchema.parse({
        adapter: "computer",
        authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
        config: {
          accessLabels: { read: "Observe", readWrite: "Control" },
          accessSummaries: { read: "Observe the app", readWrite: "Control the app" },
          kind: "gui",
          operations: [
            {
              description: "Observe the app",
              effect: "read",
              inputSchema: { type: "object" },
              name: "observe",
              outputSchema: null,
              title: "Observe",
            },
          ],
          platforms: ["darwin"],
        },
        description: "One Mac app",
        id: "macos-app",
        name: "Computer use",
        provider: "apple",
      }),
    );
    const platform = new IntegrationPlatformStore(database);
    await platform.install({
      actorUserId: userId,
      installation: {
        description: definition.description,
        id: createIntegrationId("installation"),
        manifest: { definition },
        name: definition.id,
        provenance: { definitionId: definition.id, maintainedBy: "opensteer" },
        sourceKind: "built-in",
        status: "active",
        title: definition.name,
        trust: "built-in",
        version: "fixture",
      },
      requestId: "outside-mac-app",
      servers: [
        {
          catalog: null,
          connectionRequirement: { definitionId: definition.id, kind: "computer" },
          id: createIntegrationId("server"),
          name: "default",
          status: "active",
          statusDetail: null,
          transport: { definitionId: definition.id, type: "computer" },
        },
      ],
    });
    const labels: string[] = [];
    const activityLabels: (string | undefined)[] = [];
    for (const [index, displayName] of boundedNames.entries()) {
      const app = { bundleId: "test.app", displayName, teamId: null };
      const row = await database.transaction().execute(async (tx) => {
        const target = await computerConnectionTargetInTransaction(tx, {
          app,
          definitionId: definition.id,
          deviceId,
        });
        return writeComputerConnectionInTransaction(tx, {
          access: "read",
          app,
          now: new Date(),
          ownerUserId: userId,
          runner: { id: deviceId, name: "Mac" },
          target,
        });
      });
      labels.push(integrationConnectionFromRow(row).displayName);
      expect(integrationConnectionFromRow(row).computer?.app).toEqual(app);
      expect(
        computerAppAccessPresentation({
          access: "read",
          app,
          reason: "The task is waiting.",
          runnerName: "Mac",
          setupRequestId: "outside-mac-app",
        }).title,
      ).toBe(`Wants to use ${cleaned[index]} on Mac`);
      const { toolCallId } = await platform.computerOperations.start({
        context: { runId: run.id, threadId, environmentId },
        operation: "observe",
        subject: {
          account: "Mac",
          computerApp: {
            app: displayName,
            bundleId: app.bundleId,
            computer: "Mac",
            runnerId: deviceId,
          },
          effect: "read",
          integration: "Computer use",
          operation: { name: "observe", title: "Observe" },
        },
      });
      const { integration } = await database
        .selectFrom("toolCalls")
        .select("integration")
        .where("id", "=", toolCallId)
        .executeTakeFirstOrThrow();
      expect(integration?.computerApp?.bundleId).toBe(app.bundleId);
      activityLabels.push(integration?.computerApp?.app);
    }
    expect(labels).toEqual(cleaned.map((name) => `${name} on Mac`));
    expect(activityLabels).toEqual(cleaned);
  });

  it("keeps browser page titles clean on tab creation, updates, visits and Run places", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const f = await storeFixture.startRunFixture("outside-pages");
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", f.runnerId)
      .execute();
    const profile = await store.createBrowserProfile({
      ownerId: f.userId,
      name: "History",
      idempotencyKey: "outside-history",
    });
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      ownerId: f.userId,
      origin: "agent",
      opener: { kind: "person", userId: f.userId },
      placementKey: "outside-pages",
      profileId: null,
      runtimeId: "test",
    });
    const deviceId = await store.requireSelfDeviceId(f.runnerId);
    const tabs = new TabStore(database);
    const actual: unknown[] = [];
    const expected: unknown[] = [];
    for (const [index, title] of forged.entries()) {
      const tabId = createId("tab");
      const binding = { lineageId: sessionId, sessionId, surfaceId: tabId };
      const url = `https://example.com/${index}?raw=%E2%80%AE%09`;
      const cleanTitle = cleaned[index] ?? "x".repeat(1_024);
      await tabs.open(
        {
          id: tabId,
          ownerId: f.userId,
          computerId: deviceId,
          kind: "page",
          title,
          url: "about:blank",
          pageBinding: binding,
          openedBy: "person",
        },
        `outside-page-${index}`,
      );
      actual.push((await tabs.get(f.userId, tabId))?.title);
      expected.push(cleanTitle);
      await tabs.updatePage(f.userId, tabId, 1, binding, { title, url });
      const tab = await tabs.get(f.userId, tabId);
      actual.push(tab?.title, tab?.url);
      expected.push(cleanTitle, url);
      await store.browserHistory.recordVisit({
        profileId: profile.id,
        ownerId: f.userId,
        url,
        title,
        typed: false,
      });
      const history = await store.browserHistory.list(profile.id, f.userId);
      actual.push(history.entries.find((visit) => visit.url === url)?.title);
      expected.push(cleanTitle.slice(0, 200));
      const nextIndex = (index + 1) % forged.length;
      await store.browserHistory.retitle({ profileId: profile.id, url, title: forged[nextIndex]! });
      const retitled = await store.browserHistory.list(profile.id, f.userId);
      actual.push(retitled.entries.find((visit) => visit.url === url)?.title);
      expected.push(cleaned[nextIndex] ?? "x".repeat(200));
      await store.recordBrowserSessionUse({
        sessionId,
        threadId: f.threadId,
        ownerId: f.userId,
        tabId,
        page: { title, site: "https://example.com" },
      });
      const usage = await database
        .selectFrom("browserSessionUses")
        .select("pageTitle")
        .where("sessionId", "=", sessionId)
        .where("tabId", "=", tabId)
        .executeTakeFirstOrThrow();
      actual.push(usage.pageTitle);
      expected.push(cleanTitle.slice(0, 256));
      await store.recordRunTabPlace({
        runId: f.run.id,
        bindingGeneration: f.bindingGeneration,
        data: { tabId, title, site: "https://example.com" },
      });
      actual.push((await store.latestRunPlace(f.run.id))?.title);
      expected.push(cleanTitle);
    }
    expect(actual).toEqual(expected);
  });
  it("keeps the manifest display name and local server title clean across installation and updates", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { userId } = await storeFixture.createRunFixture("outside-plugins");
    const platform = new IntegrationPlatformStore(database);
    const pluginId = createIntegrationId("installation");
    const installationId = createIntegrationId("installation");
    for (const [index, title] of forged.entries()) {
      const packageName = "local-fixture";
      const manifest = {
        name: packageName,
        extensions: { "com.opensteer": { device: { kind: "other", name: title } } },
      };
      const version = { digest: `outside-${index}`, packageFormat: "fixture", manifest };
      if (index === 0) {
        await platform.plugins.install({
          ...version,
          id: pluginId,
          actorUserId: userId,
          name: packageName,
          source: {},
        });
      } else await platform.plugins.update({ ...version, pluginId });
      const { installation } = await platform.install({
        actorUserId: userId,
        installation: {
          description: "",
          id: installationId,
          manifest,
          name: packageName,
          pluginId,
          provenance: {},
          sourceKind: "plugin",
          status: "active",
          title,
          trust: "administrator-approved",
          version: null,
        },
        requestId: `outside-plugin-${index}`,
        servers: [],
      });
      const [plugin] = await platform.plugins.current(userId);
      const name = cleaned[index] ?? "x".repeat(80);
      expect
        .soft({
          pluginDevice: pluginDeviceFromManifest(plugin?.manifest)?.name,
          installationDevice: pluginDeviceFromManifest(installation.manifest)?.name,
          title: installation.title,
        })
        .toEqual({
          pluginDevice: name,
          installationDevice: name,
          title: cleaned[index] ?? "x".repeat(160),
        });
      expect(plugin?.name).toBe(packageName);
      expect(installation.name).toBe(packageName);
    }
  });
  it("keeps engine approval titles clean without changing the call ID (the wire caps length)", async ({
    storeFixture,
  }) => {
    const { database, store } = storeFixture;
    const f = await storeFixture.startRunFixture("outside-approvals");
    const titles: string[] = [];
    for (const title of boundedNames) {
      const requestId = createId("request");
      const { nextRunnerOrdinal } = await database
        .selectFrom("runs")
        .select("nextRunnerOrdinal")
        .where("id", "=", f.run.id)
        .executeTakeFirstOrThrow();
      const request = liveRequest({
        harnessInstanceId: f.harnessInstance.id,
        id: requestId,
        presentation: {
          kind: "choice",
          options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
          title,
        },
        requestedBy: f.userId,
        runId: f.run.id,
        threadId: f.threadId,
      });
      await store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerBootId: f.runnerBootId,
        runnerId: f.runnerId,
        event: pendingEvent({
          bindingGeneration: f.bindingGeneration,
          data: {
            request: {
              ...request,
              kind: "harness.approval",
              payload: { kind: "harness.approval" },
            },
          },
          environmentId: f.environmentId,
          ordinal: nextRunnerOrdinal,
          runId: f.run.id,
          threadId: f.threadId,
          type: "request.opened",
        }),
      });
      const row = await database
        .selectFrom("requests")
        .selectAll()
        .where("id", "=", requestId)
        .executeTakeFirstOrThrow();
      const served = requestFromRow(row);
      expect(served.callId).toBe(requestId);
      titles.push(served.presentation.title);
    }
    expect(titles).toEqual(cleaned);
  });

  it("keeps MCP tool titles clean without changing machine names", async ({ storeFixture }) => {
    const { database } = storeFixture;
    const { userId, runnerId } = await storeFixture.createRunFixture("outside-tool-titles");
    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    for (const [index, title] of forged.entries()) {
      const name = "test\u200DTool";
      await platform.install({
        actorUserId: userId,
        installation: {
          description: "",
          id: installationId,
          manifest: {},
          name: "outside-tool-titles",
          provenance: {},
          sourceKind: "plugin",
          status: "active",
          title: "Outside tools",
          trust: "administrator-approved",
          version: null,
        },
        requestId: `outside-tool-${index}`,
        servers: [
          {
            catalog: {
              definitions: {},
              tools: [
                {
                  annotations: { title },
                  connectionId: null,
                  description: "",
                  id: createIntegrationId("tool"),
                  inputSchema: { type: "object" },
                  name,
                  outputSchema: null,
                  status: "active",
                  title,
                },
              ],
            },
            connectionRequirement: { kind: "none" },
            id: serverId,
            name: "outside-server",
            status: "active",
            statusDetail: null,
            transport: {
              launch: { args: [], command: "node", cwd: "/tmp", env: {}, type: "stdio" },
              runnerId,
              type: "runner",
            },
          },
        ],
      });
      const cleanTitle = cleaned[index] ?? "x".repeat(160);
      const [tool] = await platform.listTools(installationId);
      expect(tool).toMatchObject({ name, title: cleanTitle, annotations: { title: cleanTitle } });
    }
  });
});
