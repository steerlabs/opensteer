import {
  OpensteerError,
  BrowserProfileIdSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  RunnerIdSchema,
  TabIdSchema,
  tabGroupsMaxPerOwner,
  tabsMaxPerOwner,
  excludedBackgroundAccounts,
  utf8Prefix,
  type AuthenticatedSession,
  type UserId,
  type RunnerId,
} from "@opensteer/core";
import {
  findPersonalSettings,
  hasEligibleBrowserPlacement,
  isEligibleBrowserRunner,
  readBrowserHomeResourcePage,
  OpensteerStore,
  readHarnessCatalogModelPage,
  readMachineResourceKeys,
} from "@opensteer/database";
import type { PersonalMutationTransaction } from "@opensteer/database/personal-mutation";
import { authorizedSyncState, withPersonalSyncRead } from "@opensteer/database/personal-sync-store";
import { maxHarnessModelsPerCatalog, rpcSuccess, type MachineSummary } from "@opensteer/protocol";
import {
  PersonalResourceDetailSchema,
  PersonalResourceViewSchema,
  type PersonalResourceKind,
  type PersonalResourceRevisions,
  type PersonalResourceView,
} from "@opensteer/protocol/resources";
import { z } from "zod";
import { harnessView } from "../administration/authority.js";
import type { HostServerDependencies } from "../server.js";

type Summary = PersonalResourceView["entries"][number];
type Detail = z.infer<typeof PersonalResourceDetailSchema>["data"];
type DetailEnvironment = Extract<Detail, { kind: "environment" }>["environments"][number];
type MachinePage = {
  readonly tx: PersonalMutationTransaction;
  readonly deviceIds: readonly string[];
  readonly pendingIds: readonly string[];
  readonly asOf: Date;
  readonly revision: string;
};
type ResourceInput = {
  readonly kind: PersonalResourceKind;
  readonly expectedRevision: string;
  readonly id?: string | undefined;
  readonly cursor?: string | undefined;
};
const catalogKey = z.tuple([
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  z.int().positive().max(maxHarnessModelsPerCatalog),
]);
const maxRows = 100;

function summary(entries: readonly Summary[], incomplete = false): PersonalResourceView {
  const kept: Summary[] = [];
  let bytes = 512;
  for (const entry of entries) {
    const next = { ...entry, ...(entry.label ? { label: utf8Prefix(entry.label, 256) } : {}) };
    bytes += Buffer.byteLength(JSON.stringify(next)) + 1;
    if (kept.length === 32 || bytes > 32 * 1024) break;
    kept.push(next);
  }
  const hasMore = incomplete || kept.length < entries.length;
  return PersonalResourceViewSchema.parse({ entries: kept, complete: !hasMore, hasMore });
}

function conflict(): never {
  throw new OpensteerError({
    code: "conflict",
    message: "This resource changed. Reload its current list.",
    retryable: true,
  });
}

const resourceCursor = z.strictObject({
  ownerId: z.string(),
  revision: z.string(),
  kind: z.string(),
  id: z.string().nullable(),
  after: z.string(),
  asOf: z.iso.datetime().optional(),
});

