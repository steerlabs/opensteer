import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  ThreadId,
  TriggerId,
  TriggerOccurrenceId,
  UserId,
  WorkspaceId,
} from "@opensteer/core";
import {
  OpensteerError,
  ThreadIdSchema,
  threadReachScope,
  type ThreadReachScope,
} from "@opensteer/core";
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

interface TriggerServiceOptions {
  /** The person's Chat, which an agent may anchor a Trigger to as "home". */
  readonly homeThread: (ownerId: UserId) => Promise<ThreadId | null>;
  readonly onChanged?: (workspaceId: TriggerOccurrence["event"]["trigger"]["workspaceId"]) => void;
  readonly onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly onWatchChanged?: (triggerId: TriggerId) => void;
  readonly publicUrl: URL;
  readonly store: TriggerStore;
  readonly runnerStore: TriggerProgramRunnerStore;
  readonly threads: Pick<OpensteerStore, "getThreadForOwner">;
  readonly tokens: Pick<SignedTokenService, "deriveSecret">;
}

export class TriggerService {
  readonly #homeThread: TriggerServiceOptions["homeThread"];
  readonly #onChanged: TriggerServiceOptions["onChanged"];
  readonly #onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly #onWatchChanged: TriggerServiceOptions["onWatchChanged"];
  readonly #publicUrl: URL;
  readonly #store: TriggerStore;
  readonly #runnerStore: TriggerProgramRunnerStore;
  readonly #threads: TriggerServiceOptions["threads"];
  readonly #tokens: Pick<SignedTokenService, "deriveSecret">;

