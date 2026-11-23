import { createHash, randomBytes } from "node:crypto";
import type {
  ThreadAccessMode,
  ThreadId,
  TriggerId,
  TriggerOccurrenceId,
  UserId,
} from "@opensteer/core";
import { isLoopbackHostname, OpensteerError, ThreadIdSchema } from "@opensteer/core";
import type {
  OpensteerStore,
  RunningFiringRef,
  TaskReader,
  TriggerStore,
} from "@opensteer/database";
import { personTaskReader } from "@opensteer/database";
import {
  TriggerControlInputSchema,
  type TriggerControlInput,
  type TriggerOccurrence,
  type TriggerSource,
} from "@opensteer/triggers";
import {
  triggerProgramCompatibilityReason,
  type TriggerProgramRunnerStore,
} from "./trigger-program-compatibility.js";
import type { SignedTokenService } from "../identity/host-keys.js";
import type { Clock } from "@opensteer/shared/clock";
import { DeadlineDrain, retryWithBackoff } from "../runtime/deadline-drain.js";
interface TriggerServiceOptions {
  readonly onChanged?: () => void;
  readonly onInterruptFiring?: (firing: RunningFiringRef) => void;
  readonly onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly onWatchChanged?: (triggerId: TriggerId) => void;
  readonly publicUrl: URL;
  /** Live public tunnel/remote origin when Personal Remote Access is active (Y3). */
  readonly remoteOrigin?: () => Promise<string | null>;
  readonly store: TriggerStore;
  readonly runnerStore: TriggerProgramRunnerStore;
  readonly threads: Pick<OpensteerStore, "readTask">;
  readonly tokens: Pick<SignedTokenService, "deriveSecret">;
}
export class TriggerService {
  readonly #onChanged: TriggerServiceOptions["onChanged"];
  readonly #onInterruptFiring: TriggerServiceOptions["onInterruptFiring"];
  readonly #onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly #onWatchChanged: TriggerServiceOptions["onWatchChanged"];
  readonly #publicUrl: URL;
  readonly #remoteOrigin: (() => Promise<string | null>) | undefined;
  readonly #store: TriggerStore;
  readonly #runnerStore: TriggerProgramRunnerStore;
  readonly #threads: TriggerServiceOptions["threads"];
  readonly #tokens: Pick<SignedTokenService, "deriveSecret">;
  constructor(options: TriggerServiceOptions) {
    this.#onChanged = options.onChanged;
    this.#onInterruptFiring = options.onInterruptFiring;
    this.#onOccurrenceQueued = options.onOccurrenceQueued;
    this.#onWatchChanged = options.onWatchChanged;
    this.#publicUrl = options.publicUrl;
    this.#remoteOrigin = options.remoteOrigin;
    this.#store = options.store;
    this.#runnerStore = options.runnerStore;
    this.#threads = options.threads;
    this.#tokens = options.tokens;
  }
  async resolveWebhookAddress(routeKey: string): Promise<{
    readonly scope: "public" | "local";
    readonly url: string;
  }> {
    const remote = await this.#remoteOrigin?.().catch(() => null);
    const origin = remote ? new URL(remote) : this.#publicUrl;
    return {
      scope: isLoopbackHostname(origin.hostname) ? "local" : "public",
      url: new URL(`/hooks/v1/${routeKey}`, origin).toString(),
    };
  }
  async create(
    input: {
      readonly anchorThreadId: Parameters<TriggerStore["create"]>[0]["anchorThreadId"];
      readonly idempotencyKey: string;
      readonly name: string;
      readonly ownerId: UserId;
      readonly ownTask?: true | undefined;
      readonly program: Parameters<TriggerStore["create"]>[0]["program"];
      readonly source: TriggerSource;
    },
    actorThreadId: ThreadId | null,
    actorAccessMode?: ThreadAccessMode,
    actorConnectionId?: string,
  ) {
    await this.#assertProgramCompatible(
      input.ownerId,
      input.anchorThreadId,
      input.program.toolContractVersion,
      actorReader(actorThreadId),
    );
    const webhookRouteKey =
      input.source.kind === "webhook" ? `whk_${randomBytes(32).toString("base64url")}` : undefined;
    const webhookSecret = webhookRouteKey ? this.#webhookSecret(webhookRouteKey) : undefined;
    const { trigger, revision, wasDuplicate } = await this.#store.create({
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
      anchorThreadId: input.anchorThreadId,
      createdBy: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      ...(input.ownTask ? { ownTask: true } : {}),
      program: input.program,
      source: input.source,
      ...(webhookRouteKey
        ? {
            webhookRouteKey,
            webhookSecretHash: hashSecret(required(webhookSecret)),
          }
        : {}),
    });
    this.#onChanged?.();
    const result = { trigger, revision, wasDuplicate };
    if (result.trigger.kind === "watch") this.#onWatchChanged?.(result.trigger.id);
    if (result.trigger.kind !== "webhook") return result;
    const stableRouteKey = required(result.trigger.webhookRouteKey ?? undefined);
    const address = await this.resolveWebhookAddress(stableRouteKey);
    return {
      ...result,
      webhook: {
        scope: address.scope,
        secret: this.#webhookSecret(stableRouteKey),
        url: address.url,
      },
    };
  }
  async rotateWebhookKey(
    ownerId: UserId,
    triggerId: TriggerId,
    actorThreadId: ThreadId | null,
    actorAccessMode?: ThreadAccessMode,
    actorConnectionId?: string,
  ) {
    const webhookRouteKey = `whk_${randomBytes(32).toString("base64url")}`;
    const webhookSecret = this.#webhookSecret(webhookRouteKey);
    const trigger = await this.#store.rotateWebhookKey({
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
      ownerId,
      triggerId,
      webhookRouteKey,
      webhookSecretHash: hashSecret(webhookSecret),
    });
    this.#onChanged?.();
    const address = await this.resolveWebhookAddress(webhookRouteKey);
    return {
      trigger,
      webhook: {
        scope: address.scope,
        url: address.url,
      },
    };
  }
  list(
    ownerId: UserId,
    input: {
      readonly systemRole?: Parameters<TriggerStore["listForOwner"]>[0]["systemRole"];
      readonly limit?: number;
      readonly anchorThreadId?: Parameters<TriggerStore["listForOwner"]>[0]["anchorThreadId"];
      readonly originConnectionId?: string;
      /** Who reads: a memory pass's lineage sees only automations with personal context. */
      readonly reader: TaskReader;
    },
  ) {
    return this.#store.listForOwner({
      reader: input.reader,
      ...(input.originConnectionId === undefined
        ? {}
        : { originConnectionId: input.originConnectionId }),
      ...(input.systemRole
        ? {
            systemRole: input.systemRole,
          }
        : {}),
      ...(input.anchorThreadId === undefined
        ? {}
        : {
            anchorThreadId: input.anchorThreadId,
          }),
      ...(input.limit === undefined
        ? {}
        : {
            limit: input.limit,
          }),
      ownerId,
    });
  }
  async get(ownerId: UserId, triggerId: TriggerId, occurrenceLimit: number, reader: TaskReader) {
    const detail = await this.#store.getForOwner(triggerId, ownerId, occurrenceLimit, reader);
    if (!detail)
      throw new OpensteerError({
        code: "not_found",
        message: "Automation not found",
      });
    return detail;
  }
  async update(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["update"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
    actorAccessMode?: ThreadAccessMode,
    actorConnectionId?: string,
  ) {
    const current = await this.get(ownerId, input.triggerId, 1, actorReader(actorThreadId));
    await this.#assertProgramCompatible(
      ownerId,
      current.trigger.anchorThreadId,
      (input.program ?? current.revision.program).toolContractVersion,
      actorReader(actorThreadId),
    );
    const updated = await this.#store.update({
      ...input,
      ownerId,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
    });
    this.#onChanged?.();
    if (updated.trigger.kind === "watch") this.#onWatchChanged?.(updated.trigger.id);
    return updated;
  }
  async setStatus(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["setStatus"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
    actorAccessMode?: ThreadAccessMode,
    actorConnectionId?: string,
  ) {
    const result = await this.#store.setStatusWithEffects({
      ...input,
      ownerId,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
    });
    const { trigger } = result;
    this.#onChanged?.();
    if (trigger.kind === "watch") this.#onWatchChanged?.(trigger.id);
    for (const firing of result.runningFirings) {
      this.#onInterruptFiring?.(firing);
    }
    return trigger;
  }
  async setNextFire(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["setNextFire"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
    actorAccessMode?: ThreadAccessMode,
    actorConnectionId?: string,
  ) {
    const trigger = await this.#store.setNextFire({
      ...input,
      ownerId,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
    });
    this.#onChanged?.();
    return trigger;
  }
  async run(
    ownerId: UserId,
    triggerId: TriggerId,
    payload: unknown,
    actorThreadId: ThreadId | null,
    idempotencyKey?: string,
    actorAccessMode?: ThreadAccessMode,
    actorConnectionId?: string,
  ) {
    const occurrence = await this.#store.enqueueManual({
      ...(idempotencyKey === undefined
        ? {}
        : {
            idempotencyKey,
          }),
      ownerId,
      payload,
      triggerId,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
    });
    this.#onChanged?.();
    this.#onOccurrenceQueued(occurrence);
    return occurrence;
  }
  async acceptWebhook(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly path?: string;
    readonly payload?: unknown;
    readonly query?: Readonly<Record<string, string | readonly string[]>>;
    readonly rawBody?: Buffer | null;
    readonly routeKey: string;
  }) {
    const enqueued = await this.#store.enqueueWebhook(input);
    this.#onChanged?.();
    this.#onOccurrenceQueued(enqueued.occurrence);
    return enqueued;
  }
  async cancel(
    ownerId: UserId,
    input: {
      readonly occurrenceId?: TriggerOccurrenceId;
      readonly triggerId: TriggerId;
    },
    actorThreadId: ThreadId | null,
    actorAccessMode?: ThreadAccessMode,
    actorConnectionId?: string,
  ) {
    const result = await this.#store.cancelPendingOccurrences(ownerId, {
      ...input,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
    });
    if (result.canceledOccurrenceIds.length > 0 && this.#onChanged) {
      this.#onChanged();
    }
    return result;
  }
  async manage(
    ownerId: UserId,
    value: TriggerControlInput,
    actorThreadId: ThreadId | null,
    context?: {
      readonly accessMode: ThreadAccessMode;
      readonly operationKey?: string;
      /** A selected grant lists only its own lineage's automations. */
      readonly originConnectionId?: string;
      /** The external agent connection the actor works for. */
      readonly agentConnectionId?: string;
    },
  ): Promise<unknown> {
    const input = TriggerControlInputSchema.parse(value);
    switch (input.operation) {
      case "create": {
        const anchorThreadId = ThreadIdSchema.parse(input.anchorThreadId);
        return this.create(
          {
            ...input,
            anchorThreadId,
            ownerId,
          },
          actorThreadId,
          context?.accessMode,
          context?.agentConnectionId,
        );
      }
      case "list":
        return {
          triggers: await this.list(ownerId, {
            ...input,
            reader: actorReader(actorThreadId),
            ...(context?.originConnectionId
              ? { originConnectionId: context.originConnectionId }
              : {}),
          }),
        };
      case "get":
        return this.get(
          ownerId,
          input.triggerId,
          input.occurrenceLimit,
          actorReader(actorThreadId),
        );
      case "update":
        return this.update(
          ownerId,
          {
            expectedRevisionId: input.expectedRevisionId,
            ...(input.name === undefined
              ? {}
              : {
                  name: input.name,
                }),
            ...(input.program === undefined
              ? {}
              : {
                  program: input.program,
                }),
            ...(input.source === undefined
              ? {}
              : {
                  source: input.source,
                }),
            triggerId: input.triggerId,
          },
          actorThreadId,
          context?.accessMode,
          context?.agentConnectionId,
        );
      case "set_status":
        return this.setStatus(
          ownerId,
          input,
          actorThreadId,
          context?.accessMode,
          context?.agentConnectionId,
        );
      case "set_next_fire":
        return this.setNextFire(
          ownerId,
          {
            triggerId: input.triggerId,
            nextFireAt: input.nextFireAt,
          },
          actorThreadId,
          context?.accessMode,
          context?.agentConnectionId,
        );
      case "run":
        return {
          occurrence: await this.run(
            ownerId,
            input.triggerId,
            input.payload,
            actorThreadId,
            context?.operationKey,
            context?.accessMode,
            context?.agentConnectionId,
          ),
        };
      case "cancel":
        return this.cancel(
          ownerId,
          {
            ...(input.occurrenceId === undefined
              ? {}
              : {
                  occurrenceId: input.occurrenceId,
                }),
            triggerId: input.triggerId,
          },
          actorThreadId,
          context?.accessMode,
          context?.agentConnectionId,
        );
    }
  }
  async #assertProgramCompatible(
    ownerId: UserId,
    anchorThreadId: ThreadId,
    version: number,
    reader: TaskReader,
  ): Promise<void> {
    const anchor = await this.#threads.readTask(reader, anchorThreadId, ownerId);
    if (!anchor)
      throw new OpensteerError({
        code: "not_found",
        message: "Task not found",
      });
    const reason = await triggerProgramCompatibilityReason(
      this.#runnerStore,
      anchor.environmentId,
      version,
    );
    if (reason)
      throw new OpensteerError({
        code: "bad_request",
        message: reason,
      });
  }
  #webhookSecret(routeKey: string): string {
    return `oswh_${this.#tokens.deriveSecret("webhook", routeKey)}`;
  }
}
/**
 * Fires due schedules at the earliest armed `next_fire_at`, and again whenever
 * a commit moves one (`triggerSchedulesChanged`). Nothing polls.
 */
