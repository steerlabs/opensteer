import {
  OpensteerError,
  harnessUsageLimitFailureCode,
  type AgentEvent,
  type EnvironmentId,
  type HarnessInstanceId,
} from "@opensteer/core";
import type { HarnessInstanceRecord } from "@opensteer/database";
import type { HarnessInstanceCatalog, HostToRunnerMessage } from "@opensteer/protocol";

export type HarnessInspectionDefinitions = Extract<
  HostToRunnerMessage,
  { readonly type: "host.reconcile-harnesses" }
>["harnesses"];

/** A read of some profiles. Nothing it does can retire one. */
export interface HarnessCatalogInspector {
  inspectHarnesses(
    environmentId: EnvironmentId,
    harnesses: HarnessInspectionDefinitions,
    signal: AbortSignal,
    options?: { readonly fresh: boolean },
  ): Promise<readonly HarnessInstanceCatalog[]>;
}

/**
 * The destructive direction, kept a separate capability so that a caller
 * holding a partial list cannot reach it by passing a flag. Every reconciler
 * must hand over the environment's complete enabled set.
 */
interface HarnessCatalogReconciler {
  reconcileHarnesses(
    environmentId: EnvironmentId,
    harnesses: HarnessInspectionDefinitions,
    signal: AbortSignal,
  ): Promise<readonly HarnessInstanceCatalog[]>;
}

interface HarnessCatalogReconciliationRunner extends HarnessCatalogReconciler {
  isAvailable(environmentId: EnvironmentId): boolean;
}

export interface HarnessCatalogRecorder {
  recordHarnessCatalogs(input: {
    readonly catalogs: readonly HarnessInstanceCatalog[];
    readonly environmentId: EnvironmentId;
    readonly expectedRevisions: ReadonlyMap<HarnessInstanceId, number>;
  }): Promise<readonly HarnessInstanceCatalog[]>;
}

interface HarnessCatalogReader {
  listHarnessCatalogs(environmentIds: readonly EnvironmentId[]): Promise<
    readonly {
      readonly capturedAt: Date;
      readonly catalog: HarnessInstanceCatalog;
      readonly environmentId: EnvironmentId;
      readonly harnessInstanceId: HarnessInstanceId;
    }[]
  >;
}

export const harnessCatalogMaxAgeMs = 30 * 60 * 1_000;

/** Enough of the store to ask an environment what profiles it has and file answers. */
export interface HarnessCatalogInventoryStore extends HarnessCatalogRecorder {
  listHarnessInstances(options?: {
    readonly environmentIds?: readonly EnvironmentId[];
    readonly limit?: number;
  }): Promise<readonly HarnessInstanceRecord[]>;
}

export interface HarnessCatalogConvergenceStore
  extends HarnessCatalogInventoryStore, HarnessCatalogReader {}

export function harnessInspectionDefinition(
  harness: HarnessInstanceRecord,
): HarnessInspectionDefinitions[number] {
  return {
    config: harness.config,
    driverKind: harness.driverKind,
    id: harness.id,
    name: harness.name,
    runtimeRevision: harness.runtimeRevision,
    sourceId: harness.sourceId,
    stateKind: harness.stateKind,
  };
}

/**
 * The only way a live inspection becomes durable state. Every path that asks a
 * Runner what its AI engines can do goes through here, so the stored catalog is
 * tied to the inspected profile revision and no path keeps a private copy.
 * Nothing inspects for the sake of capture: capture rides along with the
 * inspections the system already had reason to make.
 */
export async function inspectAndRecordHarnessCatalogs(options: {
  readonly catalogs: HarnessCatalogRecorder;
  readonly environmentId: EnvironmentId;
  readonly harnesses: HarnessInspectionDefinitions;
  readonly runners: HarnessCatalogInspector;
  readonly signal: AbortSignal;
  readonly fresh?: boolean;
}): Promise<readonly HarnessInstanceCatalog[]> {
  const catalogs = await options.runners.inspectHarnesses(
    options.environmentId,
    options.harnesses,
    options.signal,
    ...(options.fresh ? [{ fresh: true }] : []),
  );
  return options.catalogs.recordHarnessCatalogs({
    catalogs,
    environmentId: options.environmentId,
    expectedRevisions: new Map(
      options.harnesses.map(({ id, runtimeRevision }) => [id, runtimeRevision]),
    ),
  });
}

