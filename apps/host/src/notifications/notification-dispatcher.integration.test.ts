import { ManualClock } from "@opensteer/shared/test-support/clock";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentEventSchema,
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
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startVerticalStack, type VerticalStack } from "../agents/vertical-stack.test-support.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
import { NotificationPublicationClient } from "./notification-publication-client.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
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
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
    });
    const database = stack.host.store.database;
    const member = await database
      .selectFrom("workspaceMemberships")
      .select("userId")
      .where("workspaceId", "=", stack.mainWorkspaceId)
      .executeTakeFirstOrThrow();
    recipientId = member.userId;
    const coOwner = await stack.host.store.createUser("Co-owner for revocation checks");
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: stack.mainWorkspaceId,
        userId: coOwner,
        role: "owner",
        state: "active",
        generation: 1,
        invitedBy: member.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        updatedAt: new Date(),
      })
      .execute();
    await new AccountDirectoryStore(database).configureProvider({
      issuer: "https://accounts.invalid",
      providerId: "oidc:notifications",
    });
    await database
      .insertInto("authAccounts")
      .values({
        id: createId("authAccount"),
        userId: member.userId,
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
    ["mute", "readiness"],
    ["revoke", "readiness"],
    ["answer", "readiness"],
    ["read", "retry"],
    ["mute", "retry"],
    ["revoke", "retry"],
    ["answer", "retry"],
  ] as const)(
    "H11 %s during %s suppresses the POST",
    async (change, stage) => {
      const database = stack.host.store.database;
      const threadId = await stack.createThread({
        modelSelection,
        title: `Recheck ${change} ${stage}`,
        workspaceId: stack.mainWorkspaceId,
      });
      const queued =
        change === "answer"
          ? await stack.queueMessage({ text: "Need approval [[ask]]", threadId })
          : await stack.sendMessage({
              text: "Reply [[reply Recheck this reply]]",
              threadId,
              workspaceId: stack.mainWorkspaceId,
            });
      const runId = queued.runId;
      if (!runId) throw new Error("Expected a Run");
      let row;
      const deadline = Date.now() + 20_000;
      while (!row) {
        row = await database
          .selectFrom("workspaceEvents")
          .selectAll()
          .where("runId", "=", runId)
          .where("type", "=", change === "answer" ? "request.opened" : "run.completed")
          .executeTakeFirst();
        if (Date.now() >= deadline)
          throw new Error("Producer did not commit its notification event");
        if (!row) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const event = AgentEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
      const member = await database
        .selectFrom("workspaceMemberships")
        .selectAll()
        .where("workspaceId", "=", stack.mainWorkspaceId)
        .where("userId", "=", recipientId)
        .executeTakeFirstOrThrow();
      const state = new NotificationStateStore(database);
      const clock = new ManualClock(Date.parse(event.createdAt));
      const now = () => new Date(clock.now());
      const notifications = new NotificationStore(database, { now });
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
          if (event.type !== "run.completed" || !event.data.replyMessageId)
            throw new Error("Expected a reply");
          const message = await database
            .selectFrom("messages")
            .select("sequence")
            .where("id", "=", event.data.replyMessageId)
            .executeTakeFirstOrThrow();
          await state.markRead({
            threadId,
            throughSequence: message.sequence,
            userId: member.userId,
          });
        }
        if (change === "mute")
          await state.setAgentNotificationMute({
            muted: true,
            userId: member.userId,
            workspaceId: stack.mainWorkspaceId,
          });
        if (change === "revoke")
          await database
            .updateTable("workspaceMemberships")
            .set({ state: "revoked", revokedBy: member.userId, revokedAt: new Date() })
            .where("id", "=", member.id)
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
            return new Response("", { status: 503 });
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
            .updateTable("workspaceMemberships")
            .set({ state: "active", revokedAt: null, revokedBy: null })
            .where("id", "=", member.id)
            .execute();
        if (change === "mute")
          await state.setAgentNotificationMute({
            muted: false,
            userId: member.userId,
            workspaceId: stack.mainWorkspaceId,
          });
        if (change === "answer") await stack.interruptRun(threadId, runId);
      }
      expect(posts).toBe(stage === "retry" ? 1 : 0);
      expect(errors).toEqual([]);
      expect(skip).toBe(
        {
          read: "Reply was read before publication",
          mute: "Workspace was muted before publication",
          revoke: "Recipient can no longer open this Thread",
          answer: "Request was answered before the notification was published",
        }[change],
      );
      evidence.push({ change, stage, posts, skip });
    },
    60_000,
  );

  it("shares the notification expiry boundary between the store and dispatcher", async () => {
    const threadId = await stack.createThread({
      modelSelection,
      title: "Shared notification expiry",
      workspaceId: stack.mainWorkspaceId,
    });
    const turn = await stack.sendMessage({
      text: "Expiry boundary [[reply Expire this reply]]",
      threadId,
      workspaceId: stack.mainWorkspaceId,
    });
    const row = await stack.host.store.database
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("runId", "=", turn.runId)
      .where("type", "=", "run.completed")
      .executeTakeFirstOrThrow();
    const event = AgentEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
    const clock = new ManualClock(Date.parse(event.createdAt));
    const now = () => new Date(clock.now());
    const store = new NotificationStore(stack.host.store.database, { now });
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
        eventId: event.eventId,
        sequence: event.sequence,
        occurredAt: new Date(event.createdAt),
        expiresAt: new Date(Date.parse(event.createdAt) + notificationPushWindowMilliseconds),
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
