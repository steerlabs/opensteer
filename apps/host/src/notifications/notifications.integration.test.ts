import { parseCaptureJsonl } from "@opensteer/shared/test-support/captureJsonl";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createId,
  ModelSelectionSchema,
  NotificationViewSchema,
  TriggerIdSchema,
  zeroSequence,
  type MessageId,
  type NotificationView,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import {
  HostNotificationPublicationSchema,
  type HostNotificationPublication,
} from "@opensteer/control-plane-protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { HostToClientMessageSchema } from "@opensteer/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  startVerticalStack,
  waitForRealtimeMessage,
  type VerticalStack,
} from "../agents/vertical-stack.test-support.js";

/*
 * "When Opensteer messages you, you get notified." Each journey drives the
 * real Host and Runner, with the Codex driver against a fake app server whose
 * turn input says what its agent does, and watches what reaches the person:
 * the `host.notification` frames on a signed-in socket and the identifiers
 * posted to the Account after a committed event.
 *
 * The artifact records, for every journey, the notifications that arrived and
 * the Account requests the Host made, so a run can be compared with the next.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
interface Journey {
  readonly producerEventId?: string;
  readonly producerOccurrenceId?: string;
  readonly name: string;
  readonly notifications: readonly NotificationView[];
  readonly publications: readonly HostNotificationPublication[];
}
integration("Notifications", () => {
  let stack: VerticalStack;
  let capturePath: string;
  let socket: WebSocket;
  let rootTask: ThreadId;
  const received: NotificationView[] = [];
  const journeys: Journey[] = [];
  const publications: HostNotificationPublication[] = [];
  const clock = new ManualClock();
  let graceFinished = Promise.withResolvers<void>();
  let authorityAvailable = true;
  let interruptAcknowledgementFor: RunId | undefined;
  beforeAll(async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-notifications-"));
    capturePath = join(scratch, "codex.jsonl");
    stack = await startVerticalStack({
      notificationTiming: {
        now: () => new Date(clock.now()),
        wait: async (milliseconds, signal) => {
          await clock.wait(milliseconds, signal);
          if (milliseconds === 5_000) graceFinished.resolve();
        },
      },
      account: {
        controlApiOrigin: new URL("https://accounts.notifications.invalid"),
        hostCredential: `osc_${"a".repeat(43)}`,
        issuer: new URL("https://accounts.notifications.invalid"),
        oidcClientId: "notifications",
        oidcClientSecret: `ocs_${"b".repeat(43)}`,
        provisioningMode: "adoption",
        reachability: "canonical",
      },
      accountDirectoryFetch: async (url, init) => {
        const path = new URL(url.toString()).pathname;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (path === "/v1/host/notifications") {
          const publication = HostNotificationPublicationSchema.parse(body);
          publications.push(publication);
          if (publication.runId === interruptAcknowledgementFor) {
            interruptAcknowledgementFor = undefined;
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(
                    new TypeError("Account connection terminated while reading acknowledgement"),
                  );
                },
              }),
              {
                status: 202,
              },
            );
          }
          return Response.json(
            {
              accepted: true,
              deliveries: 1,
              notificationId: publication.notificationId,
            },
            {
              status: 202,
            },
          );
        }
        if (path === "/v1/host/authority") {
          if (!authorityAvailable)
            return new Response("", {
              status: 503,
            });
          const envelope = body.authorityEnvelope as {
            readonly document: {
              readonly deploymentId: string;
            };
          };
          return Response.json({
            published: true,
            deploymentId: envelope.document.deploymentId,
          });
        }
        if (path.startsWith("/v1/host/directory/"))
          return Response.json({
            generation: body.generation,
            present: body.present,
            accountId: decodeURIComponent(path.split("/").at(-1)!),
          });
        throw new Error(`Unexpected Account path ${path}`);
      },
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
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
              arguments: [
                fakeCodexAppServer,
                "--scenario=notifications",
                `--capture=${capturePath}`,
                "--unique-threads",
              ],
              executable: process.execPath,
            },
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 60_000,
    });
    const ownerId = (
      await stack.host.store.database
        .selectFrom("personalSettings")
        .select("ownerId")
        .executeTakeFirstOrThrow()
    ).ownerId;
    const provider = await stack.host.store.database
      .selectFrom("accountDirectoryProvider")
      .select("providerId")
      .executeTakeFirstOrThrow();
    await stack.host.store.database
      .insertInto("authAccounts")
      .values({
        id: createId("authAccount"),
        userId: ownerId,
        accountId: `acct_${randomUUID()}`,
        providerId: provider.providerId,
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
    socket = await openSocket(stack);
    socket.on("message", (data) => {
      const message = HostToClientMessageSchema.parse(JSON.parse(String(data)));
      if (message.type === "host.notification") {
        received.push(NotificationViewSchema.parse(message.notification));
      }
    });
    rootTask = await stack.createThread({
      modelSelection,
      title: "The task",
    });
    const synchronized = waitForRealtimeMessage(
      socket,
      (message) => message.type === "host.synchronized",
    );
    socket.send(
      JSON.stringify({
        type: "client.subscribe",
        threadId: rootTask,
        apiVersion: hostApiVersion,
        afterSequence: zeroSequence,
      }),
    );
    await synchronized;
  }, 120_000);
  afterAll(async () => {
    socket?.terminate();
    await stack?.close();
    const directory = await mkdtemp(join(tmpdir(), "opensteer-notifications-artifact-"));
    const artifact = join(directory, "notifications.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Notifications artifact: ${artifact}`);
  }, 60_000);
  async function settle(): Promise<void> {
    clock.advanceBy(2_500);
    await clock.runUntilSettled(stack.host.notifications.drain());
    await new Promise<void>((resolve, reject) => {
      socket.once("pong", () => resolve());
      socket.ping("notification-drain", undefined, (error?: Error) => {
        if (error) reject(error);
      });
    });
  }
  async function record(
    name: string,
    since: number,
    producerEventId?: string,
    producerOccurrenceId?: string,
  ): Promise<void> {
    await clock.runUntilSettled(stack.host.notifications.drain());
    journeys.push({
      name,
      notifications: received.slice(since),
      publications: [...publications],
      ...(producerEventId
        ? {
            producerEventId,
          }
        : {}),
      ...(producerOccurrenceId
        ? {
            producerOccurrenceId,
          }
        : {}),
    });
  }
  it("H1/H10 committed The task reply reaches live clients and the Account once", async () => {
    const since = received.length;
    const turn = await stack.sendMessage({
      text: "How did it go? [[reply **Done** — see [the report](https://example.com/report) and `notes.md`.]]",
      threadId: rootTask,
    });
    const reply = await replyOf(stack, turn.runId);
    const alert = await waitForNotification(
      received,
      since,
      (n) => n.messageId === reply,
      "The task reply",
    );
    expect(alert).toMatchObject({
      body: "Done — see the report and notes.md.",
      kind: "reply-published",
      runId: turn.runId,
      threadId: rootTask,
      title: "Opensteer",
    });
    await settle();
    // One alert, for the reply — never for the person's own message.
    expect(received.slice(since)).toEqual([alert]);
    const publication = await waitFor(
      async () => publications.find((entry) => entry.notificationId === alert.id),
      "reply publication",
      15_000,
    );
    expect(publications.filter((entry) => entry.notificationId === alert.id)).toEqual([
      publication,
    ]);
    expect(Date.parse(publication.expiresAt) - Date.parse(publication.occurredAt)).toBe(
      15 * 60_000,
    );
    expect(publication).toMatchObject({
      schemaVersion: 1,
      messageId: reply,
      threadId: rootTask,
    });
    const committed = await stack.host.store.database
      .selectFrom("deploymentEvents")
      .select("eventId")
      .where("eventId", "=", publication.eventId)
      .executeTakeFirstOrThrow();
    expect(committed.eventId).toBe(publication.eventId);
    await record("rootTask reply", since);
  }, 120_000);
  it("never alerts for a note; the reply that later reads it does", async () => {
    const since = received.length;
    const trigger = await createTrigger(stack, {
      anchorThreadId: rootTask,
      name: "Inbox note",
      program: programSending("report", rootTask, "Three new emails, none urgent."),
      source: {
        kind: "webhook",
      },
    });
    const published = waitForRealtimeMessage(
      socket,
      (message) =>
        message.type === "host.events" &&
        message.events.some(
          (event) =>
            (event.type === "message.created" || event.type === "message.placed") &&
            event.threadId === rootTask &&
            event.data.message.content.some(
              (part) => part.type === "text" && part.text === "Three new emails, none urgent.",
            ),
        ),
    );
    const [, observed] = await Promise.all([runTrigger(stack, trigger), published]);
    const note = await waitForMessage(stack, rootTask, "Three new emails, none urgent.");
    const producer =
      observed.type === "host.events"
        ? observed.events.find(
            (event) =>
              (event.type === "message.created" || event.type === "message.placed") &&
              event.data.message.id === note,
          )
        : undefined;
    expect(producer).toBeDefined();
    // A realtime gap fill can expose a committed row before its publisher runs.
    // Program success proves its awaited message command has returned after publication.
    const completed = await waitFor(
      async () => {
        const detail = await stack.api["triggers.get"]({
          triggerId: TriggerIdSchema.parse(trigger),
        });
        if (!detail.ok) throw new Error(JSON.stringify(detail));
        const occurrence = detail.data.occurrences[0];
        if (occurrence?.status === "failed" || occurrence?.status === "canceled")
          throw new Error(`The note program ${occurrence.status}`);
        return occurrence?.status === "succeeded" ? occurrence : undefined;
      },
      "the note program to finish its message command",
      20_000,
    );
    await settle();
    expect(received.slice(since)).toEqual([]);
    expect(publications.filter((entry) => entry.messageId === note)).toEqual([]);
    const turn = await stack.sendMessage({
      text: "Anything new? [[reply Nothing urgent.]]",
      threadId: rootTask,
    });
    const reply = await replyOf(stack, turn.runId);
    await waitForNotification(received, since, (n) => n.messageId === reply, "reply after a note");
    await record("note then reply", since, producer!.eventId, completed.id);
  }, 120_000);
  it("delivers a reminder: The task schedules it, it fires, and the task's reply alerts", async () => {
    const since = received.length;
    const at = new Date(Date.now() + 4_000).toISOString();
    const turn = await stack.sendMessage({
      text: [
        "Remind me in a moment to buy groceries.",
        toolCall("trigger_write", {
          action: "create",
          anchorThreadId: rootTask,
          name: "Reminder: buy groceries",
          program: {
            language: "javascript",
            source: programSending(
              "queue",
              rootTask,
              "Reminder: buy groceries " +
                toolCall("person_message", {
                  message: "Groceries milestone ready.",
                }) +
                " [[reply Reminder: buy groceries]]",
            ),
            toolContractVersion: 3,
          },
          source: {
            at,
            kind: "schedule",
          },
        }),
        "[[reply I'll remind you.]]",
      ].join("\n"),
      threadId: rootTask,
    });
    expect(await replyText(stack, turn.runId)).toBe("I'll remind you.");
    const reminder = await waitForNotification(
      received,
      since,
      (n) => n.body === "Reminder: buy groceries",
      "reminder",
      30_000,
    );
    expect(reminder).toMatchObject({
      kind: "reply-published",
      threadId: rootTask,
      title: "Opensteer",
    });
    const run = await stack.host.store.database
      .selectFrom("runs")
      .innerJoin("messages", "messages.id", "runs.seedInputId")
      .select(["runs.assignmentId", "runs.requestedBy", "messages.author"])
      .where("runs.id", "=", reminder.runId!)
      .executeTakeFirstOrThrow();
    // The Trigger woke The task; the task's own reply is what reached the person.
    expect(run.assignmentId).toBeNull();
    const milestone = await waitForNotification(
      received,
      since,
      (notification) => notification.body === "Groceries milestone ready.",
      "Trigger-seeded person message",
    );
    const milestoneMessage = await stack.host.store.database
      .selectFrom("messages")
      .select("addressedToUserId")
      .where("id", "=", milestone.messageId!)
      .executeTakeFirstOrThrow();
    expect(milestoneMessage.addressedToUserId).toBe(run.requestedBy);
    expect(run.author).toMatchObject({
      displayName: "Reminder: buy groceries",
      kind: "trigger",
    });
    // Having gone off, the reminder is finished: it leaves the Automations
    // list, and its page says it ran.
    const triggerId = (
      run.author as {
        readonly triggerId: string;
      }
    ).triggerId;
    await waitFor(
      async () => {
        const listed = await stack.api["triggers.list"]({});
        if (!listed.ok) throw new Error(JSON.stringify(listed));
        return listed.data.triggers.some(({ id }) => id === triggerId) ? undefined : true;
      },
      "the finished reminder to leave the list",
      30_000,
    );
    const finished = await stack.api["triggers.get"]({
      triggerId: TriggerIdSchema.parse(triggerId),
    });
    if (!finished.ok) throw new Error(JSON.stringify(finished));
    expect(finished.data.trigger.status).toBe("archived");
    expect(finished.data.occurrences.map(({ status }) => status)).toEqual(["succeeded"]);
    await record("reminder", since);
  }, 120_000);
  it("tells the person, through its Thread, when an automation fails on its only run", async () => {
    const since = received.length;
    await createTrigger(stack, {
      anchorThreadId: rootTask,
      name: "Calendar check",
      program: 'export default async function () { throw new Error("Calendar unavailable"); }',
      source: {
        kind: "schedule",
        schedule: {
          at: inSeconds(2),
          kind: "at",
        },
      },
    });
    const notice = await waitForMessage(
      stack,
      rootTask,
      "failed on its only scheduled run",
      30_000,
    );
    const message = await stack.host.store.database
      .selectFrom("messages")
      .select(["author", "content"])
      .where("id", "=", notice)
      .executeTakeFirstOrThrow();
    // The Host says what happened, so the notice is the platform's, not the program's.
    expect(message.author).toMatchObject({
      cause: "automation-stopped",
      kind: "platform",
    });
    expect(JSON.stringify(message.content)).toContain("Calendar unavailable");
    const answered = await waitFor(
      async () =>
        (
          await stack.host.store.database
            .selectFrom("runs")
            .select("id")
            .where("seedInputId", "=", notice)
            .where("status", "=", "completed")
            .executeTakeFirst()
        )?.id,
      "the task's answer to the notice",
      30_000,
    );
    const alert = await waitForNotification(
      received,
      since,
      (n) => n.runId === answered,
      "automation failure reply",
      30_000,
    );
    expect(alert).toMatchObject({
      kind: "reply-published",
      threadId: rootTask,
      title: "Opensteer",
    });
    await record("automation failure", since);
  }, 120_000);
  it("refuses delegated person messages and alerts only through the task's relay", async () => {
    const since = received.length;
    const trigger = await createTrigger(stack, {
      anchorThreadId: rootTask,
      name: "Morning summary",
      program: `export default async function ({ opensteer }) {
        await opensteer.callTool("delegate_task", {
          task: ${JSON.stringify(
            "Summarize the inbox. " +
              toolCall("person_message", {
                message: "Inbox milestone ready.",
              }) +
              " [[reply Inbox summary ready.]]",
          )},
          title: "Inbox summary",
        });
      }`,
      source: {
        kind: "webhook",
      },
    });
    await runTrigger(stack, trigger);
    const taskReply = await waitForReplyIn(stack, "Inbox summary", "Tool person_message failed:");
    const taskThread = await stack.host.store.database
      .selectFrom("messages")
      .select("threadId")
      .where("id", "=", taskReply)
      .executeTakeFirstOrThrow();
    expect(
      await stack.host.store.database
        .selectFrom("messages")
        .select("id")
        .where("threadId", "=", taskThread.threadId)
        .where("addressedToUserId", "is not", null)
        .execute(),
    ).toEqual([]);
    expect(received.slice(since).filter((n) => n.body === "Inbox milestone ready.")).toEqual([]);

    // The task's result arrives in The task as a continuation; the task's reply to it
    // is the one alert, and the task's own reply alerts nobody.
    const result = await waitForMessage(stack, rootTask, "Tool person_message failed:", 30_000);
    const relayRun = await waitFor(
      async () =>
        (
          await stack.host.store.database
            .selectFrom("runs")
            .select("id")
            .where("seedInputId", "=", result)
            .where("status", "=", "completed")
            .executeTakeFirst()
        )?.id,
      "the task's relay of the task result",
      30_000,
    );
    await waitForNotification(
      received,
      since,
      (n) => n.runId === relayRun,
      "The task relay",
      30_000,
    );
    await settle();
    expect(received.slice(since).filter((n) => n.runId === relayRun)).toHaveLength(1);
    expect(publications.filter((entry) => entry.messageId === taskReply)).toEqual([]);
    expect(received.slice(since).filter((entry) => entry.messageId === taskReply)).toEqual([]);
    await record("delegation", since);
  }, 120_000);
  it("alerts when Opensteer needs approval or fails, but not when the person stops it", async () => {
    const since = received.length;
    const thread = await stack.createThread({
      modelSelection,
      title: "Release checks",
    });
    const asking = await stack.queueMessage({
      text: "Run the tests. [[ask]]",
      threadId: thread,
    });
    const request = await waitForNotification(
      received,
      since,
      (n) => n.kind === "request-opened" && n.threadId === thread,
      "approval",
    );
    expect(request.requestId).not.toBeNull();
    expect(request.title).toBe("Release checks");
    await waitFor(
      async () => publications.find((entry) => entry.notificationId === request.id),
      "committed Request publication",
      10_000,
    );
    await stack.interruptRun(thread, asking.runId!);
    await waitForRunStatus(stack, asking.runId!, "interrupted");
    // A stop pauses the Thread's queue so nothing starts unasked.
    await stack.resumeThreadInputQueue(thread);
    const failing = await stack.queueMessage({
      text: "Try again. [[fail]]",
      threadId: thread,
    });
    const failure = await waitForNotification(
      received,
      since,
      (n) => n.kind === "run-failed" && n.runId === failing.runId,
      "failure",
    );
    expect(failure.body).toBe("Opensteer couldn't finish: The engine could not continue.");
    await waitFor(
      async () => publications.find((entry) => entry.notificationId === failure.id),
      "committed failure publication",
      10_000,
    );
    await settle();
    expect(received.slice(since).map((n) => n.kind)).toEqual(["request-opened", "run-failed"]);
    await record("approval, stop and failure", since);
  }, 120_000);

  it("gives the agent the person's time zone and local time", async () => {
    const updated = await stack.api["commands.dispatch"]({
      idempotencyKey: randomUUID(),
      timeZone: "America/New_York",
      type: "viewer.timeZone.update",
    });
    if (!updated.ok) throw new Error(`Time zone update failed: ${updated.error.code}`);
    const since = received.length;
    const turn = await stack.sendMessage({
      text: "What time is it for me?",
      threadId: rootTask,
    });
    await waitForNotification(received, since, (n) => n.runId === turn.runId, "time zone reply");
    const turns = await capturedTurns(capturePath);
    expect(turns.at(-1)).toContain("Person's time zone: America/New_York.");
    await record("time zone", since);
  }, 120_000);
  it("H6/H10 retries a network failure while reading the Account acknowledgement", async () => {
    const since = received.length;
    const turn = await stack.sendMessage({
      onQueued: async (runId) => {
        interruptAcknowledgementFor = runId;
      },
      text: "Retry the interrupted response [[reply Acknowledgement retry]]",
      threadId: rootTask,
    });
    const alert = await waitForNotification(
      received,
      since,
      (entry) => entry.runId === turn.runId,
      "reply before interrupted acknowledgement",
    );
    await clock.runUntilSettled(
      waitFor(
        async () =>
          publications.filter((entry) => entry.notificationId === alert.id).length === 2
            ? true
            : undefined,
        "publication retried after interrupted acknowledgement",
        15_000,
      ),
    );
    expect(publications.filter((entry) => entry.notificationId === alert.id)).toEqual([
      expect.objectContaining({
        notificationId: alert.id,
      }),
      expect.objectContaining({
        notificationId: alert.id,
      }),
    ]);
    await record("interrupted acknowledgement retry", since);
  }, 120_000);
  it("H12 closes the real Host promptly while authority readiness never resolves", async () => {
    graceFinished = Promise.withResolvers<void>();
    authorityAvailable = false;
    await stack.restartHost();
    const since = stack.notifications.length;
    const turn = await stack.sendMessage({
      text: "Waiting for authority [[reply Held for authority]]",
      threadId: rootTask,
    });
    await waitForNotification(
      stack.notifications,
      since,
      (entry) => entry.runId === turn.runId,
      "live while authority unavailable",
    );
    await clock.runUntilSettled(graceFinished.promise);
    clock.advanceBy(100);
    expect(publications.filter((entry) => entry.runId === turn.runId)).toEqual([]);
    const started = Date.now();
    await stack.host.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    journeys.push({
      name: "close before authority ready",
      notifications: stack.notifications.slice(since),
      publications: [...publications],
    });
  }, 120_000);
});
function openSocket(stack: VerticalStack): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/realtime", stack.hostOrigin);
    url.protocol = "ws:";
    const socket = new WebSocket(url, {
      headers: {
        cookie: stack.sessionCookie,
        origin: stack.hostOrigin.origin,
      },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}
function toolCall(name: string, input: unknown): string {
  return `[[call ${name} ${Buffer.from(JSON.stringify(input), "utf8").toString("base64url")}]]`;
}
function programSending(delivery: "queue" | "report", threadId: string, message: string): string {
  return `export default async function ({ opensteer }) {
    await opensteer.callTool("thread_send", ${JSON.stringify({
      delivery,
      message,
      threadId,
    })});
  }`;
}
function inSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}
async function createTrigger(
  stack: VerticalStack,
  input: {
    readonly anchorThreadId: ThreadId;
    readonly name: string;
    readonly program: string;
    readonly source:
      | {
          readonly kind: "webhook";
        }
      | {
          readonly kind: "schedule";
          readonly schedule: {
            readonly at: string;
            readonly kind: "at";
          };
        };
  },
): Promise<string> {
  const created = await stack.api["commands.dispatch"]({
    idempotencyKey: randomUUID(),
    input: {
      anchorThreadId: input.anchorThreadId,
      name: input.name,
      program: {
        language: "javascript",
        source: input.program,
        toolContractVersion: 3,
      },
      source: input.source,
    },
    type: "trigger.create",
  });
  if (!created.ok || created.data.type !== "trigger.create") {
    throw new Error(`Trigger creation failed: ${JSON.stringify(created)}`);
  }
  return created.data.trigger.id;
}
async function runTrigger(stack: VerticalStack, triggerId: string): Promise<void> {
  const run = await stack.api["commands.dispatch"]({
    idempotencyKey: randomUUID(),
    triggerId,
    type: "trigger.run",
  });
  if (!run.ok || run.data.type !== "trigger.run") {
    throw new Error(`Trigger run failed: ${JSON.stringify(run)}`);
  }
}
async function replyOf(stack: VerticalStack, runId: RunId): Promise<MessageId> {
  const event = await stack.host.store.database
    .selectFrom("deploymentEvents")
    .select("data")
    .where("runId", "=", runId)
    .where("type", "=", "run.completed")
    .executeTakeFirstOrThrow();
  const replyMessageId = (
    event.data as {
      readonly replyMessageId?: MessageId | null;
    }
  ).replyMessageId;
  if (!replyMessageId) throw new Error(`Run ${runId} completed without a reply`);
  return replyMessageId;
}
async function replyText(stack: VerticalStack, runId: RunId): Promise<string> {
  const reply = await replyOf(stack, runId);
  const message = await stack.host.store.database
    .selectFrom("messages")
    .select("content")
    .where("id", "=", reply)
    .executeTakeFirstOrThrow();
  return (
    message.content as readonly {
      readonly text?: string;
    }[]
  )
    .map((part) => part.text ?? "")
    .join("");
}
async function waitForMessage(
  stack: VerticalStack,
  threadId: ThreadId,
  fragment: string,
  timeoutMs = 20_000,
): Promise<MessageId> {
  return waitFor(
    async () =>
      (
        await stack.host.store.database
          .selectFrom("messages")
          .select("id")
          .where("threadId", "=", threadId)
          .where((expression) =>
            expression(
              expression.cast("content", "text"),
              "like",
              `%${fragment.replaceAll("%", "\\%")}%`,
            ),
          )
          .orderBy("sequence", "desc")
          .executeTakeFirst()
      )?.id,
    `message containing ${fragment}`,
    timeoutMs,
  );
}
async function waitForReplyIn(
  stack: VerticalStack,
  threadTitle: string,
  text: string,
): Promise<MessageId> {
  return waitFor(
    async () =>
      (
        await stack.host.store.database
          .selectFrom("messages")
          .innerJoin("threads", "threads.id", "messages.threadId")
          .select("messages.id")
          .where("threads.title", "=", threadTitle)
          .where("messages.kind", "=", "assistant")
          .where((expression) =>
            expression(expression.cast("messages.content", "text"), "like", `%${text}%`),
          )
          .executeTakeFirst()
      )?.id,
    `reply in ${threadTitle}`,
    30_000,
  );
}
async function waitForRunStatus(stack: VerticalStack, runId: RunId, status: string): Promise<void> {
  let observed: string | undefined;
  try {
    await waitFor(
      async () => {
        observed = (
          await stack.host.store.database
            .selectFrom("runs")
            .select("status")
            .where("id", "=", runId)
            .executeTakeFirst()
        )?.status;
        return observed === status ? observed : undefined;
      },
      `Run ${runId} ${status}`,
      20_000,
    );
  } catch (error) {
    throw new Error(`Run ${runId} stayed ${String(observed)} instead of ${status}`, {
      cause: error,
    });
  }
}

/** Waits for a matching notification among those that arrived at or after `since`. */
async function waitForNotification(
  notifications: readonly NotificationView[],
  since: number,
  matches: (notification: NotificationView) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<NotificationView> {
  return waitFor(
    async () => notifications.slice(since).find(matches),
    `notification: ${label}`,
    timeoutMs,
  );
}
async function capturedTurns(path: string): Promise<readonly string[]> {
  return parseCaptureJsonl<{
    readonly notificationsTurn?: {
      readonly text: string;
    };
  }>(await readFile(path, "utf8")).flatMap((entry) => {
    return entry.notificationsTurn ? [entry.notificationsTurn.text] : [];
  });
}
async function waitFor<Value>(
  read: () => Promise<Value | undefined>,
  label: string,
  timeoutMs: number,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
