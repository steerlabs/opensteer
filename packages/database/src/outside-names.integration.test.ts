import {
  ChannelDashboardSchema,
  channelProviderCatalog,
  createChannelId,
  type ChannelConversationId,
} from "@opensteer/channel-core";
import { createId, ThreadSchema, type RequestId } from "@opensteer/core";
import { AgentConnectionSchema } from "@opensteer/protocol";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import {
  admitAgentOperation,
  beginAgentSession,
  listAgentOperations,
} from "./agent-session-store.js";
import { AppStore } from "./app-store.js";
import { createBrowserProfile } from "./browser-session-store.js";
import { needsYouPage } from "./needs-you-store.js";
import { NotificationStore } from "./notification-store.js";
import {
  describeStore,
  testMessagingRunnerId,
  testModelSelection,
} from "./store.integration.test-support.js";

/**
 * A name from outside enters the Home clean (`outsideName`), so no answer carries one dirty: the
 * forged names the re-check used, a zero-width joiner, a tab, a 5,000-character name and a long
 * astral-plane name go in through each entrance, and every name in what the Home then answers is
 * read and parsed through its real schema.
 */
const forged = [
  "Helper\u202E\nDisconnected",
  "#ops\u202E\nOnly you can message this chat",
  "Work\u200DOps",
  "Tab\tName",
  "x".repeat(5_000),
  "😀".repeat(200),
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
  "body",
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

describeStore("a name from outside enters the Home clean", (it) => {
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
    const notifications = new NotificationStore(database);
    let notificationCount = 0;
    // A task with a question for the person, so Needs you and notifications name it.
    const asking = await storeFixture.startRunFixture("outside-asking");
    const askRequestId = createId("request") as RequestId;
    await storeFixture.openLiveRequest(asking, askRequestId);
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
      answers.push(ThreadSchema.parse(await store.getThreadForOwner(thread.id, fixture.userId)));
      // A task renamed to it, as Needs you then names that task. A title longer than a title may
      // be is refused where it arrives, never stored.
      const rename = store.renameThread({
        threadId: asking.threadId,
        requestedBy: asking.userId,
        idempotencyKey: `outside-rename-${index}`,
        title: name,
      });
      if (Array.from(name).length > 240) await expect(rename).rejects.toThrow();
      else await rename;
      answers.push(await needsYouPage(database, { userId: asking.userId }));
      const decided = await notifications.decide({
        type: "requestChanged",
        kind: "harness.approval",
        opened: true,
        status: "pending",
        requestId: askRequestId,
        runId: asking.run.id,
        threadId: asking.threadId,
      });
      notificationCount += decided.length;
      answers.push(decided.map(({ view }) => view));
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
    // Fallbacks when a display name cleans to empty must still be cleaned and bounded.
    const dirtyExternalId = `U\u202E\nFake${"x".repeat(200)}`;
    const { account: fallbackAccount, connection: fallbackConnection } =
      await channels.createConnection({
        account: {
          displayName: "\u202E",
          externalAccountId: dirtyExternalId,
          handle: "\u202E",
          routingMode: "dedicated",
        },
        connection: {
          runnerId: testMessagingRunnerId,
          connectionMethod: "bring-your-own",
          displayName: "\u202E",
          externalIdentityId: "U-fallback",
          externalTenantId: dirtyExternalId,
          provider: "slack",
          transportKind: "socket",
        },
        createdBy: fixture.userId,
        credential: {
          encryptedPayload: Buffer.from("outside-fallback"),
          encryptionKeyVersion: 1,
          id: createId("credential"),
          name: "Outside fallback",
          ownerId: fixture.userId,
          provider: "channel:slack",
        },
      });
    await channels.setRuntimeConnectionHealth({
      connectionId: fallbackConnection.id,
      detail: null,
      reason: null,
      runnerId: testMessagingRunnerId,
      status: "connected",
    });
    answers.push(
      await commitPersonalMutation(database, (tx) =>
        upsertChannelIdentity(tx, {
          accountId: fallbackAccount.id,
          displayName: "\u202E",
          externalUserId: dirtyExternalId,
        } as never),
      ),
    );
    const { ingressId: fallbackIngressId } = await channels.commitIngress(fallbackConnection.id, {
      accountExternalId: dirtyExternalId,
      actor: { displayName: "\u202E", externalUserId: dirtyExternalId },
      content: [{ type: "text", text: "fallback" }],
      conversation: {
        displayName: "\u202E",
        externalConversationId: "C-fallback",
        externalScopeId: null,
        externalThreadId: null,
        type: "channel",
      },
      eventId: "E-outside-fallback",
      occurredAt: new Date().toISOString(),
      provider: "slack",
      providerMessageId: "M-outside-fallback",
      trigger: "mention",
    });
    answers.push(
      await database
        .selectFrom("channelIngressEvents")
        .select("event")
        .where("id", "=", fallbackIngressId)
        .executeTakeFirstOrThrow(),
    );
    // An app published and renamed with a forged name cleans both the app row and its transcript card.
    const apps = new AppStore(database);
    const published = await apps.commit({
      html: { sha256: "0".repeat(64), sizeBytes: 12 },
      name: "App\u202E\nFake",
      publishKey: "outside-app-publish",
      scope: {
        environmentId: asking.environmentId,
        userId: asking.userId,
        runId: asking.run.id,
        threadId: asking.threadId,
      },
    });
    await apps.rename(asking.userId, published.appId, "Renamed\u202E\nApp");
    answers.push(
      await database
        .selectFrom("transcriptItems")
        .select("view")
        .where("appId", "=", published.appId)
        .execute(),
    );
    // 1. Connected agent's own tool results: task list page, task read, and app list.
    const toolPage = await store.agentThreadPageForOwner({
      ownerId: fixture.userId,
      scope: { kind: "personal" },
      scopeId: "personal",
      maxItems: 50,
      reader: { kind: "connection" },
    });
    expect(toolPage.threads.length).toBeGreaterThan(0);
    answers.push(toolPage.threads);
    const toolTask = await store.readTask({ kind: "connection" }, asking.threadId, asking.userId);
    expect(toolTask).not.toBeNull();
    answers.push(toolTask);
    const listedApps = await apps.list(asking.userId);
    expect(listedApps.length).toBeGreaterThan(0);
    answers.push(listedApps);

    // 2. Activity feed: direct-work session (with a forged purpose) and admitted operation.
    const sessionConn = await connections.create({
      userId: fixture.userId,
      label: "Helper\u202E\nDisconnected",
      clientName: "Helper\u202E\nDisconnected",
      accessMode: "approval-required",
      grant: { scope: "everything" },
      resource: "https://home.example/mcp",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await connections.activate(sessionConn.id, "h".repeat(64));
    const dirtyProfile = await createBrowserProfile(database, {
      homeRunnerId: null,
      idempotencyKey: "outside-session-profile",
      name: "Profile\u202E\nDisconnected",
      ownerId: fixture.userId,
    });
    const { session } = await beginAgentSession(database, {
      userId: fixture.userId,
      agentConnectionId: sessionConn.id,
      purpose: "Inspect\u202E\nDisconnected",
    });
    await admitAgentOperation(database, {
      userId: fixture.userId,
      agentConnectionId: sessionConn.id,
      sessionId: session.id,
      operationKey: "outside-op-1",
      tool: "browser_open",
      argumentDigest: "a".repeat(64),
      target: {
        grant: { kind: "browser-profile", profileId: dirtyProfile.id },
        name: dirtyProfile.name,
        device: null,
      },
      targetGeneration: null,
      grantRevision: sessionConn.grantRevision!,
      mode: "approval-required",
      effect: "read",
      calls: "open",
      agentReason: null,
    });
    const byConnection = await listAgentOperations(database, {
      userId: fixture.userId,
      connectionId: sessionConn.id,
      limit: 20,
    });
    const byThread = await listAgentOperations(database, {
      userId: fixture.userId,
      threadId: session.threadId,
      limit: 20,
    });
    expect(byConnection.operations.length).toBeGreaterThan(0);
    expect(byThread.operations.length).toBeGreaterThan(0);
    const sessionThread = ThreadSchema.parse(
      await store.getThreadForOwner(session.threadId, fixture.userId),
    );
    answers.push(byConnection.operations, byThread.operations, sessionThread);
    // 3. Notifications were produced and inspected above.
    expect(notificationCount).toBeGreaterThan(0);
    // A bridge message author composed from a long name must never split a surrogate pair at 160.
    const emojiBridge = await connections.createBridge({
      userId: fixture.userId,
      accountId: fallbackAccount.id,
      conversation: { id: "C-emoji-author", name: "😀".repeat(20) },
      senders: "anyone",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const bridgeConvId = createChannelId("conversation") as ChannelConversationId;
    await database
      .insertInto("bridgeConversations")
      .values({
        id: bridgeConvId,
        bridgeId: emojiBridge.id,
        accountId: fallbackAccount.id,
        externalScopeId: null,
        externalConversationId: "C-emoji-author",
        externalThreadId: null,
        conversationType: "channel",
        displayName: "Emoji chat",
        threadId: null,
      })
      .execute();
    const { thread: emojiThread } = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "outside-emoji-author-thread",
      modelSelection: testModelSelection,
      title: "Emoji author",
    });
    await database
      .updateTable("threads")
      .set({ originConnectionId: emojiBridge.id })
      .where("id", "=", emojiThread.id)
      .execute();
    const emojiInput = await store.enqueueThreadInput({
      requestedBy: fixture.userId,
      threadId: emojiThread.id,
      content: [{ type: "text", text: "hi" }],
      source: {
        kind: "connection",
        connectionId: emojiBridge.id,
        chat: {
          conversationId: bridgeConvId,
          revision: emojiBridge.grantRevision!,
          sender: { displayName: `${"a".repeat(159)}😀`, externalUserId: "U-emoji" },
        },
      },
      policy: "queue",
      idempotencyKey: "outside-emoji-author-input",
    });
    answers.push(emojiInput.message.author);
    answers.push(
      AgentConnectionSchema.array().parse(
        await connections.list(fixture.userId, { includeRevoked: true }),
      ),
    );
    answers.push(
      ChannelDashboardSchema.parse(
        await channels.dashboard(fixture.userId, channelProviderCatalog, [testMessagingRunnerId]),
      ),
    );
    const served = names(answers);
    expect(served.length).toBeGreaterThan(forged.length * 6);
    expect(served.filter((name) => dirty.test(name))).toEqual([]);
    expect(served.filter((name) => name.length > 240)).toEqual([]);
    expect(served.filter((name) => !name.isWellFormed())).toEqual([]);
    expect(served).toContain("Helper Disconnected");
    expect(served).toContain("#ops Only you can message this chat");
    expect(served).toContain("Renamed App");
  });
});
