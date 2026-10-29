import { withDatabaseTransaction } from "./connection.js";
import {
  type HarnessId,
  type EnvironmentId,
  type HarnessInstanceId,
  type HarnessInstanceStateKind,
  type UserId,
  OpensteerError,
  HarnessInstanceIdSchema,
  createId,
  nonTerminalRunStatuses,
  type ExecutionPreferences,
  ExecutionPreferencesSchema,
  emptyExecutionPreferences,
  type ExecutionChoice,
  rememberExecutionChoice as rememberExecutionChoiceInStore,
} from "@opensteer/core";
import {
  type HarnessInstanceCatalog,
  maxHarnessInstancesPerEnvironment,
} from "@opensteer/protocol";
import { type Kysely, type Transaction, sql } from "kysely";
import { type DatabaseSchema } from "./schema.js";
import {
  lockCommandIdempotency,
  findCommandByIdempotency,
  idempotencyConflict,
  jsonValue,
  principalIdForUser,
  boundedLimit,
} from "./store-primitives.js";
import { isDeepStrictEqual } from "node:util";
import {
  deploymentOwnedExecutionIsAvailableToUser,
  managedEnvironmentBindingAllowsUser,
} from "./execution-authority.js";

export interface HarnessInstanceRecord {
  readonly config: unknown;
  readonly driverKind: HarnessId;
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly id: HarnessInstanceId;
  /**
   * Which account of this driver this work location means when nobody names
   * one. At most one enabled profile per `(environment, driver)` carries it.
   */
  readonly isDefault: boolean;
  readonly name: string;
  /** When this profile was retired. Null is the only live value. */
  readonly removedAt: Date | null;
  readonly runtimeRevision: number;
  /** Who this account talks to; one of the sources its engine declares. */
  readonly sourceId: string;
  readonly stateKind: HarnessInstanceStateKind;
}

/**
 * One AI engine profile to create. `idempotency` is present only for a create a
 * person requested: reconciles and seeding have no requester to key a command
 * against, and the pair travels together so neither half can go missing.
 */
export interface CreateHarnessInstanceInput {
  readonly config: unknown;
  readonly driverKind: HarnessId;
  readonly enabled?: boolean;
  readonly environmentId: EnvironmentId;
  readonly id?: HarnessInstanceId;
  readonly idempotency?: { readonly key: string; readonly requestedBy: UserId };
  readonly name: string;
  /**
   * One of the sources the engine declares; the caller has already checked it.
   * Legacy internal callers omit this and retain the original first-party
   * source, whose identifier is the driver kind.
   */
  readonly sourceId?: string;
  readonly stateKind: HarnessInstanceStateKind;
}

export interface HarnessCatalogRecord {
  readonly capturedAt: Date;
  readonly catalog: HarnessInstanceCatalog;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
}

/** Exactly what a `HarnessInstanceRecord` is made of, in one place. */
const harnessInstanceColumns = [
  "config",
  "driverKind",
  "enabled",
  "environmentId",
  "id",
  "isDefault",
  "name",
  "removedAt",
  "runtimeRevision",
  "sourceId",
  "stateKind",
] as const;

function harnessCreateCommandPayload(payload: unknown): {
  readonly harnessInstanceId: HarnessInstanceId;
  readonly request: Readonly<Record<string, unknown>>;
} {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("harnessInstanceId" in payload) ||
    typeof payload.harnessInstanceId !== "string" ||
    !("request" in payload) ||
    typeof payload.request !== "object" ||
    payload.request === null ||
    Array.isArray(payload.request)
  ) {
    throw new OpensteerError({ code: "internal", message: "Stored AI engine command is invalid" });
  }
  return {
    harnessInstanceId: HarnessInstanceIdSchema.parse(payload.harnessInstanceId),
    request: payload.request as Readonly<Record<string, unknown>>,
  };
}

/**
 * What makes two creates "the same request". The generated id is deliberately
 * absent: a retry that re-rolls its id is still the same intent, and the stored
 * command already names the row the first attempt produced.
 */
function canonicalHarnessCreateRequest(
  input: CreateHarnessInstanceInput,
): Readonly<Record<string, unknown>> {
  return {
    config: input.config,
    driverKind: input.driverKind,
    enabled: input.enabled ?? true,
    environmentId: input.environmentId,
    name: input.name,
    sourceId: input.sourceId ?? input.driverKind,
    stateKind: input.stateKind,
  };
}