/** An invalidation may race the inspection it prompted; recapture only that stale read. */
export async function inspectAndRecordInvalidatedHarnessCatalog(options: {
  readonly catalogs: HarnessCatalogRecorder;
  readonly environmentId: EnvironmentId;
  readonly harnesses: HarnessInspectionDefinitions;
  readonly runners: HarnessCatalogInspector;
  readonly signal: AbortSignal;
}): Promise<readonly HarnessInstanceCatalog[]> {
  for (;;) {
    options.signal.throwIfAborted();
    try {
      return await inspectAndRecordHarnessCatalogs({ ...options, fresh: true });
    } catch (error) {
      if (
        !(error instanceof OpensteerError) ||
        error.code !== "conflict" ||
        error.reason !== "harness-catalog-stale-read" ||
        !error.retryable
      ) {
        throw error;
      }
    }
  }
}

/**
 * The one way an environment's desired profile set reaches its Runner. The
 * caller passes the complete enabled set — anything absent from it is retired
 * on the Runner — and the answer is captured on the same path every read uses.
 */
export async function reconcileAndRecordHarnessCatalogs(options: {
  readonly catalogs: HarnessCatalogRecorder;
  readonly environmentId: EnvironmentId;
  readonly harnesses: HarnessInspectionDefinitions;
  readonly runners: HarnessCatalogReconciler;
  readonly signal: AbortSignal;
}): Promise<readonly HarnessInstanceCatalog[]> {
  const catalogs = await options.runners.reconcileHarnesses(
    options.environmentId,
    options.harnesses,
    options.signal,
  );
  return options.catalogs.recordHarnessCatalogs({
    catalogs,
    environmentId: options.environmentId,
    expectedRevisions: new Map(
      options.harnesses.map(({ id, runtimeRevision }) => [id, runtimeRevision]),
    ),
  });
}

/**
 * Owns desired-profile convergence independently of the mutation request that
 * changed the durable set. One worker per environment rereads that set after
 * every change, so overlapping mutations cannot publish stale full-set writes
 * to the Runner or keep an HTTP response open during native catalog startup.
 */
export class HarnessCatalogReconciliationOwner {
  readonly #catalogs: HarnessCatalogInventoryStore;
  readonly #dirty = new Set<EnvironmentId>();
  readonly #lifetime = new AbortController();
  readonly #onError: (environmentId: EnvironmentId, error: unknown) => void;
  readonly #operations = new Map<EnvironmentId, Promise<void>>();
  readonly #runners: HarnessCatalogReconciliationRunner;

  constructor(options: {
    readonly catalogs: HarnessCatalogInventoryStore;
    readonly onError: (environmentId: EnvironmentId, error: unknown) => void;
    readonly runners: HarnessCatalogReconciliationRunner;
  }) {
    this.#catalogs = options.catalogs;
    this.#onError = options.onError;
    this.#runners = options.runners;
  }

