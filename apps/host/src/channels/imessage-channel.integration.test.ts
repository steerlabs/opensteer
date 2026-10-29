/**
 * iMessage through a Mac, end to end on real parts: one real Host over its
 * real sockets, a Mac Runner's real `integrations` and `messaging` modules as
 * the Runner prepares them — the helper-app providers, the iMessage adapter,
 * the file cursor store and the `ComputerUseHandler` under both — and a Run
 * played by an agents Runner. Only the desktop's end of the bridge is a fake,
 * answering as the signed helper would over a Messages history kept in memory;
 * the desktop and Swift suites prove the hops from the bridge inward.
 *
 * Ways this can fail, each asserted below:
 *  1. The Host refuses a Mac advertising `messaging`, or `machines.list` does
 *     not show the Mac with messaging and Messages, so setup cannot offer it.
 *  2. A channel is created without Messages allowed to read and send on that
 *     Mac, or by somebody who does not own the Mac.
 *  3. The channel is not pinned to the Mac, holds a credential, has no source,
 *     or forgets where setup said to start before it first connects.
 *  4. Texts already in Messages before setup are answered.
 *  5. The owner, texting from a handle written differently from how they typed
 *     it at setup, is treated as a stranger.
 *  6. The owner's text does not start a Run, or the Run's reply does not go
 *     back through the Mac to them, keyed by its delivery.
 *  7. A stranger is answered at all — even with a notice — instead of waiting
 *     silently for the owner's approval; once approved, they are not answered.
 *  8. A Runner restart starts over from setup, or skips a text.
 *  9. A Mac that loses its Messages permission hides it, needs setting up
 *     again once it is back, or loses the texts that came meanwhile.
 * 10. Narrowing Messages to reading only still sends a reply that was on its
 *     way, or still runs texts; widening it again does not restore it.
 * 11. Removing Messages from the Mac leaves the channel alive, or leaves the
 *     Mac polling for it.
 *
 * Writes `result.json` to `OPENSTEER_IMESSAGE_E2E_ARTIFACT_DIR`, or a
 * temporary directory, whether it passes or not.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createId, type MessageId } from "@opensteer/core";
import type { ComputerUseBridgeRequest, IMessagePosition, IMessageRow } from "@opensteer/protocol";
import { createComputerAppApproval } from "@opensteer/runner-auth";
import { prepareIntegrationsModule, prepareMessagingModule } from "@opensteer/runner";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  attachMessaging,
  connectComputerAppMachine,
  requestComputerAppSetup,
  setComputerApp,
  startFakeDesktop,
  type FakeDesktopAnswer,
} from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  enrollmentToken,
  resetMachineAccessDatabase,
  signUpUser,
  startMachineAccessHost,
  waitForCondition,
  waitForExecute,
  type CallerMachine,
} from "../runtime/machine-access.test-support.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";

const ownerPhone = "+15551234567";
const ownerEmail = "owner@example.com";
const strangerPhone = "+15559876543";

integration("iMessage channel", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  beforeEach(async () => resetMachineAccessDatabase(databaseUrl));

  let closeCurrent: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeCurrent?.();
    closeCurrent = undefined;
  }, 60_000);

  it("answers the owner through their Mac's Messages and nobody else", async () => {
    const artifactDirectory =
      process.env.OPENSTEER_IMESSAGE_E2E_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-imessage-e2e-")));
    const steps: { readonly observed: unknown; readonly step: string }[] = [];
    const record = (step: string, observed: unknown) => steps.push({ observed, step });
    const messages = fakeMessages();
    let failure: unknown = null;
    let channelState: (() => Promise<unknown>) | undefined;
    try {
      const host = await startMachineAccessHost(databaseUrl, { signupPolicy: "open" });
      // What the Host held for the channel, written beside a failure.
      channelState = async () => ({
        connections: await host.store.database
          .selectFrom("integrationConnections")
          .select(["connectionKind", "id", "status", "statusDetail", "transportKind"])
          .execute(),
        deliveries: await host.store.database
          .selectFrom("channelDeliveries")
          .select(["attempts", "id", "kind", "lastError", "status"])
          .orderBy("createdAt", "asc")
          .execute(),
        ingress: await host.store.database
          .selectFrom("channelIngressEvents")
          .select(["lastError", "providerEventId", "status"])
          .orderBy("createdAt", "asc")
          .execute(),
      });
      const closers: (() => Promise<void>)[] = [() => host.close()];
      closeCurrent = async () => {
        for (const close of closers) await close().catch(() => undefined);
      };
      const caller = await connectCallerMachine(host, {
        name: "Caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "imessage-caller",
          name: "Caller",
        }),
      });
      closers.unshift(() => caller.close());
      const desktop = await startFakeDesktop((request) => messages.answer(request));
      closers.unshift(() => desktop.close());
      const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-imessage-runner-"));
      const integrations = prepareIntegrationsModule({
        computerUseBridge: { token: desktop.token, url: desktop.url },
        dataDirectory,
        platform: "darwin",
      });
      const computerUse = integrations?.computerUse;
      if (!integrations || !computerUse) throw new Error("A Mac with its desktop has computer use");
      closers.push(async () => computerUse.close());
      const prepare = () => {
        const prepared = prepareMessagingModule({
          computerUse,
          dataDirectory,
          platform: "darwin",
        });
        if (!prepared) throw new Error("A Mac carries the messaging module");
        return prepared;
      };
      let messaging = prepare();

      // 1. The Mac joins with both modules, and the Host shows it as able.
      const computer = await connectComputerAppMachine(host, integrations.providers, {
        allowedModules: ["integrations", "messaging"],
        messaging: messaging.descriptor,
        statusIntervalMs: 200,
      });
      closers.unshift(() => computer.close());
      let stream = await attachMessaging(host.hostPort, computer.primary, messaging.module);
      closers.unshift(async () => {
        await stream.close();
        await messaging.module.close();
      });
      await waitForCondition(async () => {
        const { machines } = await testRpcData(
          host.origin,
          "machines.list",
          {},
          { headers: host.ownerHeaders },
        );
        const mac = machines.find(({ id }) => id === computer.runnerId);
        return (
          mac?.modules.messaging !== undefined &&
          (mac.apps ?? []).some(({ definitionId }) => definitionId === "apple-messages")
        );
      });
      record("machine offers messaging and Messages", { runnerId: computer.runnerId });

      const workspace = await testRpcData(
        host.origin,
        "commands.dispatch",
        { idempotencyKey: "imessage-workspace", name: "Texts", type: "workspace.create" },
        { headers: host.ownerHeaders },
      );
      if (workspace.type !== "workspace.create") throw new Error("Workspace command mismatch");
      const workspaceId = workspace.workspace.id;
      const create = (headers: Record<string, string>, key: string) =>
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: key,
            ownerHandles: ["+1 (555) 123-4567", "Owner@Example.com"],
            provider: "imessage",
            runnerId: computer.runnerId,
            type: "channel.connection.computer.create",
            workspaceId,
          },
          { headers },
        );

      // 2. Not without Messages at read and write, and never on another's Mac.
      await expect(create(host.ownerHeaders, "imessage-no-app")).rejects.toThrow(
        /HTTP 403.*needs its app on that computer turned on, allowed to read and send/u,
      );
      const readSetup = await requestComputerAppSetup(
        host,
        computer.runnerId,
        "read",
        "imessage-read",
      );
      await setComputerApp(
        host,
        computer,
        readSetup,
        createComputerAppApproval(computer.approvalKey.privateKey, readSetup),
      );
      await expect(create(host.ownerHeaders, "imessage-read-only")).rejects.toThrow(/HTTP 403/u);
      const writeSetup = await requestComputerAppSetup(
        host,
        computer.runnerId,
        "read-write",
        "imessage-write",
      );
      const source = await setComputerApp(
        host,
        computer,
        writeSetup,
        createComputerAppApproval(computer.approvalKey.privateKey, writeSetup),
      );
      const other = await signUpUser(host, {
        email: "someone-else@example.com",
        password: "correct horse battery staple",
      });
      await expect(create(other.headers, "imessage-other-owner")).rejects.toThrow(/HTTP 403/u);
      record("refused without read-write and for another person", { source: source.connection });

      // 3. Created pinned to the Mac, with no secret, from where Messages is now.
      const created = await create(host.ownerHeaders, "imessage-create");
      if (created.type !== "channel.connection.computer.create") throw new Error("Mismatch");
      const connectionId = created.connection.id;
      const accountId = created.account.id;
      const row = await host.store.database
        .selectFrom("integrationConnections")
        .select(["credentialId", "runnerId", "sourceConnectionId", "transportKind"])
        .where("id", "=", connectionId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        credentialId: null,
        runnerId: computer.runnerId,
        sourceConnectionId: source.connection.id,
        transportKind: "computer",
      });
      expect(created.account).toMatchObject({
        externalAccountId: messages.account.id,
        handle: messages.account.handle,
      });
      expect(created.account.metadata).toEqual({ initialCursor: "40:G40" });
      const linked = await host.store.database
        .selectFrom("channelIdentities")
        .select(["externalUserId", "linkedUserId"])
        .where("accountId", "=", accountId)
        .orderBy("externalUserId", "asc")
        .execute();
      expect(linked).toEqual([
        { externalUserId: ownerPhone, linkedUserId: host.ownerId },
        { externalUserId: ownerEmail, linkedUserId: host.ownerId },
      ]);
      await waitForCondition(async () => (await channelStatus()) === "connected");
      const connectedAccount = await host.store.database
        .selectFrom("channelAccounts")
        .select("metadata")
        .where("id", "=", accountId)
        .executeTakeFirstOrThrow();
      expect(connectedAccount.metadata).toEqual({});
      record("created", { account: created.account, connection: row });

      // 4. The text already there when setup looked is never read.
      expect(messages.polls[0]?.after).toEqual({ guid: "G40", rowId: 40 });
      expect(await ingressCount()).toBe(0);

      // 5 and 6. The owner, however their handle is written, gets their reply.
      const phoneReply = await converse(caller, messages, {
        from: ownerPhone,
        reply: "Three meetings, the first at nine.",
        text: "What's on my calendar today?",
      });
      expect(phoneReply.send).toMatchObject({
        accountId: messages.account.id,
        owner: accountId,
        text: "Three meetings, the first at nine.",
        to: ownerPhone,
      });
      await expectSentDelivery(phoneReply.send.key);
      const emailReply = await converse(caller, messages, {
        from: "OWNER@example.com",
        reply: "Done.",
        text: "Remind me to call Sam",
      });
      expect(emailReply.send).toMatchObject({ text: "Done.", to: ownerEmail });
      await expectSentDelivery(emailReply.send.key);
      record("owner answered", { email: emailReply.send, phone: phoneReply.send });

      // A long code answer must survive the real delivery queue, adapter,
      // bridge schema and per-part receipts without losing code or exceeding
      // the Mac's 4,000-character send boundary.
      const longBody = "x".repeat(8_000);
      const longExecution = waitForExecute(caller.primary.socket);
      messages.receive(ownerPhone, "Show me the long example");
      const longRun = await startRun(caller, await longExecution);
      const beforeLong = messages.sends.length;
      await longRun.reply(`\`\`\`ts\n${longBody}\n\`\`\``);
      await waitForCondition(
        async () =>
          messages.sends
            .slice(beforeLong)
            .map(({ text }) => text.replace(/^```ts\n/u, "").replace(/\n```$/u, ""))
            .join("") === longBody,
      );
      const longSends = messages.sends.slice(beforeLong);
      expect(longSends.length).toBeGreaterThan(1);
      expect(longSends.every(({ text }) => text.length <= 4_000)).toBe(true);
      for (const send of longSends) await expectSentDelivery(send.key);
      record("long code reply delivered intact", {
        characters: longBody.length,
        parts: longSends.map(({ key, text }) => ({ key, characters: text.length })),
      });

      const uncertainExecution = waitForExecute(caller.primary.socket);
      messages.receive(ownerPhone, "Send the unconfirmed example");
      const uncertainRun = await startRun(caller, await uncertainExecution);
      const beforeUncertain = messages.sends.length;
      messages.loseNextConfirmation();
      const uncertainReply = await uncertainRun.reply("This reply may have arrived.");
      await waitForCondition(async () => (await deliveryStatus(uncertainReply)) === "dead");
      const stopped = await host.store.database
        .selectFrom("channelDeliveries")
        .select(["lastError", "status", "attempts"])
        .where("messageId", "=", uncertainReply)
        .executeTakeFirstOrThrow();
      expect(stopped).toMatchObject({
        status: "dead",
        attempts: 1,
        lastError: expect.stringContaining("Check Messages"),
      });
      expect(messages.sends.slice(beforeUncertain)).toHaveLength(1);
      record("unconfirmed reply stopped for attention without a repeat", stopped);

      const lostExecution = waitForExecute(caller.primary.socket);
      messages.receive(ownerPhone, "Recover the lost bridge answer");
      const lostRun = await startRun(caller, await lostExecution);
      const beforeLost = messages.sends.length;
      messages.loseNextBridgeAnswer();
      const recoveredReply = await lostRun.reply("Sent once, receipt recovered.");
      await waitForCondition(async () => (await deliveryStatus(recoveredReply)) === "sent");
      const recovered = await host.store.database
        .selectFrom("channelDeliveries")
        .select(["attempts", "status"])
        .where("messageId", "=", recoveredReply)
        .executeTakeFirstOrThrow();
      expect(recovered).toEqual({ attempts: 2, status: "sent" });
      expect(messages.sends.slice(beforeLost)).toHaveLength(1);
      record("lost bridge answer reconciled without a repeated send", recovered);

      // 7. A stranger waits in silence for the owner, then is answered.
      const deliveriesBeforeStranger = await deliveryCount();
      const strangerRow = messages.receive(strangerPhone, "hey, who is this?");
      await waitForCondition(async () => (await ingressStatus(strangerRow.guid)) === "ignored");
      const grant = await host.store.database
        .selectFrom("channelAccessGrants")
        .select(["bindingId", "externalUserId", "revision", "status"])
        .where("accountId", "=", accountId)
        .executeTakeFirstOrThrow();
      expect(grant).toMatchObject({ externalUserId: strangerPhone, status: "pending" });
      // Whatever the Host would say is written with the ignore, so none now is none ever.
      expect(await deliveryCount()).toBe(deliveriesBeforeStranger);
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          bindingId: grant.bindingId,
          decision: "approved",
          expectedRevision: grant.revision,
          externalUserId: strangerPhone,
          idempotencyKey: "imessage-approve-stranger",
          type: "channel.access.review",
        },
        { headers: host.ownerHeaders },
      );
      // Approved, they are spoken to: first told so, then answered.
      await waitForCondition(async () => messages.sends.some(({ to }) => to === strangerPhone));
      expect(messages.sends.filter(({ to }) => to === strangerPhone)).toMatchObject([
        { text: "Your access was approved. Send your message again to start work." },
      ]);
      const strangerReply = await converse(caller, messages, {
        from: strangerPhone,
        reply: "I'm the owner's assistant.",
        text: "hey again",
      });
      expect(strangerReply.send).toMatchObject({ to: strangerPhone });
      expect(messages.sends.filter(({ to }) => to === strangerPhone)).toHaveLength(2);
      record("stranger silent until approved", { grant, reply: strangerReply.send });

      // 8. A restart continues from the last text the Host recorded.
      const handled = messages.rows.at(-1);
      if (!handled) throw new Error("Messages has rows");
      await stream.close();
      await messaging.module.close();
      const cursors = JSON.parse(
        await readFile(join(dataDirectory, "messaging", "imessage-cursors.json"), "utf8"),
      ) as Record<string, string>;
      expect(cursors).toEqual({ [accountId]: `${handled.rowId}:${handled.guid}` });
      const pollsBeforeRestart = messages.polls.length;
      messaging = prepare();
      stream = await attachMessaging(host.hostPort, computer.primary, messaging.module);
      await waitForCondition(async () => messages.polls.length > pollsBeforeRestart);
      expect(messages.polls[pollsBeforeRestart]?.after).toEqual({
        guid: handled.guid,
        rowId: handled.rowId,
      });
      const afterRestart = await converse(caller, messages, {
        from: ownerPhone,
        reply: "Still here.",
        text: "Are you there?",
      });
      expect(afterRestart.send.to).toBe(ownerPhone);
      record("restart resumed", { cursor: cursors[accountId], firstPoll: handled.rowId });

      // 9. The Mac loses its permission: the owner is told, and nothing is lost.
      messages.withhold("Sending in Messages needs macOS Automation permission.");
      await waitForCondition(async () => (await channelStatus()) === "needs-attention");
      const attention = await host.store.database
        .selectFrom("integrationConnections")
        .select(["statusDetail", "statusReason"])
        .where("id", "=", connectionId)
        .executeTakeFirstOrThrow();
      expect(attention).toEqual({
        statusDetail: "Sending in Messages needs macOS Automation permission.",
        statusReason: "permissions",
      });
      const executedMeanwhile = waitForExecute(caller.primary.socket);
      const meanwhile = messages.receive(ownerPhone, "Did this one get through?");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(await ingressStatus(meanwhile.guid)).toBeUndefined();
      messages.allow();
      await waitForCondition(async () => (await channelStatus()) === "connected", 45_000);
      const meanwhileRun = await startRun(caller, await executedMeanwhile);
      await meanwhileRun.reply("Yes, it did.");
      await waitForCondition(async () =>
        messages.sends.some(({ text }) => text === "Yes, it did."),
      );
      record("permission lost and regained", attention);

      // 10. Reading only: a reply on its way is not sent, and texts are dropped.
      const executed = waitForExecute(caller.primary.socket);
      messages.receive(ownerPhone, "Draft a note to Sam");
      const run = await startRun(caller, await executed);
      await setMessagesAccess("read", "imessage-narrow");
      const withheld = await run.reply("Here is the draft.");
      await waitForCondition(async () => (await deliveryStatus(withheld)) === "dead");
      expect(messages.sends.map(({ text }) => text)).not.toContain("Here is the draft.");
      const dropped = messages.receive(ownerPhone, "Anything else?");
      await waitForCondition(async () => (await ingressStatus(dropped.guid)) === "ignored");
      const droppedRow = await host.store.database
        .selectFrom("channelIngressEvents")
        .select(["lastError", "runId"])
        .where("providerEventId", "=", dropped.guid)
        .executeTakeFirstOrThrow();
      expect(droppedRow).toEqual({
        lastError: "The computer's app connection no longer allows this channel",
        runId: null,
      });
      const widen = await requestComputerAppSetup(
        host,
        computer.runnerId,
        "read-write",
        "imessage-widen",
      );
      await setComputerApp(
        host,
        computer,
        widen,
        createComputerAppApproval(computer.approvalKey.privateKey, widen),
      );
      const restored = await converse(caller, messages, {
        from: ownerPhone,
        reply: "Back.",
        text: "And now?",
      });
      expect(restored.send.text).toBe("Back.");
      record("narrowed then widened", { dropped: dropped.guid, withheld });

      // 11. Removing Messages ends the channel, on the Host and on the Mac.
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          connectionId: source.connection.id,
          idempotencyKey: "imessage-remove-messages",
          type: "integration.disconnect",
        },
        { headers: host.ownerHeaders },
      );
      await waitForCondition(async () => (await channelStatus()) === "revoked");
      const pollsAtRemoval = messages.polls.length;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(messages.polls.length - pollsAtRemoval).toBeLessThanOrEqual(1);
      const ignoredAfterRemoval = messages.receive(ownerPhone, "Hello?");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(await ingressStatus(ignoredAfterRemoval.guid)).toBeUndefined();
      record("removed", { pollsAfterRemoval: messages.polls.length - pollsAtRemoval });

      async function channelStatus() {
        const connection = await host.store.database
          .selectFrom("integrationConnections")
          .select("status")
          .where("id", "=", connectionId)
          .executeTakeFirstOrThrow();
        return connection.status;
      }

      async function ingressCount() {
        const rows = await host.store.database
          .selectFrom("channelIngressEvents")
          .select("id")
          .where("accountId", "=", accountId)
          .execute();
        return rows.length;
      }

      async function ingressStatus(guid: string) {
        const ingress = await host.store.database
          .selectFrom("channelIngressEvents")
          .select("status")
          .where("providerEventId", "=", guid)
          .executeTakeFirst();
        return ingress?.status;
      }

      async function deliveryCount() {
        const rows = await host.store.database
          .selectFrom("channelDeliveries")
          .select("id")
          .where("accountId", "=", accountId)
          .execute();
        return rows.length;
      }

      async function deliveryStatus(messageId: MessageId) {
        const delivery = await host.store.database
          .selectFrom("channelDeliveries")
          .select("status")
          .where("messageId", "=", messageId)
          .executeTakeFirst();
        return delivery?.status;
      }

      async function expectSentDelivery(key: string) {
        // The fake Mac records the send before the Host commits its delivery receipt.
        await waitForCondition(async () => {
          const delivery = await host.store.database
            .selectFrom("channelDeliveries")
            .select("status")
            .where("id", "=", key as never)
            .executeTakeFirstOrThrow();
          return delivery.status === "sent";
        });
        const delivery = await host.store.database
          .selectFrom("channelDeliveries")
          .select(["accountId", "status"])
          .where("id", "=", key as never)
          .executeTakeFirstOrThrow();
        expect(delivery).toEqual({ accountId, status: "sent" });
      }

      async function setMessagesAccess(access: "read", key: string) {
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: key,
            input: {
              access,
              app: null,
              definitionId: "apple-messages",
              kind: "app",
              runnerId: computer.runnerId,
            },
            type: "integration.computer.setup.set",
          },
          { headers: host.ownerHeaders },
        );
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        join(artifactDirectory, "result.json"),
        `${JSON.stringify(
          {
            channel: failure === null ? undefined : await channelState?.().catch(String),
            failure: failure instanceof Error ? failure.message : failure,
            passed: failure === null,
            polls: messages.polls.length,
            sends: messages.sends,
            steps,
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 240_000);
});

/**
 * One text into Messages, the Run it starts played by the agents Runner, and
 * the reply the Mac sent back for it.
 */