export async function createHarnessInstance(
  database: Kysely<DatabaseSchema>,
  input: CreateHarnessInstanceInput,
): Promise<HarnessInstanceRecord> {
  const id = input.id ?? createId("harnessInstance");
  return withDatabaseTransaction(database, async (transaction) => {
    // Adding a profile is a person clicking a button, and a retried click
    // must not leave two. Reconciles and seeding create profiles with no
    // requester at all, so the idempotent path exists only where a request
    // named one.
    if (input.idempotency) {
      const { key, requestedBy } = input.idempotency;
      await lockCommandIdempotency(transaction, requestedBy, key);
      const existing = await findCommandByIdempotency(transaction, requestedBy, key);
      if (existing) {
        if (existing.type !== "harness.create") throw idempotencyConflict(key);
        const stored = harnessCreateCommandPayload(existing.payload);
        if (!isDeepStrictEqual(stored.request, canonicalHarnessCreateRequest(input))) {
          throw idempotencyConflict(key);
        }
        return await transaction
          .selectFrom("harnessInstances")
          .select(harnessInstanceColumns)
          .where("id", "=", stored.harnessInstanceId)
          .executeTakeFirstOrThrow();
      }
    }
    // Every create for one environment locks the same durable parent before
    // it counts or inserts profiles. A count inside a transaction is not by
    // itself a fence under Postgres MVCC: two writers could both observe 99
    // and commit 101. The parent-row lock makes the cap and ambient-profile
    // checks one serialized decision without a separate lock table.
    const environment = await transaction
      .selectFrom("executionEnvironments")
      .select("id")
      .where("id", "=", input.environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!environment) {
      throw new OpensteerError({ code: "not_found", message: "Work location not found" });
    }
    // One driver has at most one ambient profile per environment, and the
    // database enforces it with a partial unique index. The index alone would
    // surface as a raw 23505 and reach a caller as an unexplained 500, so the
    // same rule is checked here — under the transaction that performs the
    // insert — to give the settings surface a conflict it can render.
    if (input.stateKind === "ambient") {
      const existingAmbient = await transaction
        .selectFrom("harnessInstances")
        .select("id")
        .where("driverKind", "=", input.driverKind)
        .where("environmentId", "=", input.environmentId)
        .where("removedAt", "is", null)
        .where("stateKind", "=", "ambient")
        .executeTakeFirst();
      if (existingAmbient) {
        throw new OpensteerError({
          code: "conflict",
          message: "This work location already has an existing CLI profile for this AI engine",
        });
      }
    }
    // A work location's whole desired profile set travels in one reconcile
    // message, which is bounded by the protocol. One profile past that bound
    // makes the set unrepresentable, so the bound is enforced where profiles
    // are created — as a conflict the settings surface can render — rather
    // than discovered as a rejected reconcile nobody asked for. Tombstones do
    // not ride the wire, so only live rows count and removing a profile frees
    // its slot.
    const live = await transaction
      .selectFrom("harnessInstances")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("environmentId", "=", input.environmentId)
      .where("removedAt", "is", null)
      .executeTakeFirstOrThrow();
    if (Number(live.count) >= maxHarnessInstancesPerEnvironment) {
      throw new OpensteerError({
        code: "conflict",
        message: `This work location already has the maximum of ${maxHarnessInstancesPerEnvironment} AI engines; remove one before adding another`,
      });
    }
    // Every (work location, driver) pair with an enabled account needs one a
    // caller reaches without naming it. The environment lock above
    // serializes this read against every lifecycle mutation, so two first
    // enabled profiles cannot both claim it and hit the partial unique index
    // as a raw 23505. A disabled profile is deliberately never the default;
    // the first one later enabled claims the empty slot.
    const existingDefault = await transaction
      .selectFrom("harnessInstances")
      .select("id")
      .where("driverKind", "=", input.driverKind)
      .where("environmentId", "=", input.environmentId)
      .where("isDefault", "=", true)
      .where("removedAt", "is", null)
      .executeTakeFirst();
    const row = await transaction
      .insertInto("harnessInstances")
      .values({
        config: jsonValue(input.config),
        driverKind: input.driverKind,
        enabled: input.enabled ?? true,
        environmentId: input.environmentId,
        id,
        isDefault: (input.enabled ?? true) && !existingDefault,
        name: input.name,
        runtimeRevision: 1,
        sourceId: input.sourceId ?? input.driverKind,
        stateKind: input.stateKind,
      })
      .returning(harnessInstanceColumns)
      .executeTakeFirstOrThrow();
    if (input.idempotency) {
      const { key, requestedBy } = input.idempotency;
      await transaction
        .insertInto("commands")
        .values({
          actorPrincipalId: await principalIdForUser(transaction, requestedBy),
          authoritySource: jsonValue({ kind: "user-session", userId: requestedBy }),
          dispatcherId: null,
          environmentId: null,
          id: createId("command"),
          idempotencyKey: key,
          lastError: null,
          payload: jsonValue({
            harnessInstanceId: row.id,
            request: canonicalHarnessCreateRequest(input),
            type: "harness.create",
          }),
          requestedBy,
          runId: null,
          status: "succeeded",
          threadId: null,
          type: "harness.create",
        })
        .executeTakeFirstOrThrow();
    }
    return row;
  });
}