  schedule(environmentId: EnvironmentId): void {
    if (this.#lifetime.signal.aborted) return;
    this.#dirty.add(environmentId);
    if (!this.#operations.has(environmentId)) this.#start(environmentId);
  }

  async close(): Promise<void> {
    this.#lifetime.abort(new Error("Harness catalog reconciliation is closing"));
    await Promise.allSettled(this.#operations.values());
    this.#dirty.clear();
  }

  #start(environmentId: EnvironmentId): void {
    const operation = this.#drain(environmentId);
    this.#operations.set(environmentId, operation);
    void operation.then(
      () => this.#finish(environmentId, operation),
      (error: unknown) => {
        if (!this.#lifetime.signal.aborted) this.#onError(environmentId, error);
        this.#finish(environmentId, operation);
      },
    );
  }

  #finish(environmentId: EnvironmentId, operation: Promise<void>): void {
    if (this.#operations.get(environmentId) !== operation) return;
    this.#operations.delete(environmentId);
    if (this.#dirty.has(environmentId) && !this.#lifetime.signal.aborted) {
      this.#start(environmentId);
    }
  }

  async #drain(environmentId: EnvironmentId): Promise<void> {
    while (this.#dirty.delete(environmentId)) {
      if (!this.#runners.isAvailable(environmentId)) continue;
      const desired = await this.#desired(environmentId);
      if (this.#lifetime.signal.aborted) return;
      const catalogs = await this.#runners.reconcileHarnesses(
        environmentId,
        desired,
        this.#lifetime.signal,
      );
      if (this.#lifetime.signal.aborted) return;
      const current = await this.#desired(environmentId);
      if (this.#lifetime.signal.aborted) return;
      if (!sameHarnessDefinitions(desired, current)) {
        this.#dirty.add(environmentId);
        continue;
      }
      await this.#catalogs.recordHarnessCatalogs({
        catalogs,
        environmentId,
        expectedRevisions: new Map(desired.map(({ id, runtimeRevision }) => [id, runtimeRevision])),
      });
    }
  }

  async #desired(environmentId: EnvironmentId): Promise<HarnessInspectionDefinitions> {
    return (await this.#catalogs.listHarnessInstances({ environmentIds: [environmentId] }))
      .filter((candidate) => candidate.enabled)
      .map(harnessInspectionDefinition);
  }
}

function sameHarnessDefinitions(
  left: HarnessInspectionDefinitions,
  right: HarnessInspectionDefinitions,
): boolean {
  if (left.length !== right.length) return false;
  const currentRevisions = new Map(
    right.map((candidate) => [candidate.id, candidate.runtimeRevision]),
  );
  return left.every(
    (candidate) => currentRevisions.get(candidate.id) === candidate.runtimeRevision,
  );
}

/**
 * A Run refused for want of plan capacity is the freshest thing this Host will
 * ever hear about that account's remaining usage, and the stored catalog now
 * contradicts it. So the failure is treated as evidence and the environment is
 * re-inspected right then.
 *
 * Nothing else covers this moment: dispatch and sign-in refresh a catalog only
 * when they already had a Runner round-trip to make, and periodic convergence
 * refreshes ready catalogs only every thirty minutes. This event needs an
 * immediate inspection so the account's usage display catches up with the Run.
 */
export async function inspectHarnessCatalogsAfterUsageLimit(options: {
  readonly catalogs: HarnessCatalogInventoryStore;
  readonly event: AgentEvent;
  readonly runners: HarnessCatalogInspector;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { event } = options;
  if (event.type !== "run.failed" || event.data.code !== harnessUsageLimitFailureCode) return;
  const harnesses = (
    await options.catalogs.listHarnessInstances({ environmentIds: [event.environmentId] })
  ).filter((harness) => harness.enabled);
  if (harnesses.length === 0) return;
  await inspectAndRecordHarnessCatalogs({
    catalogs: options.catalogs,
    environmentId: event.environmentId,
    harnesses: harnesses.map(harnessInspectionDefinition),
    runners: options.runners,
    signal: options.signal,
  });
}

/**
 * Converges the captured catalogs toward the one thing they are for: an answer
 * to "which models run here" that survives the Runner going away.
 *
 * Capture on connect is a latency optimization, not the guarantee — one dropped
 * inspection would otherwise leave an environment with no catalog until the
 * next reconnect. This pass closes that loop: it re-inspects exactly the
 * profiles that have no settled answer yet, and ready catalogs older than
 * thirty minutes. Provider inventories change independently of profile
 * configuration; dispatch and sign-in are not the only reasons to look again.
 * Sign-in required is settled: only an explicit refresh, profile change, sign-in
 * action or Runner invalidation may ask it again, never this periodic pass.
 */
export async function reconcileHarnessCatalogs(options: {
  readonly catalogs: HarnessCatalogConvergenceStore;
  readonly connectedEnvironmentIds: readonly EnvironmentId[];
  readonly runners: HarnessCatalogInspector;
  readonly signal: AbortSignal;
  readonly now?: number;
  readonly onCommitted?: (
    environmentId: EnvironmentId,
    catalogs: readonly HarnessInstanceCatalog[],
  ) => void;
}): Promise<void> {
  if (options.connectedEnvironmentIds.length === 0) return;
  const now = options.now ?? Date.now();
  const [harnesses, stored] = await Promise.all([
    options.catalogs.listHarnessInstances({ environmentIds: options.connectedEnvironmentIds }),
    options.catalogs.listHarnessCatalogs(options.connectedEnvironmentIds),
  ]);
  const captured = new Map(stored.map((record) => [record.harnessInstanceId, record]));
  const pending = new Map<EnvironmentId, HarnessInspectionDefinitions[number][]>();
  const connected = new Set(options.connectedEnvironmentIds);
  for (const harness of harnesses) {
    if (!harness.enabled || harness.removedAt !== null || !connected.has(harness.environmentId)) {
      continue;
    }
    const record = captured.get(harness.id);
    if (
      record?.environmentId === harness.environmentId &&
      (record.catalog.status === "authentication-required" ||
        (record.catalog.status === "ready" &&
          record.capturedAt.getTime() <= now &&
          now - record.capturedAt.getTime() < harnessCatalogMaxAgeMs))
    ) {
      continue;
    }
    const definitions = pending.get(harness.environmentId) ?? [];
    definitions.push(harnessInspectionDefinition(harness));
    pending.set(harness.environmentId, definitions);
  }
  const results = await Promise.allSettled(
    [...pending].map(([environmentId, definitions]) => {
      const capture = inspectAndRecordHarnessCatalogs({
        catalogs: options.catalogs,
        environmentId,
        // A missing durable observation may follow failed invalidation
        // recapture. Never restore the superseded answer from the live cache.
        fresh: true,
        harnesses: definitions,
        runners: options.runners,
        signal: options.signal,
      });
      const onCommitted = options.onCommitted;
      return onCommitted
        ? capture.then((catalogs) => onCommitted(environmentId, catalogs))
        : capture;
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "AI model catalog refresh failed");
}
