import { createId, RunSchema, type Run } from "@opensteer/core";
import {
  firstTriggerFireAt,
  triggerOccurrenceErrorMessage,
  TriggerOccurrenceSchema,
  TriggerRevisionSchema,
  TriggerSchema,
  TriggerWatchActivationSchema,
  WATCH_AUTO_PAUSE_REASON,
  type Trigger,
  type TriggerOccurrence,
  type TriggerProgram,
  type TriggerRevision,
  type TriggerSource,
  type TriggerSummary,
  type TriggerWatchActivation,
} from "@opensteer/triggers";
import type { ThreadSummary } from "../host/client.js";

/** One Trigger as the preview keeps it: everything `triggers.get` answers. */
export interface MockTriggerRecord {
  readonly activation: TriggerWatchActivation | null;
  readonly downstreamRuns: readonly {
    readonly occurrenceId: string;
    readonly run: Run;
    readonly threadTitle: string;
  }[];
  readonly downstreamRunsTruncated: boolean;
  readonly occurrences: readonly TriggerOccurrence[];
  readonly revision: TriggerRevision;
  readonly trigger: Trigger;
}

/** A record as `triggers.list` shows it, built the way the Host builds it. */
export function mockTriggerSummary(
  record: MockTriggerRecord,
  anchorThreadTitle: string,
): TriggerSummary {
  const latest = record.occurrences[0];
  const source = record.revision.source;
  return {
    ...record.trigger,
    anchorThreadTitle,
    latestOccurrence: latest
      ? {
          completedAt: latest.completedAt,
          createdAt: latest.createdAt,
          error: triggerOccurrenceErrorMessage(latest.error),
          id: latest.id,
          source: latest.event.source.kind,
          status: latest.status,
        }
      : null,
    source:
      source.kind === "schedule"
        ? { kind: "schedule", schedule: withoutPayload(source.schedule) }
        : source,
    watch: record.activation
      ? { lastError: record.activation.lastError, observed: record.activation.observed }
      : null,
  };
}

function withoutPayload(
  schedule: Extract<TriggerSource, { kind: "schedule" }>["schedule"],
): Extract<TriggerSource, { kind: "schedule" }>["schedule"] {
  const { payload: _payload, ...rest } = schedule;
  return rest;
}

/** The Trigger behind the preview's "Nightly typecheck" message, so its link opens it. */
export const mockNightlyTriggerId = "trg_00000000-0000-4000-8000-000000000001";

const reminderProgram: TriggerProgram = {
  language: "typescript",
  source: `export default async function ({ opensteer }) {
  await opensteer.callTool("thread_message", {
    delivery: "queue",
    message: "Reminder: it's time.",
    threadId: "home",
  });
}`,
  toolContractVersion: 2,
};

const watchProgram: TriggerProgram = {
  language: "typescript",
  source: `import { watch } from "node:fs";

export default async function ({ opensteer }) {
  watch(process.env.HOME + "/Downloads", (_event, name) => {
    void opensteer.callTool("thread_message", {
      delivery: "queue",
      message: \`New download: \${name}\`,
      observationId: name,
      threadId: "home",
    });
  });
  await new Promise(() => {});
}`,
  toolContractVersion: 2,
};

/**
 * Every way an automation can look on the Automations page, dated from the
 * preview's clock: reminders coming up, one that failed when it went off,
 * repeating ones that ran fine, one paused by its owner, a webhook, a watch
 * that is running and one Opensteer paused after it kept crashing.
 */
