import {
  ScheduleAnchorInvalidation,
  type ScheduleAnchorState,
} from "./schedule-anchor-invalidation.js";
import type { TriggerSummary, TriggerSource } from "@opensteer/triggers/models";
import { triggerOccurrenceErrorMessage } from "@opensteer/triggers/models";
import {
  HostClientRequestError,
  type HostClient,
  type HostSnapshot,
  type TriggerDetail,
} from "./client.js";
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
export type ScheduleState<T> =
  | { readonly status: "ready"; readonly data: T; readonly error: null }
  | {
      readonly status: "loading" | "offline" | "unavailable" | "error";
      readonly data: null;
      readonly error: string | null;
      readonly errorCode?: string;
    };

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

const loadingScheduleState = { status: "loading", data: null, error: null } as const;

function scheduleReaderScope(snapshot: HostSnapshot): string {
  return JSON.stringify([snapshot.session, snapshot.user?.id, snapshot.deploymentId]);
}

/** A screen owns the subscription. No schedule read is part of attachment/bootstrap. */
export class ScheduleResource<Wire, Data> {
  #state: ScheduleState<Data> = loadingScheduleState;
  #readerScope: string | undefined;
  #listeners = new Set<() => void>();
  #unsubscribe: (() => void) | undefined;
  #version = 0;
  #signature = "";
  #wire: Wire | undefined;
  readonly client: HostClient;
  readonly read: () => Promise<Wire>;
  readonly present: (wire: Wire, snapshot: HostSnapshot) => Data;
  readonly detail: boolean;
  readonly discoverRuns: (wire: Wire) => boolean;
  readonly relatedRuns: (wire: Wire) => readonly string[];
  #projection = "";
  readonly #anchors = new ScheduleAnchorInvalidation();
  #releaseAnchors: (() => void) | undefined;
  readonly anchorThreads: (
    wire: Wire,
    snapshot: HostSnapshot,
  ) => readonly ({ id: string } & ScheduleAnchorState)[];
  get retained(): boolean {
    return this.#listeners.size > 0;
  }
  constructor(
    client: HostClient,
    read: () => Promise<Wire>,
    present: (wire: Wire, snapshot: HostSnapshot) => Data,
    detail = false,
    anchorThreads: (
      wire: Wire,
      snapshot: HostSnapshot,
    ) => readonly ({ id: string } & ScheduleAnchorState)[] = () => [],
    relatedRuns: (wire: Wire) => readonly string[] = () => [],
    discoverRuns: (wire: Wire) => boolean = () => false,
  ) {
    this.client = client;
    this.read = read;
    this.present = present;
    this.detail = detail;
    this.relatedRuns = relatedRuns;
    this.discoverRuns = discoverRuns;
    this.anchorThreads = anchorThreads;
  }
  // React reads before subscribing, including after a hidden screen changes readers.
  readonly getSnapshot = (): ScheduleState<Data> =>
    this.#readerScope === scheduleReaderScope(this.client.getSnapshot())
      ? this.#state
      : loadingScheduleState;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#releaseAnchors = this.#anchors.retain(this.client);
      this.#unsubscribe = this.client.subscribe(() => this.#changed());
      this.#signature = "";
      this.#changed();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#releaseAnchors?.();
        this.#unsubscribe?.();
        this.#unsubscribe = undefined;
        this.#version++;
        // No observer can detect a sign-out/sign-in cycle while this is hidden.
        this.#wire = undefined;
        this.#readerScope = undefined;
        this.#state = loadingScheduleState;
        this.#projection = "";
      }
    };
  };
  #publish(state: ScheduleState<Data>): void {
    if (JSON.stringify(this.#state) === JSON.stringify(state)) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  #readSignature(s: HostSnapshot): string {
    return JSON.stringify([
      scheduleReaderScope(s),
      s.connection,
      s.network,
      s.triggerRevision,
      this.#anchors.revision,
      s.threads
        .filter(({ id }) => this.#anchors.anchors.has(id))
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
      // Queued inputs have no Run ID or target in triggers.get until admitted.
      // Ordinary details must discover them; lists and managed workers stay scoped.
      this.#wire !== undefined && this.discoverRuns(this.#wire)
        ? s.runQueue.map(({ id }) => id)
        : null,
      this.detail
        ? s.runQueue
            .filter(
              ({ id, threadId }) =>
                this.#anchors.anchors.has(threadId) ||
                (this.#wire !== undefined && this.relatedRuns(this.#wire).includes(id)),
            )
            .map(({ id, status }) => [id, status])
        : null,
    ]);
  }
  #changed(): void {
    const s = this.client.getSnapshot();
    const signature = this.#readSignature(s);
    if (signature !== this.#signature) {
      this.#signature = signature;
      void this.refresh().catch(() => undefined);
    } else if (this.#wire !== undefined && this.#state.status === "ready") {
      const projection = JSON.stringify([
        s.threads.map(({ id, title, icon, color }) => [id, title, icon, color]),
        s.tasks,
        s.activeTasks,
      ]);
      if (projection === this.#projection) return;
      this.#projection = projection;
      this.#publish({ status: "ready", data: this.present(this.#wire, s), error: null });
    }
  }
  async refresh(): Promise<void> {
    const version = ++this.#version;
    const snapshot = this.client.getSnapshot();
    const readerScope = scheduleReaderScope(snapshot);
    const keepData = this.#readerScope === readerScope && this.#state.status === "ready";
    this.#readerScope = readerScope;
    if (!keepData) {
      this.#wire = undefined;
      this.#anchors.anchors.clear();
    }
    if (!scheduleOnline(snapshot)) {
      this.#publish({
        status: "offline",
        data: null,
        error: "Connect to the Host to view schedules.",
      });
      return;
    }
    if (!keepData) this.#publish({ status: "loading", data: null, error: null });
    // Before discovery establishes the anchor, hidden control events cannot be
    // scoped. A scalar fence keeps this window bounded without retaining events.
    const discovering = this.#anchors.anchors.size === 0;
    const controlRevision = this.#anchors.controlRevision;
    try {
      const wire = await this.read();
      if (
        version !== this.#version ||
        !scheduleOnline(this.client.getSnapshot()) ||
        readerScope !== scheduleReaderScope(this.client.getSnapshot())
      )
        return;
      if (discovering && controlRevision !== this.#anchors.controlRevision) {
        await this.refresh();
        return;
      }
      this.#wire = wire;
      const previousAnchors = new Map(this.#anchors.anchors);
      this.#anchors.anchors.clear();
      if (this.retained) {
        for (const thread of this.anchorThreads(wire, this.client.getSnapshot()))
          this.#anchors.anchors.set(thread.id, { ...previousAnchors.get(thread.id), ...thread });
      }
      this.#signature = this.#readSignature(this.client.getSnapshot());
      this.#publish({
        status: "ready",
        data: this.present(wire, this.client.getSnapshot()),
        error: null,
      });
    } catch (error) {
      if (
        version !== this.#version ||
        readerScope !== scheduleReaderScope(this.client.getSnapshot())
      )
        return;
      this.#wire = undefined;
      const unavailable =
        error instanceof HostClientRequestError &&
        ((error.status === 404 && !this.detail) ||
          error.status === 405 ||
          error.status === 501 ||
          error.code === "unsupported");
      this.#publish({
        status: unavailable ? "unavailable" : "error",
        ...(error instanceof HostClientRequestError ? { errorCode: error.code } : {}),
        data: null,
        error: unavailable
          ? "Schedules are unavailable on this Host."
          : error instanceof Error
            ? error.message
            : "Unable to load schedules.",
      });
      throw error;
    }
  }
}
function scheduleOnline(snapshot: HostSnapshot): boolean {
  return (
    snapshot.connection === "connected" &&
    snapshot.session === "authenticated" &&
    snapshot.network !== "offline"
  );
}