/**
 * The live AI engine profiles, newest environments last. Removed profiles are
 * excluded here because every caller of this method is deciding what may run
 * now — desired state for a Runner, placement candidates, the bootstrap
 * listing — and a tombstone answers none of those questions.
 *
 * `environmentIds` filters in SQL rather than leaving the caller to trim the
 * result: a bootstrap that read every profile and then discarded the ones it
 * could not see would silently lose profiles once a Deployment held more than
 * the limit.
 */
export async function listHarnessInstances(
  database: Kysely<DatabaseSchema>,
  options: {
    readonly environmentIds?: readonly EnvironmentId[];
    /**
     * Tombstones too. Only one caller wants them: the seeding pass that
     * creates a default profile for a driver the first time a Runner
     * advertises it. A tombstone is the Host's durable record that somebody
     * already removed that profile, and reading past it is what made a
     * removed profile reappear on the next reconnect.
     */
    readonly includeRemoved?: boolean;
    readonly limit?: number;
  } = {},
): Promise<readonly HarnessInstanceRecord[]> {
  if (options.environmentIds?.length === 0) return [];
  let query = database
    .selectFrom("harnessInstances")
    .select(harnessInstanceColumns)
    .orderBy("createdAt", "asc")
    .limit(boundedLimit(options.limit ?? 1_000, 1_000));
  if (!options.includeRemoved) query = query.where("removedAt", "is", null);
  if (options.environmentIds) {
    query = query.where("environmentId", "in", options.environmentIds);
  }
  return await query.execute();
}

/** Authorized profiles use stable keyset paging; legacy inspection includes only enabled ones. */
export async function listAgentHarnessInstancesForUser(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  options: {
    readonly includeDisabled?: boolean;
    readonly afterId?: HarnessInstanceId;
    readonly id?: HarnessInstanceId;
    readonly limit?: number;
  } = {},
): Promise<readonly HarnessInstanceRecord[]> {
  const deploymentOwnedAvailable = await deploymentOwnedExecutionIsAvailableToUser(
    database,
    userId,
  );
  let query = database
    .selectFrom("harnessInstances")
    .innerJoin(
      "executionEnvironments",
      "executionEnvironments.id",
      "harnessInstances.environmentId",
    )
    .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
    .selectAll("harnessInstances")
    .where("harnessInstances.removedAt", "is", null)
    .where("runners.revokedAt", "is", null)
    .where((expression) =>
      expression.or([
        ...(deploymentOwnedAvailable ? [expression("runners.ownerKind", "=", "deployment")] : []),
        expression("runners.ownerUserId", "=", userId),
      ]),
    )
    .where((expression) => managedEnvironmentBindingAllowsUser(expression, userId))
    .orderBy("harnessInstances.id", "asc")
    .limit(boundedLimit(options.limit ?? 65, 1_000));
  if (!options.includeDisabled) query = query.where("harnessInstances.enabled", "=", true);
  if (options.afterId) query = query.where("harnessInstances.id", ">", options.afterId);
  if (options.id) query = query.where("harnessInstances.id", "=", options.id);
  return query.execute();
}

/**
 * One profile by id, tombstones included. Removal disables the profile, so
 * the `enabled` guard every execution path already applies also refuses a
 * removed one; returning the tombstone is what lets a management route
 * recognise an already-removed profile and retry its Runner-side cleanup.
 */