export function seedMockAutomations(input: {
  readonly homeThread: ThreadSummary;
  readonly now: Date;
  readonly userId: string;
  readonly workThread: ThreadSummary;
}): readonly MockTriggerRecord[] {
  const { homeThread, now, workThread } = input;
  const minutes = (count: number) => new Date(now.getTime() + count * 60_000);
  const atLocal = (days: number, hours: number, minute = 0) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hours, minute, 0, 0);
    return date;
  };
  const roundedToMinute = (date: Date) => new Date(Math.floor(date.getTime() / 60_000) * 60_000);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const record = (spec: {
    readonly activation?: (trigger: Trigger, revision: TriggerRevision) => TriggerWatchActivation;
    readonly anchor: ThreadSummary;
    readonly consecutiveFailures?: number;
    readonly createdByThread?: ThreadSummary;
    readonly createdDaysAgo: number;
    readonly id?: string;
    readonly name: string;
    readonly occurrences?: readonly OccurrenceSpec[];
    readonly pauseReason?: string;
    readonly program?: TriggerProgram;
    readonly source: TriggerSource;
    readonly status?: "active" | "paused";
  }): MockTriggerRecord => {
    const triggerId = spec.id ?? createId("trigger");
    const createdAt = new Date(now.getTime() - spec.createdDaysAgo * 86_400_000).toISOString();
    const revision = TriggerRevisionSchema.parse({
      createdAt,
      createdBy: input.userId,
      createdByThreadId: spec.createdByThread?.id ?? null,
      id: createId("triggerRevision"),
      ordinal: 1,
      program: spec.program ?? reminderProgram,
      source: spec.source,
      triggerId,
    });
    const status = spec.status ?? "active";
    const trigger = TriggerSchema.parse({
      anchorThreadId: spec.anchor.id,
      consecutiveFailures: spec.consecutiveFailures ?? 0,
      createdAt,
      createdBy: input.userId,
      createdByThreadId: spec.createdByThread?.id ?? null,
      currentRevisionId: revision.id,
      id: triggerId,
      kind: spec.source.kind,
      name: spec.name,
      nextFireAt: nextFire(spec.source, status, now),
      pauseReason: spec.pauseReason ?? null,
      status,
      updatedAt: createdAt,
      webhookRouteKey: spec.source.kind === "webhook" ? `wh_${"m".repeat(32)}` : null,
      workspaceId: spec.anchor.workspaceId,
    });
    const occurrences = (spec.occurrences ?? []).map((occurrence) =>
      mockOccurrence(trigger, revision, spec.anchor, occurrence),
    );
    const downstreamRuns = (spec.occurrences ?? []).flatMap((occurrence, index) => {
      const made = occurrences[index];
      if (!occurrence.reply || !made) return [];
      return [
        {
          occurrenceId: made.id,
          run: mockRun(occurrence.reply, input.userId, occurrence.at),
          threadTitle: occurrence.reply.title,
        },
      ];
    });
    return {
      activation: spec.activation ? spec.activation(trigger, revision) : null,
      downstreamRuns,
      downstreamRunsTruncated: false,
      occurrences,
      revision,
      trigger,
    };
  };

  const chatReply = { ...homeThread, title: "Chat" };
  return [
    record({
      anchor: homeThread,
      createdDaysAgo: 0,
      name: "Reminder: buy groceries",
      source: schedule({ at: roundedToMinute(minutes(134)).toISOString(), kind: "at" }),
    }),
    record({
      anchor: homeThread,
      createdDaysAgo: 2,
      name: "Reminder: call mom",
      source: schedule({ at: atLocal(1, 10).toISOString(), kind: "at" }),
    }),
    record({
      anchor: homeThread,
      consecutiveFailures: 1,
      createdDaysAgo: 3,
      name: "Reminder: renew passport",
      occurrences: [
        {
          at: minutes(-95),
          error: "thread_message failed: Opensteer was not reachable from this computer.",
          source: "schedule",
          status: "failed",
        },
      ],
      source: schedule({ at: roundedToMinute(minutes(-95)).toISOString(), kind: "at" }),
    }),
    record({
      anchor: homeThread,
      createdDaysAgo: 40,
      name: "Morning email summary",
      occurrences: [
        {
          at: atLocal(-1, 8),
          reply: chatReply,
          source: "schedule",
          status: "succeeded",
          stdout: "3 unread from people you reply to; 41 newsletters skipped.",
        },
        { at: atLocal(-2, 8), reply: chatReply, source: "schedule", status: "succeeded" },
        {
          at: atLocal(-3, 8),
          error: "Gmail rate limit reached. Try again later.",
          source: "schedule",
          status: "failed",
        },
      ],
      source: schedule({ expression: "0 8 * * 1-5", kind: "cron", timezone }),
    }),
    record({
      anchor: homeThread,
      createdDaysAgo: 12,
      name: "Price check: Sony A7 IV",
      occurrences: [
        {
          at: roundedToMinute(minutes(-(now.getMinutes() || 60))),
          result: { changed: false, price: 1998 },
          source: "schedule",
          status: "succeeded",
        },
      ],
      source: schedule({ expression: "0 * * * *", kind: "cron", timezone }),
    }),
    record({
      anchor: homeThread,
      createdDaysAgo: 30,
      id: mockNightlyTriggerId,
      name: "Nightly typecheck",
      occurrences: [
        { at: atLocal(0, 2), reply: chatReply, source: "schedule", status: "succeeded" },
      ],
      source: schedule({ expression: "0 2 * * *", kind: "cron", timezone }),
    }),
    record({
      anchor: homeThread,
      createdDaysAgo: 60,
      name: "Weekly review",
      source: schedule({ expression: "0 18 * * 0", kind: "cron", timezone }),
      status: "paused",
    }),
    record({
      anchor: workThread,
      createdByThread: workThread,
      createdDaysAgo: 20,
      name: "GitHub deploys",
      occurrences: [
        { at: minutes(-12), reply: workThread, source: "webhook", status: "succeeded" },
      ],
      source: { kind: "webhook" },
    }),
    record({
      activation: (trigger, revision) =>
        mockActivation(trigger, revision, homeThread.environmentId, now, {
          observed: "running",
          restartCount: 0,
          stdoutTail: "watching ~/Downloads\n",
        }),
      anchor: homeThread,
      createdDaysAgo: 5,
      name: "Downloads folder",
      program: watchProgram,
      source: { kind: "watch" },
    }),
    record({
      activation: (trigger, revision) =>
        mockActivation(trigger, revision, homeThread.environmentId, now, {
          desired: "stopped",
          lastError: "IMAP login failed: invalid credentials",
          observed: "stopped",
          restartCount: 3,
          stderrTail:
            "Error: IMAP login failed: invalid credentials\n    at connect (inbox.ts:12:11)\n",
        }),
      anchor: homeThread,
      createdDaysAgo: 9,
      name: "Inbox watcher",
      pauseReason: WATCH_AUTO_PAUSE_REASON,
      program: watchProgram,
      source: { kind: "watch" },
      status: "paused",
    }),
  ];
}