  constructor(options: TriggerServiceOptions) {
    this.#homeThread = options.homeThread;
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
      readonly program: Parameters<TriggerStore["create"]>[0]["program"];
      readonly source: TriggerSource;
    },
    actorThreadId: ThreadId | null,
  ) {
    await this.#assertProgramCompatible(
      input.ownerId,
      input.anchorThreadId,
      input.program.toolContractVersion,
    );
    const webhookRouteKey =
      input.source.kind === "webhook" ? `wh_${randomBytes(24).toString("base64url")}` : undefined;
    const webhookSecret = webhookRouteKey ? this.#webhookSecret(webhookRouteKey) : undefined;
    const created = await this.#store.create({
      actorThreadId,
      anchorThreadId: input.anchorThreadId,
      createdBy: input.ownerId,
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      program: input.program,
      source: input.source,
      ...(webhookRouteKey
        ? {
            webhookRouteKey,
            webhookSecretHash: hashSecret(required(webhookSecret)),
          }
        : {}),
    });
    this.#onChanged?.(created.trigger.workspaceId);
    if (created.trigger.kind === "watch") this.#onWatchChanged?.(created.trigger.id);
    if (created.trigger.kind !== "webhook") return created;
    const stableRouteKey = required(created.trigger.webhookRouteKey ?? undefined);
    return {
      ...created,
      webhook: {
        secret: this.#webhookSecret(stableRouteKey),
        url: new URL(`/hooks/v1/${stableRouteKey}`, this.#publicUrl).toString(),
      },
    };
  }

  list(
    ownerId: UserId,
    input: {
      readonly limit?: number;
      readonly workspaceId?: Parameters<TriggerStore["listForOwner"]>[0]["workspaceId"];
      readonly anchorThreadId?: Parameters<TriggerStore["listForOwner"]>[0]["anchorThreadId"];
    },
    scope: ThreadReachScope,
  ) {
    return this.#store.listForOwner({
      ...(input.anchorThreadId === undefined ? {} : { anchorThreadId: input.anchorThreadId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ownerId,
      scope,
    });
  }

  async get(
    ownerId: UserId,
    triggerId: TriggerId,
    occurrenceLimit: number,
    scope: ThreadReachScope,
  ) {
    const detail = await this.#store.getForOwner(triggerId, ownerId, occurrenceLimit, scope);
    if (!detail) throw new OpensteerError({ code: "not_found", message: "Trigger not found" });
    return detail;
  }

  async update(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["update"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
  ) {
    const current = await this.get(
      ownerId,
      input.triggerId,
      1,
      await this.#readScope(ownerId, actorThreadId),
    );
    await this.#assertProgramCompatible(
      ownerId,
      current.trigger.anchorThreadId,
      (input.program ?? current.revision.program).toolContractVersion,
    );
    const updated = await this.#store.update({ ...input, ownerId, actorThreadId });
    this.#onChanged?.(updated.trigger.workspaceId);
    if (updated.trigger.kind === "watch") this.#onWatchChanged?.(updated.trigger.id);
    return updated;
  }

  async setStatus(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["setStatus"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
  ) {
    const trigger = await this.#store.setStatus({ ...input, ownerId, actorThreadId });
    this.#onChanged?.(trigger.workspaceId);
    if (trigger.kind === "watch") this.#onWatchChanged?.(trigger.id);
    return trigger;
  }

  async setNextFire(
    ownerId: UserId,
    input: Omit<Parameters<TriggerStore["setNextFire"]>[0], "ownerId" | "actorThreadId">,
    actorThreadId: ThreadId | null,
  ) {
    const trigger = await this.#store.setNextFire({ ...input, ownerId, actorThreadId });
    this.#onChanged?.(trigger.workspaceId);
    return trigger;
  }

  async run(
    ownerId: UserId,
    triggerId: TriggerId,
    payload: unknown,
    actorThreadId: ThreadId | null,
  ) {
    const occurrence = await this.#store.enqueueManual({
      ownerId,
      payload,
      triggerId,
      actorThreadId,
    });
    this.#onChanged?.(occurrence.event.trigger.workspaceId);
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
      throw new OpensteerError({ code: "not_found", message: "Webhook not found" });
    }
    const enqueued = await this.#store.enqueueWebhook(input);
    this.#onChanged?.(enqueued.occurrence.event.trigger.workspaceId);
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
  ) {
    const result = await this.#store.cancelPendingOccurrences(ownerId, { ...input, actorThreadId });
    if (result.canceledOccurrenceIds.length > 0 && this.#onChanged) {
      const detail = await this.get(
        ownerId,
        input.triggerId,
        1,
        await this.#readScope(ownerId, actorThreadId),
      );
      this.#onChanged(detail.trigger.workspaceId);
    }
    return result;
  }

  async manage(
    ownerId: UserId,
    value: TriggerControlInput,
    actorThreadId: ThreadId | null,
  ): Promise<unknown> {
    const input = TriggerControlInputSchema.parse(value);
    switch (input.operation) {
      case "create": {
        const anchorThreadId =
          input.anchorThreadId === "home"
            ? await this.#homeThread(ownerId)
            : ThreadIdSchema.parse(input.anchorThreadId);
        if (!anchorThreadId) {
          throw new OpensteerError({
            code: "bad_request",
            message: "Chat has not been started yet",
          });
        }
        return this.create({ ...input, anchorThreadId, ownerId }, actorThreadId);
      }
      case "list":
        return {
          triggers: await this.list(ownerId, input, await this.#readScope(ownerId, actorThreadId)),
        };
      case "get":
        return this.get(
          ownerId,
          input.triggerId,
          input.occurrenceLimit,
          await this.#readScope(ownerId, actorThreadId),
        );
      case "update":
        return this.update(
          ownerId,
          {
            expectedRevisionId: input.expectedRevisionId,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.program === undefined ? {} : { program: input.program }),
            ...(input.source === undefined ? {} : { source: input.source }),
            triggerId: input.triggerId,
          },
          actorThreadId,
        );
      case "set_status":
        return this.setStatus(ownerId, input, actorThreadId);
      case "set_next_fire":
        return this.setNextFire(
          ownerId,
          { triggerId: input.triggerId, nextFireAt: input.nextFireAt },
          actorThreadId,
        );
      case "run":
        return {
          occurrence: await this.run(ownerId, input.triggerId, input.payload, actorThreadId),
        };
      case "cancel":
        return this.cancel(
          ownerId,
          {
            ...(input.occurrenceId === undefined ? {} : { occurrenceId: input.occurrenceId }),
            triggerId: input.triggerId,
          },
          actorThreadId,
        );
    }
  }

  async #assertProgramCompatible(
    ownerId: UserId,
    anchorThreadId: ThreadId,
    version: 1 | 2 | 3,
  ): Promise<void> {
    if (version !== 3) return;
    const anchor = await this.#threads.getThreadForOwner(anchorThreadId, ownerId);
    if (!anchor)
      throw new OpensteerError({ code: "not_found", message: "Anchor Thread not found" });
    const reason = await triggerProgramCompatibilityReason(
      this.#runnerStore,
      anchor.environmentId,
      version,
    );
    if (reason) throw new OpensteerError({ code: "bad_request", message: reason });
  }

  async #readScope(ownerId: UserId, actorThreadId: ThreadId | null): Promise<ThreadReachScope> {
    if (actorThreadId === null) return { kind: "user" };
    const actor = await this.#threads.getThreadForOwner(actorThreadId, ownerId);
    if (!actor)
      throw new OpensteerError({ code: "forbidden", message: "Calling Thread is unavailable" });
    return threadReachScope(actor);
  }

  #webhookSecret(routeKey: string): string {
    return `oswh_${this.#tokens.deriveSecret("webhook", routeKey)}`;
  }
}

export class TriggerScheduleLoop {
  readonly #onChanged: (workspaceId: WorkspaceId) => void;
  readonly #onError: (error: unknown) => void;
  readonly #onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
  readonly #store: Pick<TriggerStore, "claimDueSchedules">;
  #closed = false;
  #running: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    /** A due Trigger was paused or moved on to its next instant. */
    readonly onChanged: (workspaceId: WorkspaceId) => void;
    readonly onError: (error: unknown) => void;
    readonly onOccurrenceQueued: (occurrence: TriggerOccurrence) => void;
    readonly store: Pick<TriggerStore, "claimDueSchedules">;
  }) {
    this.#onChanged = options.onChanged;
    this.#onError = options.onError;
    this.#onOccurrenceQueued = options.onOccurrenceQueued;
    this.#store = options.store;
  }

  start(): void {
    if (this.#closed || this.#timer || this.#running) return;
    this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.#tick().finally(() => {
        this.#running = undefined;
        if (!this.#closed) this.#schedule(1_000);
      });
    }, delayMs);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    try {
      const { occurrences, workspaceIds } = await this.#store.claimDueSchedules();
      for (const occurrence of occurrences) this.#onOccurrenceQueued(occurrence);
      const queued = new Set(occurrences.map(({ event }) => event.trigger.workspaceId));
      for (const workspaceId of workspaceIds) {
        if (!queued.has(workspaceId)) this.#onChanged(workspaceId);
      }
    } catch (error) {
      this.#onError(error);
    }
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
