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
  runnerAgentToolsFailure,
  type AuthenticatedSession,
  type UserId,
} from "@opensteer/core";
import {
  findPersonalSettings,
  isEligibleBrowserRunner,
  readBrowserHomeResourcePage,
  OpensteerStore,
  readHarnessCatalogModelPage,
  readMachineResourceKeys,
} from "@opensteer/database";
import type { PersonalMutationTransaction } from "@opensteer/database/personal-mutation";
import { authorizedSyncState, withPersonalSyncRead } from "@opensteer/database/personal-sync-store";
import {
  maxHarnessModelsPerCatalog,
  rpcSuccess,
  type MachineListSummary,
} from "@opensteer/protocol";
import {
  pluginChangeResources,
  PersonalResourceDetailSchema,
  type PersonalResourceKind,
} from "@opensteer/protocol/resources";
import { z } from "zod";
import { harnessView } from "../administration/authority.js";
import type { HostServerDependencies } from "../server.js";

type Detail = z.infer<typeof PersonalResourceDetailSchema>["data"];
type DetailEnvironment = Extract<Detail, { kind: "environment" }>["environments"][number];
type MachinePage = {
  readonly tx: PersonalMutationTransaction;
  readonly deviceIds: readonly string[];
  readonly pendingIds: readonly string[];
  readonly asOf: Date;
};
type ResourceInput = {
  readonly kind: PersonalResourceKind;
  readonly id?: string | undefined;
  readonly cursor?: string | undefined;
};
const catalogKey = z.tuple([
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  z.int().positive().max(maxHarnessModelsPerCatalog),
]);
const maxRows = 100;

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
});

export class PersonalResources {
  readonly #dependencies: HostServerDependencies;
  readonly #machines: (
    session: AuthenticatedSession,
    page: MachinePage,
  ) => Promise<readonly MachineListSummary[]>;

  constructor(
    dependencies: HostServerDependencies,
    machines: (
      session: AuthenticatedSession,
      page: MachinePage,
    ) => Promise<readonly MachineListSummary[]>,
  ) {
    this.#dependencies = dependencies;
    this.#machines = machines;
  }

  authorize(tx: PersonalMutationTransaction, viewerId: UserId) {
    return authorizedSyncState(tx, viewerId);
  }

  revisions(kinds: readonly PersonalResourceKind[]) {
    return this.#dependencies.resourceRevisions.read(kinds);
  }

  #browserAvailable(tx: PersonalMutationTransaction, ownerId: UserId) {
    return this.#dependencies.browser
      .resourcePlacements()
      .filter(({ available }) => available)
      .reduce<Promise<boolean>>(
        async (found, { runnerId }) =>
          (await found) || isEligibleBrowserRunner(tx, ownerId, runnerId),
        Promise.resolve(false),
      );
  }

  async detail(session: AuthenticatedSession, input: ResourceInput) {
    // Taken before the read opens, so the data is never older than the revision it reports.
    const revision = this.#dependencies.resourceRevisions.get(input.kind);
    return withPersonalSyncRead(this.#dependencies.store.database, async (tx) => {
      const ownerId = session.user.id;
      await authorizedSyncState(tx, ownerId);
      let after: string | undefined;
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
        } catch (error) {
          if (error instanceof OpensteerError) throw error;
          throw new OpensteerError({ code: "bad_request", message: "Invalid resource cursor." });
        }
      }
      const afterId = after ? { after } : {};
      const targetId = input.id ? { id: input.id } : {};
      if (input.kind === "plugin-engine")
        return PersonalResourceDetailSchema.parse({
          revision,
          data: {
            kind: input.kind,
            engine: this.#dependencies.plugins?.engineState() ?? { status: "idle" },
          },
          next: null,
        });
      // Revision-only kinds: a reader learns that something changed and rereads its own view.
      if (
        input.kind === "team-replies" ||
        pluginChangeResources.some((kind) => kind === input.kind)
      )
        return PersonalResourceDetailSchema.parse({
          revision,
          data: { kind: input.kind },
          next: null,
        });
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
        const asOf = new Date();
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
          deviceIds: candidates.filter(({ source }) => source === "device").map(({ id }) => id),
          pendingIds: candidates.filter(({ source }) => source === "pending").map(({ id }) => id),
        });
        const byId = new Map(values.map((machine) => [machine.id, machine]));
        return page(rows, (selected) => ({
          kind,
          // The placed-task count is read only by `machines.list`; nothing here could keep it true.
          machines: selected.flatMap(({ id }) => {
            const machine = byId.get(id);
            if (!machine) return [];
            const { pinnedThreads: _placed, ...held } = machine;
            return [held];
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
        const placements = this.#dependencies.browser.resourcePlacements(
          rows.slice(0, maxRows).map(({ id }) => id),
        );
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
        const environments = await this.#environments(store, ownerId, {
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
              // Only this owner's environments; each by id, its detail is the environment resource.
              environments: environments.flatMap(({ id }) => {
                const harnessCatalogs = catalogs.get(id);
                return harnessCatalogs ? [{ id, harnessCatalogs }] : [];
              }),
            };
          },
        );
      }
      if (
        kind === "settings" ||
        kind === "identity" ||
        kind === "owner-profile" ||
        kind === "browser-availability"
      ) {
        return PersonalResourceDetailSchema.parse({
          revision,
          data: await this.#compactDetail(tx, store, session, kind),
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
      const environments = await this.#environments(store, ownerId, {
        ...(after ? { afterId: EnvironmentIdSchema.parse(after) } : {}),
        ...(input.id ? { id: EnvironmentIdSchema.parse(input.id) } : {}),
        limit: maxRows + 1,
      });
      return page(environments, (rows) => ({ kind, environments: rows }));
    });
  }
  async #environments(
    store: OpensteerStore,
    ownerId: UserId,
    {
      limit,
      ...options
    }: { limit: number } & NonNullable<Parameters<OpensteerStore["listEnvironmentsForUser"]>[2]>,
  ): Promise<DetailEnvironment[]> {
    const rows = await store.listEnvironmentsForUser(ownerId, limit, options);
    return rows.map((environment) => {
      const runner = this.#dependencies.runners.identityForEnvironment(environment.id);
      const toolFailure = runner && runnerAgentToolsFailure([...runner.capabilities]);
      return {
        ...environment,
        capabilities: [...environment.capabilities],
        connected: !!runner,
        harnessAuthenticationAllowed: true,
        harnessCatalogs: [],
        harnessDrivers: (runner?.modules.agents?.harnessDrivers ?? []).map((driver) =>
          toolFailure
            ? {
                driverKind: driver.driverKind,
                readiness: "unavailable" as const,
                reason: toolFailure,
              }
            : driver,
        ),
        providerStateModes: [...(runner?.modules.agents?.providerStateModes ?? [])],
        status: runner ? "connected" : "disconnected",
        can: {
          executeTasks:
            !!runner && !toolFailure && this.#dependencies.execution.canExecute(environment.id),
        },
      };
    });
  }

  async #compactDetail(
    tx: PersonalMutationTransaction,
    store: OpensteerStore,
    session: AuthenticatedSession,
    kind: "identity" | "owner-profile" | "settings" | "browser-availability",
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
      case "owner-profile":
        return { kind, ownerProfile: (await ownerProfile?.view()) ?? null };
      case "identity":
        return { kind, identity: await authenticator.identity.configuration() };
      case "browser-availability":
        return { kind, available: await this.#browserAvailable(tx, ownerId) };
    }
  }
}
