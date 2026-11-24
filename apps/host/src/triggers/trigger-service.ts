import { randomBytes } from "node:crypto";
import type { ThreadId, TriggerId, TriggerOccurrenceId, UserId } from "@opensteer/core";
import { isLoopbackHostname, OpensteerError, ThreadIdSchema } from "@opensteer/core";
import type {
  CommandIdentity,
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
  type TriggerWebhookAddress,
} from "@opensteer/triggers";
import {
  automationScriptCompatibilityReason,
  type AutomationScriptRunnerStore,
} from "./automation-script-compatibility.js";
import type { AutomationSecrets } from "./automation-secrets.js";
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
  readonly secrets?:
    | (Pick<AutomationSecrets, "apply" | "names"> &
        Partial<Pick<AutomationSecrets, "applyWithMeta">>)
    | undefined;
  readonly store: TriggerStore;
  readonly runnerStore: AutomationScriptRunnerStore;
  readonly threads: Pick<OpensteerStore, "readTask">;
}
export class TriggerService {
  readonly #onChanged: TriggerServiceOptions["onChanged"];
  readonly #onInterruptFiring: TriggerServiceOptions["onInterruptFiring"];
  readonly #onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly #onWatchChanged: TriggerServiceOptions["onWatchChanged"];
  readonly #publicUrl: URL;
  readonly #remoteOrigin: (() => Promise<string | null>) | undefined;
  readonly #secrets: TriggerServiceOptions["secrets"];
  readonly #store: TriggerStore;
  readonly #runnerStore: AutomationScriptRunnerStore;
  readonly #threads: TriggerServiceOptions["threads"];
  constructor(options: TriggerServiceOptions) {
    this.#onChanged = options.onChanged;
    this.#onInterruptFiring = options.onInterruptFiring;
    this.#onOccurrenceQueued = options.onOccurrenceQueued;
    this.#onWatchChanged = options.onWatchChanged;
    this.#publicUrl = options.publicUrl;
    this.#remoteOrigin = options.remoteOrigin;
    this.#secrets = options.secrets;
    this.#store = options.store;
    this.#runnerStore = options.runnerStore;
    this.#threads = options.threads;
  }
  async #resolveWebhookOrigin(): Promise<{
    readonly origin: URL;
    readonly scope: "public" | "local";
  }> {
    const remote = await this.#remoteOrigin?.().catch(() => null);
    const origin = remote ? new URL(remote) : this.#publicUrl;
    return {
      origin,
      scope: isLoopbackHostname(origin.hostname) ? "local" : "public",
    };
  }
  async resolveWebhookAddress(routeKey: string): Promise<{
    readonly scope: "public" | "local";
    readonly url: string;
  }> {
    const { origin, scope } = await this.#resolveWebhookOrigin();
    return {
      scope,
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
      readonly script: Parameters<TriggerStore["create"]>[0]["script"];
      readonly source: TriggerSource;
    },
    actorThreadId: ThreadId | null,
    commandIdentity?: Pick<CommandIdentity, "admit">,
    actorConnectionId?: string,
  ) {
    await this.#assertScriptCompatible(
      input.ownerId,
      input.anchorThreadId,
      actorReader(actorThreadId),
    );
    const webhookRouteKey =
      input.source.kind === "webhook" ? `whk_${randomBytes(32).toString("base64url")}` : undefined;
    const { trigger, revision, wasDuplicate } = await this.#store.create({
      actorThreadId,
      ...(commandIdentity ? { commandIdentity } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
      anchorThreadId: input.anchorThreadId,
      createdBy: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      ...(input.ownTask ? { ownTask: true } : {}),
      script: input.script,
      source: input.source,
      ...(webhookRouteKey ? { webhookRouteKey } : {}),
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
        url: address.url,
      },
    };
  }
  async list(
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
    const triggers = await this.#store.listForOwner({
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
    const hasWebhook = triggers.some((item) => item.kind === "webhook");
    const resolved = hasWebhook && this.#publicUrl ? await this.#resolveWebhookOrigin() : null;
    return triggers.map((item) => {
      const webhook: TriggerWebhookAddress | null =
        item.kind === "webhook" && resolved
          ? {
              scope: resolved.scope,
              url: item.webhookRouteKey
                ? new URL(`/hooks/v1/${item.webhookRouteKey}`, resolved.origin).toString()
                : null,
            }
          : null;
      return { ...item, webhook };
    });
  }
  async get(
    ownerId: UserId,
    triggerId: TriggerId,
    occurrenceLimit: number,
    reader: TaskReader,
    originConnectionId?: string,
  ) {
    const detail = await this.#store.getForOwner(
      triggerId,
      ownerId,
      occurrenceLimit,
      reader,
      originConnectionId,
    );
    if (!detail)
      throw new OpensteerError({
        code: "not_found",
        message: "Automation not found",
      });
    const webhook: TriggerWebhookAddress | null =
      detail.trigger.kind === "webhook" && this.#publicUrl
        ? detail.trigger.webhookRouteKey
          ? await this.resolveWebhookAddress(detail.trigger.webhookRouteKey)
          : { scope: (await this.#resolveWebhookOrigin()).scope, url: null }
        : null;
    let secretNames: string[] = [];
    if (this.#secrets) {
      const storedNames = this.#store.getSecretNames
        ? await this.#store.getSecretNames(ownerId, detail.trigger.id)
        : null;
      if (storedNames && storedNames.length > 0) {
        secretNames = [...storedNames];
      } else if (this.#store.getEncryptedSecrets) {
        const envelope = await this.#store.getEncryptedSecrets(ownerId, detail.trigger.id);
        if (envelope) {
          try {
            secretNames = [...(await this.#secrets.names(detail.trigger.id, envelope))];
          } catch {
            secretNames = [];
          }
        }
      }
    }
    return { ...detail, secretNames, webhook };
  }
  async update(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["update"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
    commandIdentity?: Pick<CommandIdentity, "admit">,
    actorConnectionId?: string,
  ) {
    const current = await this.get(ownerId, input.triggerId, 1, actorReader(actorThreadId));
    await this.#assertScriptCompatible(
      ownerId,
      current.trigger.anchorThreadId,
      actorReader(actorThreadId),
    );
    const updated = await this.#store.update({
      ...input,
      ownerId,
      actorThreadId,
      ...(commandIdentity ? { commandIdentity } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
    });
    this.#onChanged?.();
    if (updated.trigger.kind === "watch") this.#onWatchChanged?.(updated.trigger.id);
    return updated;
  }
  async setSecrets(
    ownerId: UserId,
    input: {
      readonly remove?: readonly string[] | undefined;
      readonly set?: Readonly<Record<string, string>> | undefined;
      readonly triggerId: TriggerId;
    },
    actorThreadId: ThreadId | null,
    commandIdentity?: CommandIdentity | Pick<CommandIdentity, "admit">,
    actorConnectionId?: string,
  ): Promise<{ readonly secretNames: readonly string[] }> {
    const secrets = this.#secrets;
    if (!secrets) {
      throw new OpensteerError({
        code: "internal",
        message: "Automation secrets are unavailable.",
      });
    }
    const hasSet = input.set !== undefined && Object.keys(input.set).length > 0;
    const hasRemove = input.remove !== undefined && input.remove.length > 0;
    if (!hasSet && !hasRemove) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Provide at least one secret to set or remove.",
      });
    }
    const {
      changed,
      result: secretNames,
      trigger,
    } = await this.#store.updateEncryptedSecrets({
      actorThreadId,
      ownerId,
      triggerId: input.triggerId,
      ...(commandIdentity ? { commandIdentity } : {}),
      ...(actorConnectionId ? { actorConnectionId } : {}),
      transform: async (current) => {
        if (secrets.applyWithMeta) {
          const applied = await secrets.applyWithMeta(input.triggerId, current, {
            ...(input.remove ? { remove: input.remove } : {}),
            ...(input.set ? { set: input.set } : {}),
          });
          return {
            changed: applied.changed,
            names: applied.names,
            result: applied.names,
            sealed: applied.sealed,
          };
        }
        const sealed = await secrets.apply(input.triggerId, current, {
          ...(input.remove ? { remove: input.remove } : {}),
          ...(input.set ? { set: input.set } : {}),
        });
        const names = await secrets.names(input.triggerId, sealed?.envelope ?? null);
        return { changed: true, names, result: names, sealed };
      },
    });
    if (changed !== false) {
      this.#onChanged?.();
      if (trigger.kind === "watch") this.#onWatchChanged?.(trigger.id);
    }
    return { secretNames };
  }
  async setStatus(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["setStatus"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
    commandIdentity?: Pick<CommandIdentity, "admit">,
    actorConnectionId?: string,
  ) {
    const result = await this.#store.setStatusWithEffects({
      ...input,
      ownerId,
      actorThreadId,
      ...(commandIdentity ? { commandIdentity } : {}),
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
    commandIdentity?: Pick<CommandIdentity, "admit">,
    actorConnectionId?: string,
  ) {
    const trigger = await this.#store.setNextFire({
      ...input,
      ownerId,
      actorThreadId,
      ...(commandIdentity ? { commandIdentity } : {}),
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
    commandIdentity?: Pick<CommandIdentity, "admit">,
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
      ...(commandIdentity ? { commandIdentity } : {}),
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
    commandIdentity?: Pick<CommandIdentity, "admit">,
    actorConnectionId?: string,
  ) {
    const result = await this.#store.cancelPendingOccurrences(ownerId, {
      ...input,
      actorThreadId,
      ...(commandIdentity ? { commandIdentity } : {}),
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
      readonly commandIdentity?: Pick<CommandIdentity, "admit">;
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
          context?.commandIdentity,
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
          context?.originConnectionId,
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
            ...(input.script === undefined
              ? {}
              : {
                  script: input.script,
                }),
            ...(input.source === undefined
              ? {}
              : {
                  source: input.source,
                }),
            triggerId: input.triggerId,
          },
          actorThreadId,
          context?.commandIdentity,
          context?.agentConnectionId,
        );
      case "set_status":
        return this.setStatus(
          ownerId,
          input,
          actorThreadId,
          context?.commandIdentity,
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
          context?.commandIdentity,
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
            context?.commandIdentity,
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
          context?.commandIdentity,
          context?.agentConnectionId,
        );
    }
  }
  async #assertScriptCompatible(
    ownerId: UserId,
    anchorThreadId: ThreadId,
    reader: TaskReader,
  ): Promise<void> {
    const anchor = await this.#threads.readTask(reader, anchorThreadId, ownerId);
    if (!anchor)
      throw new OpensteerError({
        code: "not_found",
        message: "Task not found",
      });
    const reason = await automationScriptCompatibilityReason(
      this.#runnerStore,
      anchor.environmentId,
    );
    if (reason)
      throw new OpensteerError({
        code: "bad_request",
        message: reason,
      });
  }
}
/**
 * Fires due schedules at the earliest armed `next_fire_at`, and again whenever
 * a commit moves one (`triggerSchedulesChanged`). Nothing polls.
 */