export async function getHarnessInstance(
  database: Kysely<DatabaseSchema>,
  id: HarnessInstanceId,
): Promise<HarnessInstanceRecord | null> {
  const row = await database
    .selectFrom("harnessInstances")
    .select(harnessInstanceColumns)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ?? null;
}

// Default succession can touch a sibling with a lower ID. The environment
// fence already serializes lifecycle writes; take its complete profile set in
// the order declared in ./lock-order.ts before selecting the changed profile.
async function lockHarnessSiblings(
  transaction: Transaction<DatabaseSchema>,
  environmentId: EnvironmentId,
): Promise<void> {
  await transaction
    .selectFrom("harnessInstances")
    .select("id")
    .where("environmentId", "=", environmentId)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
}

export async function updateHarnessInstance(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly config?: unknown;
    readonly expectedRuntimeRevision?: number;
    readonly enabled?: boolean;
    readonly id: HarnessInstanceId;
    readonly name?: string;
  },
): Promise<HarnessInstanceRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    // Resolve the immutable parent without taking a profile lock, then take
    // the same parent lock create/default/remove use before locking the
    // profile. Keeping this environment-then-profile order prevents two
    // lifecycle writers from waiting on one another in opposite directions.
    const identity = await transaction
      .selectFrom("harnessInstances")
      .select("environmentId")
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!identity) {
      throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
    }
    const environment = await transaction
      .selectFrom("executionEnvironments")
      .select("id")
      .where("id", "=", identity.environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!environment) {
      throw new OpensteerError({ code: "not_found", message: "Work location not found" });
    }
    await lockHarnessSiblings(transaction, identity.environmentId);
    const current = await transaction
      .selectFrom("harnessInstances")
      .selectAll()
      .where("id", "=", input.id)
      .where("environmentId", "=", identity.environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!current) {
      throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
    }
    if (current.removedAt) {
      throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
    }
    if (
      input.expectedRuntimeRevision !== undefined &&
      current.runtimeRevision !== input.expectedRuntimeRevision
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "This account's settings changed. Refresh before saving again.",
        retryable: true,
      });
    }
    const configChanged =
      input.config !== undefined && !isDeepStrictEqual(current.config, input.config);
    // Turning a profile off retires it from desired state, and the Runner's
    // reconciliation closes its shared adapter — which ends every session on
    // it. So the refusal and the write have to be one decision: a caller that
    // asked "is it idle?" outside this transaction can be overtaken by a run
    // that binds before the write lands, and the reconcile then closes the
    // adapter under it.
    //
    // Serialized against run binding via the row lock: the `forNoKeyUpdate` above
    // holds this profile row for the rest of the transaction, and
    // `acquireExecutionBinding` — the one place a run is bound to a profile
    // for execution — takes the same row `forShare` and re-reads `enabled`
    // under it. Postgres therefore orders the two outcomes rather than
    // letting them race: either the binding commits first and this query sees
    // its non-terminal run, or this commits first and the binding is refused.
    if ((input.enabled === false && current.enabled) || configChanged) {
      const activeRun = await transaction
        .selectFrom("runs")
        .select("id")
        .where("environmentId", "=", current.environmentId)
        .where("harnessInstanceId", "=", input.id)
        .where("status", "in", nonTerminalRunStatuses)
        .limit(1)
        .executeTakeFirst();
      if (activeRun) {
        throw new OpensteerError({
          code: "conflict",
          message:
            "This AI engine is still running work; wait for it to finish before changing its configuration or turning it off",
          retryable: true,
        });
      }
    }
    // The name holds the revision the row carries right now; a
    // runtime-affecting change is what advances it.
    const currentRevision = current.runtimeRevision;
    const enabling = input.enabled === true && !current.enabled;
    const disablingDefault = input.enabled === false && current.enabled && current.isDefault;
    let claimsDefault = false;
    if (enabling) {
      const existingDefault = await transaction
        .selectFrom("harnessInstances")
        .select("id")
        .where("driverKind", "=", current.driverKind)
        .where("environmentId", "=", current.environmentId)
        .where("isDefault", "=", true)
        .where("removedAt", "is", null)
        .executeTakeFirst();
      claimsDefault = !existingDefault;
    }
    const row = await transaction
      .updateTable("harnessInstances")
      .set({
        ...(configChanged
          ? { config: jsonValue(input.config), runtimeRevision: currentRevision + 1 }
          : {}),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(disablingDefault ? { isDefault: false } : {}),
        ...(claimsDefault ? { isDefault: true } : {}),
        ...(input.name === undefined ? {} : { name: input.name }),
        updatedAt: new Date(),
      })
      .where("id", "=", input.id)
      .returning(harnessInstanceColumns)
      .executeTakeFirstOrThrow();
    if (disablingDefault) {
      const successor = await transaction
        .selectFrom("harnessInstances")
        .select("id")
        .where("driverKind", "=", current.driverKind)
        .where("environmentId", "=", current.environmentId)
        .where("enabled", "=", true)
        .where("removedAt", "is", null)
        .orderBy("createdAt")
        .orderBy("id")
        .limit(1)
        .executeTakeFirst();
      if (successor) {
        await transaction
          .updateTable("harnessInstances")
          .set({ isDefault: true, updatedAt: new Date() })
          .where("id", "=", successor.id)
          .execute();
      }
    }
    // A catalog describes what a profile offers, so it must not outlive the
    // configuration that produced it — nor a profile that has been turned
    // off. Leaving a disabled profile's catalog in place served a stale
    // answer to every client and left it to the UI to hide.
    if (configChanged || input.enabled === false) {
      await transaction
        .deleteFrom("harnessCatalogs")
        .where("harnessInstanceId", "=", input.id)
        .execute();
    }
    return row;
  });
}