export class SchedulesClient {
  readonly list: ScheduleResource<readonly TriggerSummary[], readonly ScheduleItem[]>;
  readonly #details = new Map<string, ScheduleResource<TriggerDetail, ScheduleDetail>>();
  readonly #keys = new Map<string, string>();
  readonly #actions = new Map<string, Promise<ScheduleDetail>>();
  readonly client: HostClient;
  readonly deploymentId: string | undefined;
  constructor(client: HostClient, deploymentId?: string) {
    this.client = client;
    this.deploymentId = deploymentId;
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
        (wire) => wire.downstreamRuns.map(({ run }) => run.id),
        (wire) => wire.trigger.systemRole == null,
      );
      this.#details.set(triggerId, resource);
    }
    return resource;
  }
  /** Coalesce taps in flight; a later Run now tap is a new, explicit request. */
  act(
    triggerId: string,
    action: "pause" | "resume" | "run",
    idempotencyKey?: string,
    payload?: unknown,
  ): Promise<ScheduleDetail> {
    if (!scheduleOnline(this.client.getSnapshot()))
      return Promise.reject(new Error("Connect to the Host to change schedules."));
    const identity = `${this.client.getSnapshot().user?.id}:${triggerId}:${action}`;
    const held = this.#actions.get(identity);
    if (held) return held;
    const key =
      idempotencyKey ?? this.#keys.get(identity) ?? mutationIdempotencyKey(`schedule:${identity}`);
    this.#keys.set(identity, key);
    const userId = this.client.getSnapshot().user?.id;
    const pending = (async () => {
      await this.client.dispatch(
        action === "run"
          ? {
              type: "trigger.run",
              triggerId,
              idempotencyKey: key,
              ...(payload === undefined ? {} : { payload }),
            }
          : {
              type: "trigger.status.set",
              triggerId,
              idempotencyKey: key,
              status: action === "pause" ? "paused" : "active",
            },
      );
      if (
        !scheduleOnline(this.client.getSnapshot()) ||
        this.client.getSnapshot().user?.id !== userId
      )
        throw new Error("Reconnect to the Host to confirm the schedule.");
      const detail = this.detail(triggerId);
      await detail.refresh();
      if (this.list.retained) await this.list.refresh();
      const state = detail.getSnapshot();
      if (state.status !== "ready")
        throw new Error("Unable to confirm the schedule from the Host.");
      this.#keys.delete(identity);
      return state.data;
    })()
      .catch(async (error: unknown) => {
        if (action !== "run") throw error;
        // Older Hosts ignore the run key. Never resend to resolve uncertainty.
        this.#keys.delete(identity);
        if (this.client.getSnapshot().user?.id === userId) {
          await this.detail(triggerId)
            .refresh()
            .catch(() => undefined);
        }
        throw new Error("Couldn't confirm the run started — check Recent runs", { cause: error });
      })
      .finally(() => this.#actions.delete(identity));
    this.#actions.set(identity, pending);
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