async function converse(
  caller: CallerMachine,
  messages: FakeMessages,
  input: { readonly from: string; readonly reply: string; readonly text: string },
) {
  const executed = waitForExecute(caller.primary.socket);
  messages.receive(input.from, input.text);
  const run = await startRun(caller, await executed);
  await run.reply(input.reply);
  const reply = () => messages.sends.find(({ text }) => text === input.reply);
  await waitForCondition(async () => reply() !== undefined);
  const send = reply();
  if (!send) throw new Error("The reply was not sent");
  return { send };
}

/** The engine session each provider session resumes, as a real Runner keeps it. */
const sessionReferences = new Map<string, string>();

/** The agents Runner takes a Run and says it started; `reply` answers and ends it. */
async function startRun(
  caller: CallerMachine,
  command: Awaited<ReturnType<typeof waitForExecute>>,
) {
  const context = command.command.context;
  const fence = caller.primary.fence;
  const send = (frame: Record<string, unknown>) =>
    caller.primary.socket.send(JSON.stringify({ ...fence, ...frame }));
  send({
    commandId: command.command.commandId,
    correlationId: command.command.correlationId,
    type: "runner.command-accepted",
  });
  send({
    bindingGeneration: context.bindingGeneration,
    harnessInstanceId: context.harnessInstanceId,
    providerSessionId: context.providerSessionId,
    providerSessionReference: sessionReference(context.providerSessionId),
    runId: context.runId,
    threadId: context.threadId,
    type: "runner.session-bound",
  });
  let ordinal = 0;
  const emit = (type: string, data: unknown) =>
    send({
      event: {
        bindingGeneration: context.bindingGeneration,
        data,
        emittedAt: new Date().toISOString(),
        environmentId: caller.environmentId,
        ordinal: ordinal++,
        runId: context.runId,
        threadId: context.threadId,
        type,
        workspaceId: context.workspaceId,
      },
      type: "runner.event",
    });
  caller.primary.activeRunIds = [...caller.primary.activeRunIds, context.runId];
  emit("run.started", { status: "running" });
  return {
    reply: async (text: string): Promise<MessageId> => {
      const messageId = createId("message");
      emit("assistant.message", { content: [{ text, type: "text" }], messageId });
      emit("run.completed", { status: "completed" });
      caller.primary.activeRunIds = caller.primary.activeRunIds.filter(
        (runId) => runId !== context.runId,
      );
      return messageId;
    },
  };
}

