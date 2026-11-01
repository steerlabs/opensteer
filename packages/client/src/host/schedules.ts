import type { TriggerSummary, TriggerSource } from "@opensteer/triggers";
import { triggerOccurrenceErrorMessage } from "@opensteer/triggers";
import {
  HostClientRequestError,
  type HostClient,
  type HostSnapshot,
  type TriggerDetail,
} from "./client.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "./host-session-client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import { conversationName } from "./conversation-presentation.js";
import { threadMark, type TaskMark } from "./task-marks.js";
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
  readonly home: boolean;
  /** A missing directory entry must not become a fabricated navigation target. */
  readonly visible: boolean;
}
export interface ScheduleItem {
  readonly id: string;
  readonly name: string;
  readonly kind: TriggerSummary["kind"];
  readonly status: TriggerSummary["status"];
  readonly pauseReason: string | null;
  readonly statusWord: string;
  readonly nextFireAt: string | null;
  readonly latestOccurrence: TriggerSummary["latestOccurrence"];
  readonly anchor: ScheduleAnchor;
  readonly timing: string;
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
    };

export function scheduleTiming(source: TriggerSource): string {
  if (source.kind !== "schedule") return describeEvent(source.kind, null);
  return source.schedule.kind === "cron"
    ? `${describeRepeating(source.schedule)} · ${source.schedule.timezone}`
    : `Once, ${formatFullMoment(source.schedule.at)} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
}
function scheduleItem(summary: TriggerSummary, snapshot: HostSnapshot): ScheduleItem {
  const thread = threadInDirectory(summary.anchorThreadId, snapshot);
  const home = summary.anchorThreadId === snapshot.homeThreadId;
  return {
    id: summary.id,
    name: summary.name,
    kind: summary.kind,
    status: summary.status,
    pauseReason: summary.pauseReason,
    statusWord: scheduleStatusWord(summary.status, summary.pauseReason),
    nextFireAt:
      summary.status === "active" && summary.kind === "schedule" ? summary.nextFireAt : null,
    latestOccurrence: summary.latestOccurrence,
    timing: scheduleTiming(summary.source),
    anchor: {
      threadId: summary.anchorThreadId,
      home,
      visible: home || thread !== null,
      title: home ? "Chat" : (thread?.title ?? "Unavailable thread"),
      mark: threadMark(summary.anchorThreadId, snapshot),
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
    item: scheduleItem(summary, snapshot),
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
          reply
            ? conversationName(reply.run.threadId, reply.threadTitle, snapshot.homeThreadId)
            : null,
          reply?.run.status ?? null,
          now,
        ),
      };
    }),
  };
}

const loadingScheduleState = { status: "loading", data: null, error: null } as const;

function scheduleReaderScope(snapshot: HostSnapshot): string {
  return JSON.stringify([
    snapshot.session,
    snapshot.user?.id,
    snapshot.deploymentId,
    snapshot.homeWorkspaceId,
  ]);
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
  #projection = "";
  get retained(): boolean {
    return this.#listeners.size > 0;
  }
  constructor(
    client: HostClient,
    read: () => Promise<Wire>,
    present: (wire: Wire, snapshot: HostSnapshot) => Data,
    detail = false,
  ) {
    this.client = client;
    this.read = read;
    this.present = present;
    this.detail = detail;
  }
  // React reads before subscribing, including after a hidden screen changes readers.
  readonly getSnapshot = (): ScheduleState<Data> =>
    this.#readerScope === scheduleReaderScope(this.client.getSnapshot())
      ? this.#state
      : loadingScheduleState;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#unsubscribe = this.client.subscribe(() => this.#changed());
      this.#signature = "";
      this.#changed();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
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
  #changed(): void {
    const s = this.client.getSnapshot();
    const signature = JSON.stringify([
      scheduleReaderScope(s),
      s.connection,
      s.network,
      s.triggerRevision,
      this.detail ? s.runQueue.map(({ id, status }) => [id, status]) : null,
      this.detail ? s.threads.map(({ id, status }) => [id, status]) : null,
    ]);
    if (signature !== this.#signature) {
      this.#signature = signature;
      void this.refresh().catch(() => undefined);
    } else if (this.#wire !== undefined && this.#state.status === "ready") {
      const projection = JSON.stringify([
        s.homeThreadId,
        s.threads.map(({ id, title, icon, color }) => [id, title, icon, color]),
        s.tasks,
        s.activeTasks,
        s.workspaceTasks,
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
    this.#readerScope = readerScope;
    this.#wire = undefined;
    if (!scheduleOnline(snapshot)) {
      this.#publish({
        status: "offline",
        data: null,
        error: "Connect to the Host to view schedules.",
      });
      return;
    }
    this.#publish({ status: "loading", data: null, error: null });
    try {
      const wire = await this.read();
      if (
        version !== this.#version ||
        !scheduleOnline(this.client.getSnapshot()) ||
        readerScope !== scheduleReaderScope(this.client.getSnapshot())
      )
        return;
      this.#wire = wire;
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
  readonly workspaceId: string | undefined;
  constructor(client: HostClient, workspaceId?: string) {
    this.client = client;
    this.workspaceId = workspaceId;
    this.list = new ScheduleResource<readonly TriggerSummary[], readonly ScheduleItem[]>(
      client,
      async () =>
        unwrapRpcResult(await client.rpc["triggers.list"](workspaceId ? { workspaceId } : {}))
          .triggers,
      scheduleList,
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
export function schedulesClient(client: HostClient, workspaceId?: string): SchedulesClient {
  let workspaces = clients.get(client);
  if (!workspaces) {
    workspaces = new Map();
    clients.set(client, workspaces);
  }
  const key = workspaceId ?? "";
  let schedules = workspaces.get(key);
  if (!schedules) {
    schedules = new SchedulesClient(client, workspaceId);
    workspaces.set(key, schedules);
  }
  return schedules;
}
