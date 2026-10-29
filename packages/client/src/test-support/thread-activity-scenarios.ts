import { createId } from "@opensteer/core";
import { HarnessInstanceCatalogViewSchema } from "@opensteer/protocol";
import type {
  EnvironmentSummary,
  HarnessSummary,
  RunQueueEntry,
  ThreadSummary,
  TranscriptEntry,
} from "../host/client.js";

/**
 * One state of a Thread as every client must show it, the same way: the line
 * under its transcript and its Stop control.
 */
export interface ThreadActivityScenario {
  /** Whether the Thread's AI account is getting ready on its computer; see `withAccountPreparing`. */
  readonly accountPreparing?: boolean;
  readonly entries: readonly TranscriptEntry[];
  readonly expected: {
    /** The words of the line under the transcript, or null for none. */
    readonly line: string | null;
    readonly stop: "absent" | "disabled" | "enabled";
  };
  readonly name: string;
  readonly runQueue: readonly RunQueueEntry[];
  readonly status: ThreadSummary["status"];
}

const at = "2026-08-16T10:00:00.000Z";

/**
 * The Host's environments with an AI account getting ready on its computer,
 * as it is for a while after that computer starts.
 */
export function withAccountPreparing(
  environments: readonly EnvironmentSummary[],
  harness: Pick<HarnessSummary, "driverKind" | "environmentId" | "id" | "name">,
): EnvironmentSummary[] {
  return environments.map((environment) =>
    environment.id === harness.environmentId
      ? {
          ...environment,
          harnessCatalogs: [
            ...environment.harnessCatalogs.filter(
              ({ harnessInstanceId }) => harnessInstanceId !== harness.id,
            ),
            HarnessInstanceCatalogViewSchema.parse({
              detail: `Preparing ${harness.name}…`,
              driverKind: harness.driverKind,
              harnessInstanceId: harness.id,
              models: [],
              status: "preparing",
            }),
          ],
        }
      : environment,
  );
}

/** The states every client's Thread screen is checked against, for one Thread. */
export function threadActivityScenarios(
  thread: Pick<ThreadSummary, "harnessLabel" | "id">,
): readonly ThreadActivityScenario[] {
  const threadId = thread.id;
  const runId = `run_scenario_${threadId}`;
  const run = (status: RunQueueEntry["status"], runOrdinal = 0): RunQueueEntry => ({
    createdAt: at,
    id: runOrdinal === 0 ? runId : `${runId}_${runOrdinal}`,
    runOrdinal,
    status,
    threadId,
  });
  const userId = createId("user");
  const asked: TranscriptEntry = {
    author: { displayName: "Owner", kind: "human", principalId: `user:${userId}`, userId },
    body: "Check the numbers",
    createdAt: at,
    id: `msg_scenario_${threadId}`,
    kind: "message",
    messageKind: "input",
    runId: null,
  };
  return [
    {
      entries: [asked],
      expected: { line: null, stop: "absent" },
      name: "the Host says idle while a finished Run is still held",
      runQueue: [run("running")],
      status: "idle",
    },
    {
      entries: [asked],
      expected: { line: "Starting", stop: "enabled" },
      name: "its Run is queued",
      runQueue: [run("queued")],
      status: "running",
    },
    {
      accountPreparing: true,
      entries: [asked],
      expected: { line: `${thread.harnessLabel} is getting ready`, stop: "enabled" },
      name: "its Run is queued while its AI account gets ready",
      runQueue: [run("queued")],
      status: "running",
    },
    {
      // Handed to its computer, the Run is past waiting, whatever the
      // account last reported.
      accountPreparing: true,
      entries: [asked],
      expected: { line: "Working", stop: "enabled" },
      name: "its Run is starting while its AI account still reads as getting ready",
      runQueue: [run("starting")],
      status: "running",
    },
    {
      accountPreparing: true,
      entries: [asked],
      expected: { line: "Working", stop: "enabled" },
      name: "its Run is working with another queued behind it while its AI account gets ready",
      runQueue: [run("running"), run("queued", 1)],
      status: "running",
    },
    {
      entries: [asked],
      expected: { line: "Working", stop: "enabled" },
      name: "its Run is working",
      runQueue: [run("running")],
      status: "running",
    },
    {
      entries: [asked],
      expected: { line: "Waiting for you", stop: "enabled" },
      name: "its Run is waiting for an answer",
      runQueue: [run("waiting")],
      status: "waiting",
    },
    {
      entries: [
        asked,
        {
          createdAt: at,
          error: null,
          id: `run:${runId}`,
          kind: "run",
          replyMessageId: null,
          runId,
          status: "running",
          stopping: true,
        },
      ],
      // The turn itself says it is stopping, so no separate line does.
      expected: { line: null, stop: "disabled" },
      name: "a Stop was asked for",
      runQueue: [run("running")],
      status: "running",
    },
  ];
}
