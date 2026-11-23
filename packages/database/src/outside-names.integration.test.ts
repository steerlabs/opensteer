import { channelProviderCatalog } from "@opensteer/channel-core";
import { createId, type RequestId } from "@opensteer/core";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { needsYouPage } from "./needs-you-store.js";
import { testRunnerDescriptor } from "./runner-fixture.test-support.js";
import { personalReachableGrant } from "./runner-store.js";
import {
  describeStore,
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
});