/**
 * Names which account of one AI engine this work location reaches when a
 * caller does not choose. Clearing the old default and setting the new one
 * has to be a single decision: the partial unique index admits one live
 * default per `(environment, driver)`, so two overlapping writes would leave
 * the pair with none or fail on the index. The environment lock is the same
 * one creation and removal take, which is what orders this against a profile
 * appearing or being retired underneath it.
 *
 * A profile that is turned off is refused rather than silently promoted:
 * placement never selects a disabled profile, so accepting it would record a
 * default nothing can use.
 */
export async function setDefaultHarnessInstance(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly environmentId: EnvironmentId;
    readonly harnessInstanceId: HarnessInstanceId;
  },
): Promise<HarnessInstanceRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    const environment = await transaction
      .selectFrom("executionEnvironments")
      .select("id")
      .where("id", "=", input.environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!environment) {
      throw new OpensteerError({ code: "not_found", message: "Work location not found" });
    }
    await lockHarnessSiblings(transaction, input.environmentId);
    const current = await transaction
      .selectFrom("harnessInstances")
      .select(harnessInstanceColumns)
      .where("id", "=", input.harnessInstanceId)
      .where("environmentId", "=", input.environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!current || current.removedAt) {
      throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
    }
    if (!current.enabled) {
      throw new OpensteerError({
        code: "conflict",
        message: "Turn this AI engine on before making it the default",
      });
    }
    if (current.isDefault) return current;
    await transaction
      .updateTable("harnessInstances")
      .set({ isDefault: false, updatedAt: new Date() })
      .where("driverKind", "=", current.driverKind)
      .where("environmentId", "=", input.environmentId)
      .where("isDefault", "=", true)
      .where("removedAt", "is", null)
      .execute();
    return await transaction
      .updateTable("harnessInstances")
      .set({ isDefault: true, updatedAt: new Date() })
      .where("id", "=", input.harnessInstanceId)
      .returning(harnessInstanceColumns)
      .executeTakeFirstOrThrow();
  });
}

/**
 * Retires one AI engine profile. Threads reach `archived`, never deletion, so
 * a profile that ever ran anything can never be hard-deleted without taking
 * that history with it — which is why removal is a tombstone: the row stays
 * for the archive's foreign keys, and `removedAt` takes it out of every live
 * listing, desired state, and catalog.
 *
 * Only a Thread that is still working refuses removal. Once it is committed
 * the profile can no longer be selected or dispatched, so the caller's
 * Runner-side credential cleanup is a retryable step after this returns
 * rather than a step this transaction depends on: a crash in between leaves a
 * tombstone whose cleanup the next removal attempt performs.
 */