export class PersonalResources {
  readonly #dependencies: HostServerDependencies;
  readonly #machines: (
    session: AuthenticatedSession,
    page: MachinePage,
  ) => Promise<readonly MachineSummary[]>;

  constructor(
    dependencies: HostServerDependencies,
    machines: (
      session: AuthenticatedSession,
      page: MachinePage,
    ) => Promise<readonly MachineSummary[]>,
  ) {
    this.#dependencies = dependencies;
    this.#machines = machines;
  }

  authorize(tx: PersonalMutationTransaction, viewerId: UserId) {
    return authorizedSyncState(tx, viewerId);
  }

  isCurrent(kind: PersonalResourceKind, revision: string) {
    return this.#dependencies.resourceObservations?.isCurrent(kind, revision) ?? true;
  }

  async initial(tx: PersonalMutationTransaction, viewerId: UserId) {
    const settings = await tx
      .selectFrom("personalSettings")
      .select(["ownerName", "agentHomeComputerId"])
      .where("ownerId", "=", viewerId)
      .limit(1)
      .executeTakeFirst();
    return [
      { kind: "settings" as const, view: summary(settings ? [{ id: "personal" }] : []) },
      {
        kind: "owner-profile" as const,
        view: summary(settings ? [{ id: viewerId, label: settings.ownerName ?? "You" }] : []),
      },
      {
        kind: "agent-home-settings" as const,
        view: summary(settings ? [{ id: settings.agentHomeComputerId }] : []),
      },
    ];
  }

  async get(session: AuthenticatedSession, kind: PersonalResourceKind) {
    await this.#dependencies.resourceObservations?.waitForCurrent([kind]);
    const result = await withPersonalSyncRead(this.#dependencies.store.database, async (tx) => {
      const state = await authorizedSyncState(tx, session.user.id);
      const revision = state.resourceRevisions[kind];
      if (!this.isCurrent(kind, revision)) return conflict();
      return {
        revision,
        view: await this.#summaryAt(tx, session, kind, revision),
      };
    });
    return this.isCurrent(kind, result.revision) ? result : conflict();
  }

  async watched(
    session: AuthenticatedSession,
    interests: readonly PersonalResourceKind[],
    installed: Partial<PersonalResourceRevisions>,
    signal: AbortSignal,
  ) {
    await this.#dependencies.resourceObservations?.waitForCurrent(interests);
    signal.throwIfAborted();
    return withPersonalSyncRead(this.#dependencies.store.database, async (tx) => {
      const state = await authorizedSyncState(tx, session.user.id);
      const views = [];
      for (const kind of interests) {
        signal.throwIfAborted();
        const revision = state.resourceRevisions[kind];
        if (installed[kind] === revision) continue;
        views.push({ kind, revision, view: await this.#summaryAt(tx, session, kind, revision) });
      }
      return views;
    });
  }

  async #summaryAt(
    tx: PersonalMutationTransaction,
    session: AuthenticatedSession,
    kind: PersonalResourceKind,
    revision: string,
  ) {
    const ownerId = session.user.id;
    switch (kind) {
      case "identity":
        return summary([{ id: "identity" }]);
      case "settings":
      case "owner-profile":
      case "agent-home-settings":
        return (await this.initial(tx, ownerId)).find((entry) => entry.kind === kind)!.view;
      case "machine": {
        const rows = await readMachineResourceKeys(tx, ownerId, { asOf: new Date(), limit: 33 });
        return summary(rows.map(({ id, name, status }) => ({ id, label: name, status })));
      }
      case "tab":
      case "tab-layout": {
        const rows = await tx
          .selectFrom("personalTabs")
          .select(["id", "title"])
          .where("ownerId", "=", ownerId)
          .where("closedAt", "is", null)
          .orderBy("id")
          .limit(33)
          .execute();
        return summary(rows.map(({ id, title }) => ({ id, label: title })));
      }
      case "browser-home":
      case "browser-placement": {
        const rows = await readBrowserHomeResourcePage(tx, ownerId, { limit: 33 });
        if (kind === "browser-home")
          return summary(rows.map(({ id, name }) => ({ id, label: name })));
        const placements = this.#placementsAt(rows, revision);
        return summary(
          placements.map(({ runnerId, available }) => ({
            id: runnerId,
            status: available ? "available" : "unavailable",
          })),
          rows.length > 32,
        );
      }
      case "browser-availability":
        return summary([
          {
            id: "browser",
            status: (await this.#browserAvailable(tx, ownerId, revision))
              ? "available"
              : "unavailable",
          },
        ]);
      case "environment":
      case "harness-auth":
      case "harness-catalog": {
        const rows = await tx
          .selectFrom("executionEnvironments as env")
          .innerJoin("personalSettings as settings", "settings.agentHomeComputerId", "env.runnerId")
          .innerJoin("runners", "runners.id", "env.runnerId")
          .select(["env.id", "env.name", "runners.id as runnerId", "runners.connectionGeneration"])
          .where("settings.ownerId", "=", ownerId)
          .where("runners.revokedAt", "is", null)
          .orderBy("env.id")
          .limit(33)
          .execute();
        return summary(
          rows.map(({ id, name, runnerId, connectionGeneration }) => ({
            id,
            label: name,
            status: this.#runnerAt(id, runnerId, revision, connectionGeneration)
              ? "connected"
              : "disconnected",
          })),
        );
      }
      case "harness": {
        const rows = await tx
          .selectFrom("harnessInstances as harness")
          .innerJoin("executionEnvironments as env", "env.id", "harness.environmentId")
          .innerJoin("personalSettings as settings", "settings.agentHomeComputerId", "env.runnerId")
          .innerJoin("runners", "runners.id", "env.runnerId")
          .select(["harness.id", "harness.name", "harness.enabled"])
          .where("settings.ownerId", "=", ownerId)
          .where("harness.removedAt", "is", null)
          .where("runners.revokedAt", "is", null)
          .orderBy("harness.id")
          .limit(33)
          .execute();
        return summary(
          rows.map(({ id, name, enabled }) => ({
            id,
            label: name,
            status: enabled ? "enabled" : "disabled",
          })),
        );
      }
      case "browser-profile": {
        const rows = await tx
          .selectFrom("browserProfiles")
          .select(["id", "name"])
          .where("ownerId", "=", ownerId)
          .where("archivedAt", "is", null)
          .orderBy("id")
          .limit(33)
          .execute();
        return summary(rows.map(({ id, name }) => ({ id, label: name })));
      }
    }
  }

  #runnerAt(
    id: import("@opensteer/core").EnvironmentId,
    runnerId: RunnerId | null,
    revision: string,
    connectionGeneration: string | undefined,
  ) {
    const { runnerObservations, runners } = this.#dependencies;
    if (runnerObservations)
      return !runnerId || connectionGeneration === undefined
        ? undefined
        : runnerObservations.readRunner(runnerId, revision, connectionGeneration)?.identity;
    return runners.identityForEnvironment(id);
  }

  #placementsAt(rows: readonly { id: RunnerId; connectionGeneration: string }[], revision: string) {
    const observations = this.#dependencies.browserPlacementObservations;
    if (!observations)
      return this.#dependencies.browser.resourcePlacements(rows.map(({ id }) => id));
    const cut = BigInt(revision);
    return rows.flatMap(({ id, connectionGeneration }) => {
      const observed = observations.get(id);
      return observed && observed.revision <= cut && observed.generation === connectionGeneration
        ? [observed.placement]
        : [];
    });
  }

  async #browserAvailable(tx: PersonalMutationTransaction, ownerId: UserId, revision: string) {
    const observations = this.#dependencies.browserPlacementObservations;
    if (observations) {
      const cut = BigInt(revision);
      return hasEligibleBrowserPlacement(
        tx,
        ownerId,
        [...observations].flatMap(([id, observed]) =>
          observed.revision <= cut && observed.placement.available
            ? [{ id, generation: observed.generation }]
            : [],
        ),
      );
    }
    for (const placement of this.#dependencies.browser.resourcePlacements())
      if (placement.available && (await isEligibleBrowserRunner(tx, ownerId, placement.runnerId)))
        return true;
    return false;
  }

  async detail(session: AuthenticatedSession, input: ResourceInput) {
    await this.#dependencies.resourceObservations?.waitForCurrent([input.kind]);
    const result = await withPersonalSyncRead(this.#dependencies.store.database, async (tx) => {
      const ownerId = session.user.id;
      const state = await authorizedSyncState(tx, ownerId);
      const revision = state.resourceRevisions[input.kind];
      if (revision !== input.expectedRevision || !this.isCurrent(input.kind, revision))
        return conflict();
      let after: string | undefined;
      let asOf = new Date();
      if (input.cursor) {
        try {
          const cursor = resourceCursor.parse(
            JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
          );
          if (
            cursor.ownerId !== ownerId ||
            cursor.kind !== input.kind ||
            cursor.revision !== revision ||
            cursor.id !== (input.id ?? null)
          )
            return conflict();
          after = cursor.after;
          if (cursor.asOf) asOf = new Date(cursor.asOf);
        } catch (error) {
          if (error instanceof OpensteerError) throw error;
          throw new OpensteerError({ code: "bad_request", message: "Invalid resource cursor." });
        }
      }
      const afterId = after ? { after } : {};
      const targetId = input.id ? { id: input.id } : {};
      const store = new OpensteerStore(tx);
      const page = <Row extends { id: string }>(
        rows: readonly Row[],
        dataFor: (selected: Row[], complete: boolean) => Detail,
      ) => {
        const limit = Math.min(rows.length, maxRows);
        const nextCursor = (id: string) =>
          Buffer.from(
            JSON.stringify({
              ownerId,
              revision,
              kind: input.kind,
              id: input.id ?? null,
              after: id,
              ...(input.kind === "machine" ? { asOf: asOf.toISOString() } : {}),
            }),
          ).toString("base64url");
        const candidate = (count: number) => ({
          revision,
          data: dataFor(rows.slice(0, count), count === rows.length),
          next: count && count < rows.length ? nextCursor(rows[count - 1]!.id) : null,
        });
        const fits = (value: ReturnType<typeof candidate>) =>
          Buffer.byteLength(JSON.stringify(rpcSuccess(value))) <= 64 * 1024;
        let accepted = candidate(limit);
        if (fits(accepted)) return PersonalResourceDetailSchema.parse(accepted);
        let lower = 1;
        let upper = limit - 1;
        let fitting = 0;
        while (lower <= upper) {
          const middle = Math.floor((lower + upper) / 2);
          const next = candidate(middle);
          if (fits(next)) {
            fitting = middle;
            accepted = next;
            lower = middle + 1;
          } else upper = middle - 1;
        }
        if (!fitting)
          throw new OpensteerError({
            code: "resource_exhausted",
            message: "This resource exceeds the detail limit.",
          });
        return PersonalResourceDetailSchema.parse(accepted);
      };
      const kind = input.kind;
      if (kind === "machine") {
        const rows = await readMachineResourceKeys(tx, ownerId, {
          ...afterId,
          ...targetId,
          asOf,
          limit: maxRows + 1,
        });
        const candidates = rows.slice(0, maxRows);
        const values = await this.#machines(session, {
          tx,
          asOf,
          revision,
          deviceIds: candidates.filter(({ source }) => source === "device").map(({ id }) => id),
          pendingIds: candidates.filter(({ source }) => source === "pending").map(({ id }) => id),
        });
        const byId = new Map(values.map((machine) => [machine.id, machine]));
        return page(rows, (selected) => ({
          kind,
          machines: selected.flatMap(({ id }) => {
            const machine = byId.get(id);
            return machine ? [machine] : [];
          }),
        }));
      }
      if (kind === "tab") {
        const rows = await this.#dependencies.tabs.resourceTabs(ownerId, tx, {
          ...(after ? { after: TabIdSchema.parse(after) } : {}),
          ...(input.id ? { id: TabIdSchema.parse(input.id) } : {}),
          limit: maxRows + 1,
        });
        return page(rows, (selected, complete) => ({
          kind,
          tabs: {
            tabs: selected.flatMap(({ tab }) => (tab ? [tab] : [])),
            layout: { revision: 0, items: [] },
            complete,
          },
        }));
      }
      if (kind === "tab-layout") {
        const layout = await this.#dependencies.tabs.resourceLayout(ownerId, tx, {
          ...targetId,
          after: z
            .int()
            .nonnegative()
            .max(tabsMaxPerOwner + tabGroupsMaxPerOwner)
            .parse(Number(after ?? 0)),
          limit: maxRows + 1,
        });
        return page(
          layout.entries.map((entry) => ({ ...entry, id: String(entry.ordinal) })),
          (selected, complete) => ({
            kind,
            tabs: {
              tabs: [],
              layout: {
                revision: layout.revision,
                items: selected.map(({ item }) => item),
              },
              complete,
            },
          }),
        );
      }
      if (kind === "browser-home" || kind === "browser-placement") {
        const rows = await readBrowserHomeResourcePage(tx, ownerId, {
          ...(after ? { after: RunnerIdSchema.parse(after) } : {}),
          ...(input.id ? { id: RunnerIdSchema.parse(input.id) } : {}),
          limit: maxRows + 1,
        });
        if (kind === "browser-home")
          return page(rows, (selected) => ({
            kind,
            homes: selected.map(({ id }) => id),
          }));
        const placements = this.#placementsAt(rows.slice(0, maxRows), revision);
        const byId = new Map(placements.map((placement) => [placement.runnerId, placement]));
        return page(rows, (selected) => ({
          kind,
          placements: selected.flatMap(({ id }) => {
            const placement = byId.get(id);
            return placement ? [placement] : [];
          }),
        }));
      }
      if (kind === "harness-catalog") {
        const models = await readHarnessCatalogModelPage(tx, ownerId, {
          ...(input.id ? { environmentId: EnvironmentIdSchema.parse(input.id) } : {}),
          ...(after ? { after: catalogKey.parse(JSON.parse(after)) } : {}),
          limit: maxRows + 1,
        });
        const ids = [
          ...new Set(models.slice(0, maxRows).map(({ environmentId }) => environmentId)),
        ];
        const environments = await this.#environments(store, tx, ownerId, revision, {
          ids,
          limit: maxRows,
        });
        return page(
          models.map((row) => ({
            ...row,
            id: JSON.stringify([row.environmentId, row.harnessInstanceId, row.ordinal]),
          })),
          (rows) => {
            const catalogs = new Map<string, DetailEnvironment["harnessCatalogs"]>();
            for (const row of rows) {
              const list = catalogs.get(row.environmentId) ?? [];
              const previous = list.at(-1);
              if (
                previous?.harnessInstanceId === row.harnessInstanceId &&
                "models" in previous &&
                "models" in row.catalog
              ) {
                previous.models.push(...row.catalog.models);
              } else {
                const catalog = { ...row.catalog, capturedAt: row.capturedAt.toISOString() };
                list.push(
                  "models" in catalog ? { ...catalog, models: [...catalog.models] } : catalog,
                );
              }
              catalogs.set(row.environmentId, list);
            }
            return {
              kind,
              environments: environments.flatMap((environment) => {
                const harnessCatalogs = catalogs.get(environment.id);
                return harnessCatalogs ? [{ ...environment, harnessCatalogs }] : [];
              }),
            };
          },
        );
      }
      if (
        kind === "settings" ||
        kind === "agent-home-settings" ||
        kind === "identity" ||
        kind === "owner-profile" ||
        kind === "browser-availability"
      ) {
        return PersonalResourceDetailSchema.parse({
          revision,
          data: await this.#compactDetail(tx, store, session, kind, revision),
          next: null,
        });
      }
      if (kind === "browser-profile") {
        let query = tx
          .selectFrom("browserProfiles as profile")
          .leftJoin("browserProfileDeletions as deletion", (join) =>
            join
              .onRef("deletion.profileId", "=", "profile.id")
              .on("deletion.state", "in", ["pending-computer", "pending-restart"]),
          )
          .select([
            "profile.id",
            "profile.name",
            "profile.homeRunnerId",
            "profile.archivedAt",
            "deletion.runnerId as computerId",
            "deletion.state as deletionState",
          ])
          .where("profile.ownerId", "=", ownerId)
          .where((eb) =>
            eb.or([eb("profile.archivedAt", "is", null), eb("deletion.profileId", "is not", null)]),
          )
          .orderBy("profile.id")
          .limit(101);
        if (after) query = query.where("profile.id", ">", BrowserProfileIdSchema.parse(after));
        if (input.id)
          query = query.where("profile.id", "=", BrowserProfileIdSchema.parse(input.id));
        return page(await query.execute(), (selected) => ({
          kind: "browser-profile",
          profiles: selected.flatMap(({ archivedAt, id, name, homeRunnerId }) =>
            archivedAt ? [] : [{ id, name, homeRunnerId }],
          ),
          deletions: selected.flatMap(({ id, computerId, deletionState }) =>
            computerId &&
            (deletionState === "pending-computer" || deletionState === "pending-restart")
              ? [{ profileId: id, computerId, state: deletionState }]
              : [],
          ),
        }));
      }
      if (kind === "harness") {
        const [rows, models] = await Promise.all([
          store.listAgentHarnessInstancesForUser(ownerId, {
            includeDisabled: true,
            limit: 101,
            ...(after ? { afterId: HarnessInstanceIdSchema.parse(after) } : {}),
            ...(input.id ? { id: HarnessInstanceIdSchema.parse(input.id) } : {}),
          }),
          store.getAgentHomeSettings(ownerId),
        ]);
        const excluded = new Set(excludedBackgroundAccounts(models.settings));
        return page(
          rows.map((harness) => ({
            ...harnessView(harness),
            automaticEligible:
              harness.sourceId !== "openai-compatible" && !excluded.has(harness.id),
          })),
          (harnesses) => ({ kind: "harness", harnesses }),
        );
      }
      const environments = await this.#environments(store, tx, ownerId, revision, {
        ...(after ? { afterId: EnvironmentIdSchema.parse(after) } : {}),
        ...(input.id ? { id: EnvironmentIdSchema.parse(input.id) } : {}),
        limit: maxRows + 1,
      });
      return page(environments, (rows) => ({ kind, environments: rows }));
    });
    return this.isCurrent(input.kind, result.revision) ? result : conflict();
  }
  async #environments(
    store: OpensteerStore,
    tx: PersonalMutationTransaction,
    ownerId: UserId,
    revision: string,
    {
      limit,
      ...options
    }: { limit: number } & NonNullable<Parameters<OpensteerStore["listEnvironmentsForUser"]>[2]>,
  ): Promise<DetailEnvironment[]> {
    const rows = await store.listEnvironmentsForUser(ownerId, limit, options);
    const runnerIds = [...new Set(rows.flatMap(({ runnerId }) => (runnerId ? [runnerId] : [])))];
    const runners = runnerIds.length
      ? await tx
          .selectFrom("runners")
          .select(["id", "connectionGeneration"])
          .where("id", "in", runnerIds)
          .execute()
      : [];
    const generations = new Map(
      runners.map(({ id, connectionGeneration }) => [id, connectionGeneration]),
    );
    return rows.map((environment) => {
      const runner = this.#runnerAt(
        environment.id,
        environment.runnerId,
        revision,
        environment.runnerId ? generations.get(environment.runnerId) : undefined,
      );
      return {
        ...environment,
        capabilities: [...environment.capabilities],
        connected: !!runner,
        harnessAuthenticationAllowed: true,
        harnessCatalogs: [],
        harnessDrivers: [...(runner?.modules.agents?.harnessDrivers ?? [])],
        providerStateModes: [...(runner?.modules.agents?.providerStateModes ?? [])],
        status: runner ? "connected" : "disconnected",
        can: { executeTasks: !!runner && this.#dependencies.execution.canExecute(environment.id) },
      };
    });
  }

  async #compactDetail(
    tx: PersonalMutationTransaction,
    store: OpensteerStore,
    session: AuthenticatedSession,
    kind:
      "identity" | "owner-profile" | "settings" | "agent-home-settings" | "browser-availability",
    revision: string,
  ): Promise<Detail> {
    const { authenticator, ownerProfile } = this.#dependencies;
    const ownerId = session.user.id;
    switch (kind) {
      case "settings": {
        const [settings, executionPreferences, quietTaskDays] = await Promise.all([
          findPersonalSettings(tx),
          store.getExecutionPreferences(ownerId),
          store.notificationState.quietTaskDaysFor(ownerId),
        ]);
        return { kind, settings, executionPreferences, quietTaskDays };
      }
      case "agent-home-settings":
        return { kind, settings: await findPersonalSettings(tx) };
      case "owner-profile":
        return { kind, ownerProfile: (await ownerProfile?.view()) ?? null };
      case "identity":
        return { kind, identity: await authenticator.identity.configuration() };
      case "browser-availability":
        return { kind, available: await this.#browserAvailable(tx, ownerId, revision) };
    }
  }
}
