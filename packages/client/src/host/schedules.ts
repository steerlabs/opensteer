import { createClientActionFamily, type ActionOutcome } from "../actions/client-action.js";
import type { HostApiCommandOutput } from "@opensteer/protocol";
import { createClientRead, type ClientRead, type ClientReadState } from "../reads/client-read.js";
import { presentClientIssue } from "../feedback/client-issue.js";
import {
  ScheduleAnchorInvalidation,
  type ScheduleAnchorState,
} from "./schedule-anchor-invalidation.js";
import type { TriggerSummary, TriggerSource } from "@opensteer/triggers/models";
import { triggerOccurrenceErrorMessage } from "@opensteer/triggers/models";
import { type HostClient, type HostSnapshot, type TriggerDetail } from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { conversationName } from "./conversation-presentation.js";
import { taskMark, threadMark, type TaskMark } from "./task-marks.js";
import {
  describeEvent,
  describeRepeating,
  formatFullMoment,
  runOutcome,
  scheduleStatusWord,
} from "./automation-presentation.js";

export interface ScheduleAnchor {
  readonly threadId: string;
  readonly title: string;
  readonly mark: TaskMark;

  /** A missing directory entry must not become a fabricated navigation target. */
  readonly visible: boolean;
}
export interface ScheduleItem {
  readonly id: string;
  readonly name: string;
  readonly kind: TriggerSummary["kind"];
  readonly systemRole: TriggerSummary["systemRole"];
  readonly status: TriggerSummary["status"];
  readonly pauseReason: string | null;
  /** Why an active memory pass is not running: it has no usable model. */
  readonly waitingReason: string | null;
  readonly statusWord: string;
  readonly nextFireAt: string | null;
  readonly latestOccurrence: TriggerSummary["latestOccurrence"];
  readonly anchor: ScheduleAnchor;
  readonly timing: string;
  readonly source: TriggerSource;
  readonly updatedAt: string;
  /** A watch's last observed state; null for anything else, or before it first starts. */
  readonly watch: TriggerSummary["watch"];
}
export interface ScheduleDetail {
  readonly item: ScheduleItem;
  readonly definition: TriggerDetail;
  readonly occurrences: readonly {
    readonly occurrence: TriggerDetail["occurrences"][number];
    readonly error: string | null;
    readonly outcome: string;
    readonly replies: readonly TriggerDetail["downstreamRuns"][number][];
  }[];
}
export type ScheduleState<T> = ClientReadState<T> & { readonly error: string | null };