export async function removeHarnessInstance(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  harnessInstanceId: HarnessInstanceId,
): Promise<HarnessInstanceRecord> {
  return withDatabaseTransaction(database, async (transaction) => {
    // Pair with profile creation's environment lock. A concurrent removal
    // commits its tombstone before the waiting creator counts live profiles,
    // so freeing the final slot and filling it are one deterministic order.
    const environment = await transaction
      .selectFrom("executionEnvironments")
      .select("id")
      .where("id", "=", environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!environment) {
      throw new OpensteerError({ code: "not_found", message: "Work location not found" });
    }
    await lockHarnessSiblings(transaction, environmentId);
    const current = await transaction
      .selectFrom("harnessInstances")
      .select(harnessInstanceColumns)
      .where("id", "=", harnessInstanceId)
      .where("environmentId", "=", environmentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!current) throw new OpensteerError({ code: "not_found", message: "AI engine not found" });
    if (current.removedAt) return current;
    const liveThread = await transaction
      .selectFrom("threads")
      .select("id")
      .where("harnessInstanceId", "=", harnessInstanceId)
      .where("status", "!=", "archived")
      .executeTakeFirst();
    if (liveThread) {
      throw new OpensteerError({
        code: "conflict",
        message:
          "An AI engine still selected by an open Thread cannot be removed; archive or move those Threads first",
      });
    }
    const row = await transaction
      .updateTable("harnessInstances")
      .set({ enabled: false, isDefault: false, removedAt: new Date(), updatedAt: new Date() })
      .where("id", "=", harnessInstanceId)
      .returning(harnessInstanceColumns)
      .executeTakeFirstOrThrow();
    // Retiring the default must not leave enabled survivors without one. A
    // disabled account is not usable placement, so the stable successor is
    // the oldest remaining enabled profile.
    if (current.isDefault) {
      const successor = await transaction
        .selectFrom("harnessInstances")
        .select("id")
        .where("driverKind", "=", current.driverKind)
        .where("environmentId", "=", environmentId)
        .where("enabled", "=", true)
        .where("removedAt", "is", null)
        .orderBy("createdAt")
        .orderBy("id")
        .limit(1)
        .executeTakeFirst();
      if (successor) {
        await transaction
          .updateTable("harnessInstances")
          .set({ isDefault: true, updatedAt: new Date() })
          .where("id", "=", successor.id)
          .execute();
      }
    }
    await transaction
      .deleteFrom("harnessCatalogs")
      .where("harnessInstanceId", "=", harnessInstanceId)
      .execute();
    return row;
  });
}

/**
 * Keeps what a Runner just reported about its AI engines. Every caller is a
 * path that already had a fresh answer in hand — a Runner connecting, a
 * dispatch re-check — so capture never costs an inspection of its own.
 */
export async function recordHarnessCatalogs(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly catalogs: readonly HarnessInstanceCatalog[];
    readonly environmentId: EnvironmentId;
    readonly expectedRevisions: ReadonlyMap<HarnessInstanceId, number>;
  },
): Promise<readonly HarnessInstanceCatalog[]> {
  for (const catalog of input.catalogs) {
    if (!input.expectedRevisions.has(catalog.harnessInstanceId)) {
      throw new Error(
        `Harness catalog ${catalog.harnessInstanceId} has no expected runtime revision`,
      );
    }
  }
  return withDatabaseTransaction(database, async (transaction) => {
    // Deterministic lock order keeps overlapping multi-profile captures from
    // deadlocking when their request order differs.
    const catalogs = [...input.catalogs].sort((left, right) =>
      left.harnessInstanceId.localeCompare(right.harnessInstanceId),
    );
    if (catalogs.length === 0) return [];
    const harnesses = await transaction
      .selectFrom("harnessInstances")
      .select(["driverKind", "enabled", "environmentId", "id", "removedAt", "runtimeRevision"])
      .where(
        "id",
        "in",
        catalogs.map((catalog) => catalog.harnessInstanceId),
      )
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
    const harnessesById = new Map(harnesses.map((harness) => [harness.id, harness]));
    const currentCatalogs = catalogs.filter((catalog) => {
      const harness = harnessesById.get(catalog.harnessInstanceId);
      return (
        harness?.environmentId === input.environmentId &&
        harness.driverKind === catalog.driverKind &&
        harness.enabled &&
        harness.removedAt === null &&
        harness.runtimeRevision === input.expectedRevisions.get(catalog.harnessInstanceId)
      );
    });
    const replacements = currentCatalogs.filter(
      (catalog): catalog is Extract<HarnessInstanceCatalog, { status: "ready" }> =>
        catalog.status === "ready" && catalog.supersededContinuationIdentities.length > 0,
    );
    if (replacements.length) {
      const threads = await transaction
        .selectFrom("threads")
        .select("id")
        .where("environmentId", "=", input.environmentId)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("providerSessions")
              .select("id")
              .whereRef("providerSessions.threadId", "=", "threads.id")
              .where("active", "=", true)
              .where((match) =>
                match.or(
                  replacements.map((catalog) =>
                    match.and([
                      match(
                        sql<string>`continuation_identity ->> 'driverKind'`,
                        "=",
                        catalog.driverKind,
                      ),
                      match(sql<string>`continuation_identity ->> 'continuationKey'`, "in", [
                        ...catalog.supersededContinuationIdentities,
                      ]),
                    ]),
                  ),
                ),
              ),
          ),
        )
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      if (threads.length)
        await transaction
          .selectFrom("providerSessions")
          .select("id")
          .where(
            "threadId",
            "in",
            threads.map(({ id }) => id),
          )
          .where("active", "=", true)
          .orderBy("id", "asc")
          .forNoKeyUpdate()
          .execute();
      for (const catalog of replacements)
        await adoptSupersededContinuationIdentities(transaction, input.environmentId, catalog);
    }
    // Publish catalogs only after every affected Thread and provider row is fenced.
    for (const catalog of currentCatalogs) {
      await transaction
        .insertInto("harnessCatalogs")
        .values({
          capturedAt: new Date(),
          catalog: jsonValue(catalog),
          environmentId: input.environmentId,
          harnessInstanceId: catalog.harnessInstanceId,
        })
        .onConflict((conflict) =>
          conflict.columns(["environmentId", "harnessInstanceId"]).doUpdateSet({
            capturedAt: new Date(),
            catalog: jsonValue(catalog),
          }),
        )
        .execute();
    }
    return currentCatalogs;
  });
}