function sessionReference(providerSessionId: string): string {
  const kept = sessionReferences.get(providerSessionId) ?? `codex:${randomUUID()}`;
  sessionReferences.set(providerSessionId, kept);
  return kept;
}

type FakeMessages = ReturnType<typeof fakeMessages>;

/**
 * This Mac's Messages as the helper reports it: an account signed in for the
 * bot, a history that already holds one text from before setup, one claim on
 * the account, and sends made once per key.
 */
function fakeMessages() {
  const account = { handle: "bot@example.com", id: "5D1C7A0E-0000-4000-8000-00000000B0B0" };
  const rows: IMessageRow[] = [];
  const polls: { readonly after: IMessagePosition; readonly owner: string }[] = [];
  const sends: {
    readonly accountId: string;
    readonly key: string;
    readonly owner: string;
    readonly text: string;
    readonly to: string;
  }[] = [];
  const receipts = new Map<string, { readonly key: string; readonly sentAt: string }>();
  let claim: string | null = null;
  let nextRowId = 39;
  let withheld: string | null = null;
  let loseConfirmation = false;
  let loseBridgeAnswer = false;
  const unconfirmed = new Set<string>();
  const messages = {
    account,
    loseNextConfirmation() {
      loseConfirmation = true;
    },
    loseNextBridgeAnswer() {
      loseBridgeAnswer = true;
    },
    allow() {
      withheld = null;
    },
    answer(request: ComputerUseBridgeRequest): FakeDesktopAnswer | undefined {
      if (withheld !== null && request.method.startsWith("imessage.")) {
        return { error: { code: "permission-required", message: withheld } };
      }
      if (request.method === "imessage.send") {
        const params = request.params as (typeof sends)[number];
        if (loseBridgeAnswer) {
          loseBridgeAnswer = false;
          messages.result(request);
          return {
            error: { code: "outcome-unknown", message: "The bridge lost the send answer." },
          };
        }
        if (loseConfirmation) {
          loseConfirmation = false;
          unconfirmed.add(params.key);
          sends.push(params);
        }
        if (unconfirmed.has(params.key)) {
          return {
            error: {
              code: "delivery-unconfirmed",
              message:
                "This reply may already have been sent. Check Messages on this Mac; Opensteer will not send it again.",
            },
          };
        }
      }
      const result = messages.result(request);
      return result === undefined ? undefined : { result };
    },
    result(request: ComputerUseBridgeRequest): unknown {
      switch (request.method) {
        case "imessage.account": {
          const last = rows.at(-1);
          return { account, end: last ? { guid: last.guid, rowId: last.rowId } : null };
        }
        case "imessage.poll": {
          const params = request.params as {
            readonly accountId: string;
            readonly after: IMessagePosition;
            readonly limit: number;
            readonly owner: string;
          };
          polls.push({ after: params.after, owner: params.owner });
          if (claim !== null && claim !== params.owner) {
            return { account: "current", claim: "busy", cursor: "valid", rows: [] };
          }
          claim = params.owner;
          return {
            account: params.accountId === account.id ? "current" : "changed",
            claim: "held",
            cursor: "valid",
            rows: rows.filter(({ rowId }) => rowId > params.after.rowId).slice(0, params.limit),
          };
        }
        case "imessage.send": {
          const params = request.params as (typeof sends)[number];
          const kept = receipts.get(params.key);
          if (kept) return kept;
          sends.push(params);
          const receipt = { key: params.key, sentAt: new Date().toISOString() };
          receipts.set(params.key, receipt);
          return receipt;
        }
        default:
          return undefined;
      }
    },
    polls,
    receive(handle: string, text: string) {
      nextRowId += 1;
      const row = {
        guid: `G${nextRowId}`,
        message: { handle, sentAt: new Date().toISOString(), text },
        rowId: nextRowId,
      };
      rows.push(row);
      return row;
    },
    rows,
    sends,
    /** Every iMessage call refused as the helper refuses one it has no grant for. */
    withhold(sentence: string) {
      withheld = sentence;
    },
  };
  messages.receive(ownerPhone, "An old text nobody should answer");
  return messages;
}