export function scheduleTiming(source: TriggerSource): string {
  if (source.kind !== "schedule") return describeEvent(source.kind, null);
  return source.schedule.kind === "cron"
    ? `${describeRepeating(source.schedule)} · ${source.schedule.timezone}`
    : `Once, ${formatFullMoment(source.schedule.at)} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
}
function scheduleItem(
  summary: TriggerSummary,
  snapshot: HostSnapshot,
  anchor?: TriggerDetail["anchorThread"],
): ScheduleItem {
  const thread =
    anchor === undefined ? threadInDirectory(summary.anchorThreadId, snapshot) : anchor;
  return {
    id: summary.id,
    name: summary.name,
    kind: summary.kind,
    systemRole: summary.systemRole,
    status: summary.status,
    pauseReason: summary.pauseReason,
    waitingReason: summary.status === "active" ? (summary.waitingReason ?? null) : null,
    statusWord: scheduleStatusWord(summary.status, summary.pauseReason),
    nextFireAt:
      summary.status === "active" && summary.kind === "schedule" ? summary.nextFireAt : null,
    latestOccurrence: summary.latestOccurrence,
    timing: scheduleTiming(summary.source),
    source: summary.source,
    updatedAt: summary.updatedAt,
    watch: summary.watch,
    anchor: {
      threadId: summary.anchorThreadId,
      visible: thread !== null,
      title: thread?.title ?? "Unavailable task",
      mark: thread ? taskMark(thread) : threadMark(summary.anchorThreadId, snapshot),
    },
  };
}
export function scheduleList(
  summaries: readonly TriggerSummary[],
  snapshot: HostSnapshot,
): readonly ScheduleItem[] {
  return summaries
    .filter(({ status }) => status !== "archived")
    .map((summary) => scheduleItem(summary, snapshot))
    .sort(
      (a, b) =>
        Number(a.status === "paused") - Number(b.status === "paused") ||
        (a.nextFireAt ?? "￿").localeCompare(b.nextFireAt ?? "￿") ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}
export function scheduleDetail(
  detail: TriggerDetail,
  snapshot: HostSnapshot,
  now = Date.now(),
): ScheduleDetail {
  const latest = detail.occurrences[0];
  const summary: TriggerSummary = {
    ...detail.trigger,
    anchorThreadTitle: detail.anchorThreadTitle,
    source: detail.revision.source,
    watch: detail.activation
      ? { observed: detail.activation.observed, lastError: detail.activation.lastError }
      : null,
    latestOccurrence: latest
      ? {
          id: latest.id,
          status: latest.status,
          createdAt: latest.createdAt,
          completedAt: latest.completedAt,
          error: triggerOccurrenceErrorMessage(latest.error),
          source: latest.event.source.kind,
        }
      : null,
  };
  return {
    item: scheduleItem(summary, snapshot, detail.anchorThread),
    definition: detail,
    occurrences: detail.occurrences.map((occurrence) => {
      const replies = detail.downstreamRuns.filter((reply) => reply.occurrenceId === occurrence.id);
      const reply = replies[0];
      return {
        occurrence,
        replies,
        error: triggerOccurrenceErrorMessage(occurrence.error),
        outcome: runOutcome(
          occurrence,
          reply ? conversationName(reply.threadTitle) : null,
          reply?.run.status ?? null,
          now,
        ),
      };
    }),
  };
}

export class ScheduleResource<Wire, Data> {
  readonly resource: ClientRead<Wire>;
  readonly client: HostClient;
  readonly #present: (wire: Wire, snapshot: HostSnapshot) => Data;
  readonly #listeners = new Set<() => void>();
  readonly #anchors = new ScheduleAnchorInvalidation();
  #wire: Wire | undefined;
  #wireChanged: (() => void) | null = null;
  #source: ClientReadState<Wire> | null = null;
  #projection = "";
  #state: ScheduleState<Data> = { status: "waiting", data: null, issue: null, error: null };
  constructor(
    client: HostClient,
    read: () => Promise<Wire>,
    present: (wire: Wire, snapshot: HostSnapshot) => Data,
    detail = false,
    anchorThreads: (
      wire: Wire,
      snapshot: HostSnapshot,
    ) => readonly ({ id: string } & ScheduleAnchorState)[] = () => [],
    /** The threads its Runs work in; a Run starting or finishing there rereads it. */
    relatedThreads: (wire: Wire) => readonly string[] = () => [],
    discoverRuns: (wire: Wire) => boolean = () => false,
  ) {
    this.client = client;
    this.#present = present;
    this.resource = createClientRead(client, {
      key: detail ? "schedule-detail" : "schedules",
      label: "schedules",
      remember: true,
      read: async (signal) => {
        const revision = this.#anchors.controlRevision;
        const wire = await read();
        signal.throwIfAborted();
        if (revision !== this.#anchors.controlRevision) {
          this.resource.invalidate();
          throw new DOMException("The anchor changed while reading.", "AbortError");
        }
        this.#wire = wire;
        const held = new Map(this.#anchors.anchors);
        this.#anchors.anchors.clear();
        for (const anchor of anchorThreads(wire, client.getSnapshot()))
          this.#anchors.anchors.set(anchor.id, { ...held.get(anchor.id), ...anchor });
        this.#wireChanged?.();
        if (revision !== this.#anchors.controlRevision) this.resource.invalidate();
        return wire;
      },
      subscribeInvalidation: (invalidate) => {
        const release = this.#anchors.retain(client);
        let signature = "";
        const changed = (notify = true) => {
          const snapshot = client.getSnapshot();
          const next = JSON.stringify([
            snapshot.triggerRevision,
            this.#anchors.revision,
            snapshot.threads
              .filter((row) => this.#anchors.anchors.has(row.id))
              .map(
                ({
                  id,
                  status,
                  doneAt,
                  inputQueuePaused,
                  environmentId,
                  harnessInstanceId,
                  modelSelection,
                  accessMode,
                }) => [
                  id,
                  status,
                  doneAt,
                  inputQueuePaused,
                  environmentId,
                  harnessInstanceId,
                  modelSelection,
                  accessMode,
                ],
              ),
            // Running and waiting tasks are shell rows on every client.
            this.#wire !== undefined && (detail || discoverRuns(this.#wire))
              ? snapshot.activeTasks
                  .filter(
                    ({ thread }) =>
                      (detail && this.#wire !== undefined && discoverRuns(this.#wire)) ||
                      this.#anchors.anchors.has(thread.id) ||
                      (this.#wire !== undefined && relatedThreads(this.#wire).includes(thread.id)),
                  )
                  .map(({ thread }) => [thread.id, thread.status])
              : null,
          ]);
          if (next !== signature) {
            if (signature && notify) invalidate();
            signature = next;
          }
          this.#listeners.forEach((listener) => listener());
        };
        this.#wireChanged = () => changed(false);
        const unsubscribe = client.subscribe(changed);
        changed();
        return () => {
          unsubscribe();
          release();
          this.#wire = undefined;
          this.#wireChanged = null;
        };
      },
    });
  }
  get retained(): boolean {
    return this.#listeners.size > 0;
  }
  getSnapshot = (): ScheduleState<Data> => {
    const source = this.resource.getSnapshot(),
      snapshot = this.client.getSnapshot();
    const projection = JSON.stringify([
      snapshot.threads.map(({ id, title, icon, color }) => [id, title, icon, color]),
      snapshot.tasks,
      snapshot.activeTasks,
    ]);
    if (source === this.#source && projection === this.#projection) return this.#state;
    this.#source = source;
    this.#projection = projection;
    this.#state =
      source.status === "ready"
        ? {
            ...source,
            data: this.#present(source.data, snapshot),
            error: source.issue ? presentClientIssue(source.issue).title : null,
          }
        : { ...source, error: source.issue ? presentClientIssue(source.issue).title : null };
    return this.#state;
  };
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    const release = this.resource.subscribe(listener);
    return () => {
      release();
      this.#listeners.delete(listener);
    };
  };
  refresh = (): Promise<void> => this.resource.refresh();
  invalidate = (): void => this.resource.invalidate();
  evict = (): void => this.resource.evict();
  dispose = (): void => this.resource.dispose();
}
export class SchedulesClient {
  readonly list: ScheduleResource<readonly TriggerSummary[], readonly ScheduleItem[]>;
  readonly #details = new Map<string, ScheduleResource<TriggerDetail, ScheduleDetail>>();
  readonly #keys = new Map<string, string>();
  readonly #actions: ReturnType<
    typeof createClientActionFamily<
      {
        readonly triggerId: string;
        readonly action: "pause" | "resume" | "run";
        readonly idempotencyKey: string;
        readonly payload?: unknown;
      },
      HostApiCommandOutput
    >
  >;
  readonly client: HostClient;
  readonly deploymentId: string | undefined;
  constructor(client: HostClient, deploymentId?: string) {
    this.client = client;
    this.deploymentId = deploymentId;
    this.#actions = createClientActionFamily(client, {
      label: "change this schedule",
      execute: ({ triggerId, action, idempotencyKey, payload }) =>
        client.dispatch(
          action === "run"
            ? {
                type: "trigger.run",
                triggerId,
                idempotencyKey,
                ...(payload === undefined ? {} : { payload }),
              }
            : {
                type: "trigger.status.set",
                triggerId,
                idempotencyKey,
                status: action === "pause" ? "paused" : "active",
              },
        ),
    });
    this.list = new ScheduleResource<readonly TriggerSummary[], readonly ScheduleItem[]>(
      client,
      async () =>
        unwrapRpcResult(await client.rpc["triggers.list"](deploymentId ? {} : {})).triggers,
      scheduleList,
      false,
      (summaries, snapshot) =>
        summaries.map(
          ({ anchorThreadId }) =>
            snapshot.threads.find(({ id }) => id === anchorThreadId) ?? { id: anchorThreadId },
        ),
    );
  }
  detail(triggerId: string): ScheduleResource<TriggerDetail, ScheduleDetail> {
    let resource = this.#details.get(triggerId);
    if (!resource) {
      resource = new ScheduleResource<TriggerDetail, ScheduleDetail>(
        this.client,
        async () => unwrapRpcResult(await this.client.rpc["triggers.get"]({ triggerId })),
        scheduleDetail,
        true,
        (wire, snapshot) => [
          wire.anchorThread ??
            snapshot.threads.find(({ id }) => id === wire.trigger.anchorThreadId) ?? {
              id: wire.trigger.anchorThreadId,
            },
        ],
        (wire) => wire.downstreamRuns.map(({ run }) => run.threadId),
        (wire) => wire.trigger.systemRole == null,
      );
      this.#details.set(triggerId, resource);
    }
    return resource;
  }
  act(
    triggerId: string,
    action: "pause" | "resume" | "run",
    idempotencyKey?: string,
    payload?: unknown,
  ): Promise<ActionOutcome<HostApiCommandOutput>> {
    const identity = `${triggerId}:${action}`;
    const owner = this.#actions.for(identity);
    const key =
      idempotencyKey ?? this.#keys.get(identity) ?? mutationIdempotencyKey(`schedule:${identity}`);
    this.#keys.set(identity, key);
    const pending = owner.run({
      triggerId,
      action,
      idempotencyKey: key,
      ...(payload === undefined ? {} : { payload }),
    });
    void pending.then((outcome) => {
      if (outcome.kind === "confirmed") {
        this.#keys.delete(identity);
        this.detail(triggerId).invalidate();
        this.list.invalidate();
      } else if (outcome.kind === "unconfirmed") this.detail(triggerId).invalidate();
    });
    return pending;
  }
}
const clients = new WeakMap<HostClient, Map<string, SchedulesClient>>();
export function schedulesClient(client: HostClient, deploymentId?: string): SchedulesClient {
  let scopes = clients.get(client);
  if (!scopes) {
    scopes = new Map();
    clients.set(client, scopes);
  }
  const key = deploymentId ?? "";
  let schedules = scopes.get(key);
  if (!schedules) {
    schedules = new SchedulesClient(client, deploymentId);
    scopes.set(key, schedules);
  }
  return schedules;
}