/**
 * Moves Threads pinned to a retired continuation identity onto the identity
 * that replaced it.
 *
 * A Runner retires an identity when the store behind it outlives the narrower
 * thing the old key named — a profile, or one login to it. The Thread's
 * provider conversation did not move, so refusing to follow would strand it
 * with native history it can no longer resume. The update is idempotent: once
 * a Thread carries the new key it no longer matches, and a Runner that keeps
 * republishing the same retired keys changes nothing.
 */
async function adoptSupersededContinuationIdentities(
  transaction: Transaction<DatabaseSchema>,
  environmentId: EnvironmentId,
  catalog: HarnessInstanceCatalog,
): Promise<void> {
  if (catalog.status !== "ready") return;
  const superseded = catalog.supersededContinuationIdentities;
  if (superseded.length === 0) return;
  await sql`set local opensteer.continuation_adoption = 'on'`.execute(transaction);
  await transaction
    .updateTable("threads")
    .set({ updatedAt: new Date() })
    .where("environmentId", "=", environmentId)
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("providerSessions")
          .select("providerSessions.id")
          .whereRef("providerSessions.threadId", "=", "threads.id")
          .where("providerSessions.active", "=", true)
          .where(
            sql<string>`provider_sessions.continuation_identity ->> 'driverKind'`,
            "=",
            catalog.driverKind,
          )
          .where(
            sql<string>`provider_sessions.continuation_identity ->> 'continuationKey'`,
            "in",
            superseded,
          ),
      ),
    )
    .execute();
  await transaction
    .updateTable("providerSessions")
    .set({ continuationIdentity: jsonValue(catalog.continuationIdentity), updatedAt: new Date() })
    .where("active", "=", true)
    .where(sql<string>`continuation_identity ->> 'driverKind'`, "=", catalog.driverKind)
    .where(sql<string>`continuation_identity ->> 'continuationKey'`, "in", superseded)
    .where((expression) =>
      expression.exists(
        expression
          .selectFrom("threads")
          .select("threads.id")
          .whereRef("threads.id", "=", "providerSessions.threadId")
          .where("threads.environmentId", "=", environmentId),
      ),
    )
    .execute();
}

/**
 * Forgets what one profile last reported.
 *
 * Signing a profile out invalidates its catalog outright: the models it
 * advertised are no longer reachable and the connection it described is gone.
 * The re-inspection that follows a logout may itself fail, so the stale
 * "connected" answer has to be dropped first — otherwise every client keeps
 * being told the profile is signed in until something else happens to look.
 */