interface OccurrenceSpec {
  readonly at: Date;
  readonly error?: string;
  readonly reply?: ThreadSummary;
  readonly result?: unknown;
  readonly source: "manual" | "schedule" | "webhook";
  readonly status: "failed" | "succeeded";
  readonly stdout?: string;
}

function schedule(value: Extract<TriggerSource, { kind: "schedule" }>["schedule"]): TriggerSource {
  return { kind: "schedule", schedule: value };
}

function nextFire(source: TriggerSource, status: "active" | "paused", now: Date): string | null {
  if (status !== "active" || source.kind !== "schedule") return null;
  const next = firstTriggerFireAt(source.schedule, now);
  return next.getTime() > now.getTime() ? next.toISOString() : null;
}

function mockOccurrence(
  trigger: Trigger,
  revision: TriggerRevision,
  anchor: ThreadSummary,
  spec: OccurrenceSpec,
): TriggerOccurrence {
  const id = createId("triggerOccurrence");
  const at = spec.at.toISOString();
  const completedAt = new Date(spec.at.getTime() + 4_000).toISOString();
  return TriggerOccurrenceSchema.parse({
    commandId: createId("command"),
    completedAt,
    createdAt: at,
    environmentId: anchor.environmentId,
    error: spec.error ? { message: spec.error } : null,
    event: {
      id,
      payload: null,
      receivedAt: at,
      source:
        spec.source === "schedule"
          ? { kind: "schedule", scheduledFor: at }
          : spec.source === "webhook"
            ? { headers: {}, kind: "webhook", method: "POST" }
            : { kind: "manual" },
      trigger: {
        anchorThreadId: trigger.anchorThreadId,
        id: trigger.id,
        revisionId: revision.id,
        workspaceId: trigger.workspaceId,
      },
    },
    exitCode: spec.status === "succeeded" ? 0 : 1,
    id,
    result: spec.result ?? null,
    revisionId: revision.id,
    startedAt: at,
    status: spec.status,
    stderr: spec.error ? `${spec.error}\n` : "",
    stdout: spec.stdout ?? "",
    triggerId: trigger.id,
  });
}

function mockRun(thread: ThreadSummary, userId: string, at: Date): Run {
  const seed = createId("message");
  return RunSchema.parse({
    accessMode: thread.accessMode,
    activationInputId: seed,
    assignmentId: null,
    causalChainId: createId("causalChain"),
    completedAt: new Date(at.getTime() + 20_000).toISOString(),
    createdAt: new Date(at.getTime() + 5_000).toISOString(),
    environmentId: thread.environmentId,
    failure: null,
    harnessInstanceId: thread.harnessInstanceId,
    id: createId("run"),
    modelSelection: thread.modelSelection,
    providerSessionId: null,
    replyTarget: null,
    requestedBy: userId,
    runOrdinal: 0,
    seedInputId: seed,
    startedAt: new Date(at.getTime() + 6_000).toISOString(),
    status: "completed",
    threadId: thread.id,
  });
}

function mockActivation(
  trigger: Trigger,
  revision: TriggerRevision,
  environmentId: string,
  now: Date,
  state: Partial<TriggerWatchActivation>,
): TriggerWatchActivation {
  return TriggerWatchActivationSchema.parse({
    anchorThreadId: trigger.anchorThreadId,
    consecutiveFailures: 0,
    createdAt: trigger.createdAt,
    createdBy: trigger.createdBy,
    desired: "active",
    environmentId,
    executionGeneration: 1,
    healthySince: now.toISOString(),
    id: createId("triggerWatchActivation"),
    lastError: null,
    lastExitCode: null,
    leaseExpiresAt: null,
    observed: "running",
    restartCount: 0,
    revisionId: revision.id,
    runnerBootId: null,
    runnerId: null,
    stderrTail: "",
    stdoutTail: "",
    triggerId: trigger.id,
    updatedAt: now.toISOString(),
    workspaceId: trigger.workspaceId,
    ...state,
  });
}
