import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ThreadAccessMode,
  ThreadId,
  TriggerId,
  TriggerOccurrenceId,
  UserId,
} from "@opensteer/core";
import { OpensteerError, ThreadIdSchema } from "@opensteer/core";
import type { OpensteerStore, TriggerStore } from "@opensteer/database";
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
  readonly onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly onWatchChanged?: (triggerId: TriggerId) => void;
  readonly publicUrl: URL;
  readonly store: TriggerStore;
  readonly runnerStore: TriggerProgramRunnerStore;
  readonly threads: Pick<OpensteerStore, "getThreadForOwner">;
  readonly tokens: Pick<SignedTokenService, "deriveSecret">;
}
export class TriggerService {
  readonly #onChanged: TriggerServiceOptions["onChanged"];
  readonly #onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly #onWatchChanged: TriggerServiceOptions["onWatchChanged"];
  readonly #publicUrl: URL;
  readonly #store: TriggerStore;
  readonly #runnerStore: TriggerProgramRunnerStore;
  readonly #threads: TriggerServiceOptions["threads"];
  readonly #tokens: Pick<SignedTokenService, "deriveSecret">;
  constructor(options: TriggerServiceOptions) {
    this.#onChanged = options.onChanged;
    this.#onOccurrenceQueued = options.onOccurrenceQueued;
    this.#onWatchChanged = options.onWatchChanged;
    this.#publicUrl = options.publicUrl;
    this.#store = options.store;
    this.#runnerStore = options.runnerStore;
    this.#threads = options.threads;
    this.#tokens = options.tokens;
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
  ) {
    await this.#assertProgramCompatible(
      input.ownerId,
      input.anchorThreadId,
      input.program.toolContractVersion,
    );
    const webhookRouteKey =
      input.source.kind === "webhook" ? `wh_${randomBytes(24).toString("base64url")}` : undefined;
    const webhookSecret = webhookRouteKey ? this.#webhookSecret(webhookRouteKey) : undefined;
    const { trigger, revision, wasDuplicate } = await this.#store.create({
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
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
    return {
      ...result,
      webhook: {
        secret: this.#webhookSecret(stableRouteKey),
        url: new URL(`/hooks/v1/${stableRouteKey}`, this.#publicUrl).toString(),
      },
    };
  }
  list(
    ownerId: UserId,
    input: {
      readonly systemRole?: Parameters<TriggerStore["listForOwner"]>[0]["systemRole"];
      readonly limit?: number;
      readonly anchorThreadId?: Parameters<TriggerStore["listForOwner"]>[0]["anchorThreadId"];
    },
  ) {
    return this.#store.listForOwner({
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
  async get(ownerId: UserId, triggerId: TriggerId, occurrenceLimit: number) {
    const detail = await this.#store.getForOwner(triggerId, ownerId, occurrenceLimit);
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
  ) {
    const current = await this.get(ownerId, input.triggerId, 1);
    await this.#assertProgramCompatible(
      ownerId,
      current.trigger.anchorThreadId,
      (input.program ?? current.revision.program).toolContractVersion,
    );
    const updated = await this.#store.update({
      ...input,
      ownerId,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
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
  ) {
    const trigger = await this.#store.setStatus({
      ...input,
      ownerId,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
    });
    this.#onChanged?.();
    if (trigger.kind === "watch") this.#onWatchChanged?.(trigger.id);
    return trigger;
  }
  async setNextFire(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["setNextFire"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
    actorAccessMode?: ThreadAccessMode,
  ) {
    const trigger = await this.#store.setNextFire({
      ...input,
      ownerId,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
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
    });
    this.#onChanged?.();
    this.#onOccurrenceQueued(occurrence);
    return occurrence;
  }
  async acceptWebhook(input: {
    readonly deliveryId?: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly payload: unknown;
    readonly routeKey: string;
    readonly secret: string;
  }) {
    const route = await this.#store.webhookRoute(input.routeKey);
    if (!route || !sameSecret(route.secretHash, input.secret)) {
      throw new OpensteerError({
        code: "not_found",
        message: "Webhook not found",
      });
    }
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
  ) {
    const result = await this.#store.cancelPendingOccurrences(ownerId, {
      ...input,
      actorThreadId,
      ...(actorAccessMode ? { actorAccessMode } : {}),
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
        );
      }
      case "list":
        return {
          triggers: await this.list(ownerId, input),
        };
      case "get":
        return this.get(ownerId, input.triggerId, input.occurrenceLimit);
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
        );
      case "set_status":
        return this.setStatus(ownerId, input, actorThreadId, context?.accessMode);
      case "set_next_fire":
        return this.setNextFire(
          ownerId,
          {
            triggerId: input.triggerId,
            nextFireAt: input.nextFireAt,
          },
          actorThreadId,
          context?.accessMode,
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
        );
    }
  }
  async #assertProgramCompatible(
    ownerId: UserId,
    anchorThreadId: ThreadId,
    version: number,
  ): Promise<void> {
    const anchor = await this.#threads.getThreadForOwner(anchorThreadId, ownerId);
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
    const { occurrences, changed } = await this.#store.claimDueSchedules();
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
function sameSecret(expectedHash: string, candidate: string): boolean {
  const actual = Buffer.from(hashSecret(candidate), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function required(value: string | undefined): string {
  if (!value) throw new Error("Webhook identity is missing");
  return value;
}