export async function discardHarnessCatalog(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  harnessInstanceId: HarnessInstanceId,
): Promise<void> {
  await database
    .deleteFrom("harnessCatalogs")
    .where("environmentId", "=", environmentId)
    .where("harnessInstanceId", "=", harnessInstanceId)
    .execute();
}

export async function listHarnessCatalogs(
  database: Kysely<DatabaseSchema>,
  environmentIds: readonly EnvironmentId[],
  harnessInstanceIds?: readonly HarnessInstanceId[],
): Promise<readonly HarnessCatalogRecord[]> {
  if (environmentIds.length === 0 || harnessInstanceIds?.length === 0) return [];
  let query = database
    .selectFrom("harnessCatalogs")
    .select(["capturedAt", "catalog", "environmentId", "harnessInstanceId"])
    .where("environmentId", "in", environmentIds);
  if (harnessInstanceIds) query = query.where("harnessInstanceId", "in", harnessInstanceIds);
  return query.execute();
}

export async function getHarnessCatalog(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  harnessInstanceId: HarnessInstanceId,
): Promise<HarnessInstanceCatalog | null> {
  const row = await database
    .selectFrom("harnessCatalogs")
    .select("catalog")
    .where("environmentId", "=", environmentId)
    .where("harnessInstanceId", "=", harnessInstanceId)
    .executeTakeFirst();
  return row?.catalog ?? null;
}

/**
 * What this person chose last about how their work runs. A person who has
 * never chosen gets the empty record rather than nothing, so every caller
 * reads one shape and none of them has to invent a default of its own.
 *
 * The stored JSON is parsed on the way out: the column outlives the code that
 * wrote it, and a row from an older shape is a hint, not a licence to hand a
 * client something the schema does not describe.
 */
export async function getExecutionPreferences(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
): Promise<ExecutionPreferences> {
  const row = await database
    .selectFrom("userExecutionPreferences")
    .select("preferences")
    .where("userId", "=", userId)
    .executeTakeFirst();
  return row ? ExecutionPreferencesSchema.parse(row.preferences) : emptyExecutionPreferences;
}

/**
 * Folds one explicit choice into the person's record and returns what they
 * now have.
 *
 * The merge rule lives in `@opensteer/core` so the Host and every client
 * agree on what "most recent" means. Concurrent writers serialize on the row
 * lock rather than racing a read against a write, and the last accepted
 * choice wins — which is what a person who just picked something expects,
 * and why this carries no revision to reconcile.
 */
export async function rememberExecutionChoice(
  database: Kysely<DatabaseSchema>,
  userId: UserId,
  choice: ExecutionChoice,
): Promise<ExecutionPreferences> {
  return withDatabaseTransaction(database, async (transaction) => {
    const existing = await transaction
      .selectFrom("userExecutionPreferences")
      .select("preferences")
      .where("userId", "=", userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const merged = rememberExecutionChoiceInStore(
      existing ? ExecutionPreferencesSchema.parse(existing.preferences) : emptyExecutionPreferences,
      choice,
    );
    const updatedAt = new Date();
    await transaction
      .insertInto("userExecutionPreferences")
      .values({ preferences: jsonValue(merged), updatedAt, userId })
      .onConflict((conflict) =>
        conflict.column("userId").doUpdateSet({ preferences: jsonValue(merged), updatedAt }),
      )
      .execute();
    return merged;
  });
}

/**
 * Whether one AI engine profile still has a Run in flight.
 *
 * Disabling or signing a profile out closes the shared adapter on the Runner,
 * which takes every live session on that profile down with it. That is a
 * correct thing to do to an idle profile and a data-losing thing to do to a
 * busy one, so the routes that perform it ask this first and refuse with a
 * retryable conflict. Scoped by environment as well as profile so the query
 * uses the same index path — and the same "is this work location busy"
 * reasoning — as `hasOutstandingWork`.
 */
export async function hasActiveRunForHarness(
  database: Kysely<DatabaseSchema>,
  environmentId: EnvironmentId,
  harnessInstanceId: HarnessInstanceId,
): Promise<boolean> {
  const activeRun = await database
    .selectFrom("runs")
    .select("id")
    .where("environmentId", "=", environmentId)
    .where("harnessInstanceId", "=", harnessInstanceId)
    .where("status", "in", nonTerminalRunStatuses)
    .limit(1)
    .executeTakeFirst();
  return activeRun !== undefined;
}
