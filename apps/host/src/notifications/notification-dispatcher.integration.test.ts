import { ManualClock } from "@opensteer/shared/test-support/clock";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelSelectionSchema,
  createId,
  notificationPushWindowMilliseconds,
  type UserId,
} from "@opensteer/core";
import {
  AccountDirectoryStore,
  NotificationStateStore,
  NotificationStore,
} from "@opensteer/database";
import { HarnessRegistry } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startVerticalStack, type VerticalStack } from "../agents/vertical-stack.test-support.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
import { NotificationPublicationClient } from "./notification-publication-client.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
const evidence: {
  readonly change: string;
  readonly stage: string;
  readonly posts: number;
  readonly skip: string;
}[] = [];
integration("notification rechecks against committed PostgreSQL facts", () => {
  let stack: VerticalStack;
  let recipientId: UserId;
  beforeAll(async () => {
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      runTimeoutMs: 60_000,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new CodexHarnessDriver({
            launch: {
              executable: process.execPath,
              arguments: [
                fileURLToPath(
                  new URL(
                    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
                    import.meta.url,
                  ),
                ),
                "--scenario=notifications",
                "--unique-threads",
              ],
            },
          }),
        );
        return registry;
      },
    });
    const database = stack.host.store.database;
    const owner = await database
      .selectFrom("personalSettings")
      .select("ownerId")
      .executeTakeFirstOrThrow();
    recipientId = owner.ownerId;
    await new AccountDirectoryStore(database).configureProvider({
      issuer: "https://accounts.invalid",
      providerId: "oidc:notifications",
    });
    await database
      .insertInto("authAccounts")
      .values({
        id: createId("authAccount"),
        userId: recipientId,
        accountId: `acct_${randomUUID()}`,
        providerId: "oidc:notifications",
        password: null,
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
    const directory = await mkdtemp(join(tmpdir(), "opensteer-notification-rechecks-"));
    const path = join(directory, "rechecks.json");
    await writeFile(path, JSON.stringify(evidence, null, 2) + "\n");
    console.info(`Notification recheck artifact: ${path}`);
  }, 60_000);
  it.each([
    ["read", "readiness"],
    ["revoke", "readiness"],
    ["answer", "readiness"],
    ["read", "retry"],
    ["revoke", "retry"],
    ["answer", "retry"],
  ] as const)(
    "H11 %s during %s suppresses the POST",
    async (change, stage) => {
      const database = stack.host.store.database;
      const threadId = await stack.createThread({
        modelSelection,
        title: `Recheck ${change} ${stage}`,
      });
      const queued =
        change === "answer"
          ? await stack.queueMessage({
              text: "Need approval [[ask]]",
              threadId,
            })
          : await stack.sendMessage({
              text: "Reply [[reply Recheck this reply]]",
              threadId,
            });
      const runId = queued.runId;
      if (!runId) throw new Error("Expected a Run");
      const { event, publicationTime, replyMessageId } = await vi.waitFor(
        async () => {
          if (change === "answer") {
            const request = await database
              .selectFrom("requests")
              .select(["id", "kind", "createdAt"])
              .where("originatingRunId", "=", runId)
              .where("status", "=", "pending")
              .limit(1)
              .executeTakeFirstOrThrow();
            return {
              event: {
                type: "requestChanged" as const,
                requestId: request.id,
                kind: request.kind,
                status: "pending" as const,
                opened: true,
                runId,
                threadId,
              },
              publicationTime: request.createdAt,
              replyMessageId: null,
            };
          }
          const run = await database
            .selectFrom("runs")
            .select("terminalReplyMessageId")
            .where("id", "=", runId)
            .where("status", "=", "completed")
            .executeTakeFirstOrThrow();
          if (!run.terminalReplyMessageId)
            throw new Error("Producer did not commit the terminal reply");
          const message = await database
            .selectFrom("messages")
            .select("createdAt")
            .where("id", "=", run.terminalReplyMessageId)
            .executeTakeFirstOrThrow();
          return {
            event: {
              type: "runFinished" as const,
              runId,
              threadId,
              outcome: "completed" as const,
              attemptId: null,
              bindingGeneration: null,
            },
            publicationTime: message.createdAt,
            replyMessageId: run.terminalReplyMessageId,
          };
        },
        { timeout: 20_000, interval: 50 },
      );
      const state = new NotificationStateStore(database);
      const clock = new ManualClock(publicationTime.getTime());
      const now = () => new Date(clock.now());
      const notifications = new NotificationStore(database, {
        now,
      });
      let authorityReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        authorityReady = resolve;
      });
      let sawLive!: () => void;
      const live = new Promise<void>((resolve) => {
        sawLive = resolve;
      });
      let sawSkip!: () => void;
      const skipped = new Promise<void>((resolve) => {
        sawSkip = resolve;
      });
      let posts = 0;
      let skip = "";
      const errors: unknown[] = [];
      const mutate = async () => {
        if (change === "read") {
          if (!replyMessageId) throw new Error("Expected a reply");
          await state.visit({
            threadId,
            visitedAt: publicationTime.toISOString(),
            userId: recipientId,
          });
        }
        if (change === "revoke")
          await database
            .updateTable("users")
            .set({ disabledAt: new Date() })
            .where("id", "=", recipientId)
            .execute();
        if (change === "answer") await stack.host.store.requests.cancelForRun(runId, "run-ended");
      };
      const graceFinished = Promise.withResolvers<void>();
      const dispatcher = new NotificationDispatcher({
        now,
        wait: async (milliseconds, signal) => {
          await clock.wait(milliseconds, signal);
          if (milliseconds === 5_000) graceFinished.resolve();
        },
        client: new NotificationPublicationClient({
          deploymentId: stack.host.deployment.id,
          hostInstanceId: stack.host.deployment.activeHostInstanceId,
          target: async () => ({
            controlApiOrigin: new URL("https://accounts.invalid"),
            hostCredential: `osc_${"a".repeat(43)}`,
          }),
          fetch: async () => {
            posts++;
            await mutate();
            return new Response("", {
              status: 503,
            });
          },
        }),
        ready,
        onLive: () => sawLive(),
        onError: (error) => errors.push(error),
        onWarning: (error) => errors.push(error),
        store: {
          decide: (event) => notifications.decide(event),
          accountSubjects: (userId) => notifications.accountSubjects(userId),
          publicationSkipReason: async (entry) => {
            const reason = await notifications.publicationSkipReason(entry);
            if (reason) {
              skip = reason;
              sawSkip();
            }
            return reason;
          },
          beginPublication: (entry) => notifications.beginPublication(entry),
          continuePublication: (id, entry) => notifications.continuePublication(id, entry),
          settlePublication: (id, state) => notifications.settlePublication(id, state),
        },
      });
      try {
        dispatcher.dispatch(event);
        await live;
        if (stage === "readiness") {
          if (change !== "answer") {
            await clock.runUntilSettled(graceFinished.promise);
            clock.advanceBy(50);
          }
          expect(posts).toBe(0);
          await mutate();
        }
        authorityReady();
        await clock.runUntilSettled(skipped);
        await dispatcher.drain();
      } finally {
        await dispatcher.close();
        if (change === "revoke")
          await database
            .updateTable("users")
            .set({ disabledAt: null })
            .where("id", "=", recipientId)
            .execute();
        if (change === "answer") await stack.interruptRun(threadId, runId);
      }
      expect(posts).toBe(stage === "retry" ? 1 : 0);
      expect(errors).toEqual([]);
      expect(skip).toBe(
        {
          read: "Reply was read before publication",
          revoke: "Recipient can no longer open this Thread",
          answer: "Request was answered before the notification was published",
        }[change],
      );
      evidence.push({
        change,
        stage,
        posts,
        skip,
      });
    },
    60_000,
  );
  it("shares the notification expiry boundary between the store and dispatcher", async () => {
    const threadId = await stack.createThread({
      modelSelection,
      title: "Shared notification expiry",
    });
    const turn = await stack.sendMessage({
      text: "Expiry boundary [[reply Expire this reply]]",
      threadId,
    });
    if (!turn.runId) throw new Error("Expected a Run");
    const run = await stack.host.store.database
      .selectFrom("runs")
      .select("terminalReplyMessageId")
      .where("id", "=", turn.runId)
      .where("status", "=", "completed")
      .executeTakeFirstOrThrow();
    if (!run.terminalReplyMessageId) throw new Error("Expected a completed reply");
    const event = {
      type: "runFinished" as const,
      runId: turn.runId,
      threadId,
      outcome: "completed" as const,
      attemptId: null,
      bindingGeneration: null,
    };
    const message = await stack.host.store.database
      .selectFrom("messages")
      .select("createdAt")
      .where("id", "=", run.terminalReplyMessageId)
      .executeTakeFirstOrThrow();
    const clock = new ManualClock(message.createdAt.getTime());
    const now = () => new Date(clock.now());
    const store = new NotificationStore(stack.host.store.database, {
      now,
    });
    const live: string[] = [];
    const errors: unknown[] = [];
    const dispatcher = new NotificationDispatcher({
      now,
      ready: Promise.resolve(),
      store,
      onLive: ({ view }) => live.push(view.id),
      onError: (error) => errors.push(error),
      onWarning: (error) => errors.push(error),
    });
    try {
      clock.advanceBy(notificationPushWindowMilliseconds - 1);
      const decisions = await store.decide(event);
      expect(decisions.length).toBeGreaterThan(0);
      const decision = decisions[0]!;
      const entry = {
        ...decision.view,
        userId: decision.userId,
        eventId: createId("event"),
        sequence: decision.sequence,
        connectionId: decision.connectionId,
        occurredAt: new Date(decision.view.occurredAt),
        expiresAt: new Date(
          Date.parse(decision.view.occurredAt) + notificationPushWindowMilliseconds,
        ),
      };
      await expect(store.publicationSkipReason(entry)).resolves.toBeNull();
      dispatcher.dispatch(event);
      await dispatcher.drain();
      expect(live).toEqual(decisions.map(({ view }) => view.id));
      clock.advanceBy(1);
      await expect(store.decide(event)).resolves.toEqual([]);
      await expect(store.publicationSkipReason(entry)).resolves.toBe(
        "Notification expired before it could be published",
      );
      dispatcher.dispatch(event);
      await dispatcher.drain();
      expect(live).toEqual(decisions.map(({ view }) => view.id));
      expect(errors).toEqual([]);
      evidence.push({
        change: "expiry",
        stage: "exact push-window boundary",
        posts: 0,
        skip: "Notification expired before it could be published",
      });
    } finally {
      await dispatcher.close();
    }
  }, 60_000);
});