export class TriggerScheduleLoop {
  readonly #onChanged: () => void;
  readonly #onError: (error: unknown) => void;
  readonly #onInterruptFiring: ((firing: RunningFiringRef) => void) | undefined;
  readonly #onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly #store: Pick<TriggerStore, "claimDueSchedules" | "nextScheduleAt">;
  readonly #drain: DeadlineDrain;
  constructor(options: {
    /** A due Trigger was paused or moved on to its next instant. */
    readonly onChanged: () => void;
    readonly onError: (error: unknown) => void;
    readonly onInterruptFiring?: (firing: RunningFiringRef) => void;
    readonly onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
    readonly store: Pick<TriggerStore, "claimDueSchedules" | "nextScheduleAt">;
    readonly clock?: Clock;
  }) {
    this.#onChanged = options.onChanged;
    this.#onError = options.onError;
    this.#onInterruptFiring = options.onInterruptFiring;
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
    const { occurrences, changed, failures, runningFirings } = await this.#store.claimDueSchedules(
      new Date(now),
    );
    // A schedule that could not be claimed rolled back alone; the rest committed.
    for (const failure of failures) this.#onError(failure);
    for (const occurrence of occurrences) this.#onOccurrenceQueued(occurrence);
    for (const firing of runningFirings ?? []) this.#onInterruptFiring?.(firing);
    if (changed) this.#onChanged();
    const next = await this.#store.nextScheduleAt();
    // A due schedule this pass could not claim (another transaction holds it)
    // backs off rather than spinning; one that it moved on is simply re-armed.
    return next && next.getTime() <= now && !changed ? retryWithBackoff : next;
  }
}
function required(value: string | undefined): string {
  if (!value) throw new Error("Webhook identity is missing");
  return value;
}

/** Work acting from a task reads as that task; the person and a connected agent as themselves. */
function actorReader(actorThreadId: ThreadId | null): TaskReader {
  return actorThreadId === null ? personTaskReader : { kind: "work", threadId: actorThreadId };
}