export class TriggerScheduleLoop {
  readonly #onChanged: () => void;
  readonly #onError: (error: unknown) => void;
  readonly #onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly #store: Pick<TriggerStore, "claimDueSchedules" | "nextScheduleAt">;
  readonly #drain: DeadlineDrain;
  constructor(options: {
    /** A due Trigger was paused or moved on to its next instant. */
    readonly onChanged: () => void;
    readonly onError: (error: unknown) => void;
    readonly onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
    readonly store: Pick<TriggerStore, "claimDueSchedules" | "nextScheduleAt">;
    readonly clock?: Clock;
  }) {
    this.#onChanged = options.onChanged;
    this.#onError = options.onError;
    this.#onOccurrenceQueued = options.onOccurrenceQueued;
    this.#store = options.store;
    this.#drain = new DeadlineDrain({
      drain: () => this.#tick(),
      onError: options.onError,
      ...(options.clock ? { clock: options.clock } : {}),
    });
  }
  start(): void {
    this.#drain.start();
  }
  wake(): void {
    this.#drain.wake();
  }
  async close(): Promise<void> {
    await this.#drain.close();
  }
  async #tick(): Promise<Date | typeof retryWithBackoff | null> {
    const now = Date.now();
    // One time for the claim and the "still due" comparison below.
    const { occurrences, changed, failures } = await this.#store.claimDueSchedules(new Date(now));
    // A schedule that could not be claimed rolled back alone; the rest committed.
    for (const failure of failures) this.#onError(failure);
    for (const occurrence of occurrences) this.#onOccurrenceQueued(occurrence);
    if (changed) this.#onChanged();
    const next = await this.#store.nextScheduleAt();
    // A due schedule this pass could not claim (another transaction holds it)
    // backs off rather than spinning; one that it moved on is simply re-armed.
    return next && next.getTime() <= now && !changed ? retryWithBackoff : next;
  }
}
function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function required(value: string | undefined): string {
  if (!value) throw new Error("Webhook identity is missing");
  return value;
}

/** Work acting from a task reads as that task; the person and a connected agent as themselves. */
function actorReader(actorThreadId: ThreadId | null): TaskReader {
  return actorThreadId === null ? personTaskReader : { kind: "work", threadId: actorThreadId };
}
