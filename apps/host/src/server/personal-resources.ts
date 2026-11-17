import {
  OpensteerError,
  BrowserProfileIdSchema,
  EnvironmentIdSchema,
  HarnessInstanceIdSchema,
  excludedBackgroundAccounts,
  utf8Prefix,
  type AuthenticatedSession,
  type UserId,
} from "@opensteer/core";
import { findPersonalSettings, OpensteerStore } from "@opensteer/database";
import type { PersonalMutationTransaction } from "@opensteer/database/personal-mutation";
import { authorizedSyncState, withPersonalSyncRead } from "@opensteer/database/personal-sync-store";
import type { MachineSummary } from "@opensteer/protocol";
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

const boundary = z.strictObject({
  revision: z.string(),
  kind: z.string(),
  offset: z.int().nonnegative(),
});

const resourceCursor = z.strictObject({
  ownerId: z.string(),
  revision: z.string(),
  kind: z.string(),
  id: z.string().nullable(),
  after: z.string(),
});

export class PersonalResources {
  readonly #dependencies: HostServerDependencies;
  readonly #machines: (session: AuthenticatedSession) => Promise<readonly MachineSummary[]>;

  constructor(
    dependencies: HostServerDependencies,
    machines: (session: AuthenticatedSession) => Promise<readonly MachineSummary[]>,
  ) {
    this.#dependencies = dependencies;
    this.#machines = machines;
  }

  authorize(tx: PersonalMutationTransaction, viewerId: UserId) {
    return authorizedSyncState(tx, viewerId);
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

  #revisions(session: AuthenticatedSession) {
    return withPersonalSyncRead(
      this.#dependencies.store.database,
      async (tx) => (await authorizedSyncState(tx, session.user.id)).resourceRevisions,
    );
  }

  get(session: AuthenticatedSession, kind: PersonalResourceKind) {
    return withPersonalSyncRead(this.#dependencies.store.database, async (tx) => {
      const state = await authorizedSyncState(tx, session.user.id);
      return {
        revision: state.resourceRevisions[kind],
        view: await this.#summaryAt(tx, session, kind, state.resourceRevisions[kind]),
      };
    });
  }

  watched(
    session: AuthenticatedSession,
    interests: readonly PersonalResourceKind[],
    installed: Partial<PersonalResourceRevisions>,
    signal: AbortSignal,
  ) {
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
        const rows = await tx
          .selectFrom("devices")
          .select(["id", "name", "kind"])
          .where("removedAt", "is", null)
          .where((eb) =>
            eb.or([eb("ownerKind", "=", "deployment"), eb("ownerUserId", "=", ownerId)]),
          )
          .orderBy("id")
          .limit(33)
          .execute();
        return summary(rows.map(({ id, name, kind }) => ({ id, label: name, status: kind })));
      }
      case "environment":
      case "harness-auth":
      case "harness-catalog": {
        const rows = await tx
          .selectFrom("executionEnvironments as env")
          .innerJoin("personalSettings as settings", "settings.agentHomeComputerId", "env.runnerId")
          .innerJoin("runners", "runners.id", "env.runnerId")
          .select(["env.id", "env.name", "runners.connectionGeneration"])
          .where("settings.ownerId", "=", ownerId)
          .where("runners.revokedAt", "is", null)
          .orderBy("env.id")
          .limit(33)
          .execute();
        return summary(
          rows.map(({ id, name, connectionGeneration }) => ({
            id,
            label: name,
            status: this.#runnerAt(id, revision, connectionGeneration)
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
      default:
        return this.#summarize(await this.#load(session, kind));
    }
  }

  #runnerAt(
    id: import("@opensteer/core").EnvironmentId,
    revision: string,
    connectionGeneration: string | undefined,
  ) {
    const { runnerObservations, runners } = this.#dependencies;
    if (runnerObservations)
      return connectionGeneration === undefined
        ? undefined
        : runnerObservations.read(id, revision, connectionGeneration);
    return runners.identityForEnvironment(id);
  }

  #keysetDetail(
    session: AuthenticatedSession,
    input: {
      kind: "harness" | "environment" | "harness-catalog" | "harness-auth" | "browser-profile";
      expectedRevision: string;
      id?: string | undefined;
      cursor?: string | undefined;
    },
  ) {
    return withPersonalSyncRead(this.#dependencies.store.database, async (tx) => {
      const ownerId = session.user.id;
      const state = await authorizedSyncState(tx, ownerId);
      const revision = state.resourceRevisions[input.kind];
      if (revision !== input.expectedRevision) return conflict();
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
      const store = new OpensteerStore(tx);
      const page = <Row extends { id: string }>(
        rows: readonly Row[],
        dataFor: (selected: Row[]) => Detail,
      ) => {
        const selected: Row[] = [];
        for (const row of rows.slice(0, 100)) {
          if (Buffer.byteLength(JSON.stringify(dataFor([...selected, row]))) > 63 * 1024) break;
          selected.push(row);
        }
        if (rows.length && !selected.length)
          throw new OpensteerError({
            code: "resource_exhausted",
            message: "This resource exceeds the detail limit.",
          });
        const next =
          rows.length > selected.length
            ? Buffer.from(
                JSON.stringify({
                  ownerId,
                  revision,
                  kind: input.kind,
                  id: input.id ?? null,
                  after: selected.at(-1)!.id,
                }),
              ).toString("base64url")
            : null;
        return PersonalResourceDetailSchema.parse({ revision, data: dataFor(selected), next });
      };
      if (input.kind === "browser-profile") {
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
      if (input.kind === "harness") {
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
      const kind = input.kind;
      const rows = await store.listEnvironmentsForUser(ownerId, 101, {
        ...(after ? { afterId: EnvironmentIdSchema.parse(after) } : {}),
        ...(input.id ? { id: EnvironmentIdSchema.parse(input.id) } : {}),
      });
      const runnerIds = [...new Set(rows.flatMap(({ runnerId }) => (runnerId ? [runnerId] : [])))];
      const [catalogs, runners] = await Promise.all([
        kind === "harness-catalog" ? store.listHarnessCatalogs(rows.map(({ id }) => id)) : [],
        runnerIds.length
          ? tx
              .selectFrom("runners")
              .select(["id", "connectionGeneration"])
              .where("id", "in", runnerIds)
              .execute()
          : [],
      ]);
      const generations = new Map(
        runners.map(({ id, connectionGeneration }) => [id, connectionGeneration]),
      );
      return page(
        rows.map((environment) => {
          const generation = environment.runnerId
            ? generations.get(environment.runnerId)
            : undefined;
          const runner = this.#runnerAt(environment.id, revision, generation);
          return {
            ...environment,
            capabilities: [...environment.capabilities],
            connected: !!runner,
            harnessAuthenticationAllowed: true,
            harnessCatalogs: catalogs
              .filter(({ environmentId }) => environmentId === environment.id)
              .map(({ catalog, capturedAt }) => ({
                ...catalog,
                capturedAt: capturedAt.toISOString(),
              })),
            harnessDrivers: [...(runner?.modules.agents?.harnessDrivers ?? [])],
            providerStateModes: [...(runner?.modules.agents?.providerStateModes ?? [])],
            status: runner ? ("connected" as const) : ("disconnected" as const),
            can: {
              executeTasks: !!runner && this.#dependencies.execution.canExecute(environment.id),
            },
          };
        }),
        (environments) => ({ kind, environments }),
      );
    });
  }

  async detail(
    session: AuthenticatedSession,
    input: {
      readonly kind: PersonalResourceKind;
      readonly expectedRevision: string;
      readonly id?: string | undefined;
      readonly cursor?: string | undefined;
    },
  ) {
    const kind = input.kind;
    if (
      kind === "harness" ||
      kind === "environment" ||
      kind === "harness-auth" ||
      kind === "harness-catalog" ||
      kind === "browser-profile"
    )
      return this.#keysetDetail(session, { ...input, kind });
    const revision = (await this.#revisions(session))[input.kind];
    if (input.expectedRevision !== revision) return conflict();
    let offset = 0;
    if (input.cursor) {
      try {
        const cursor = boundary.parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
        if (cursor.kind !== input.kind || cursor.revision !== revision) return conflict();
        offset = cursor.offset;
      } catch (error) {
        if (error instanceof OpensteerError) throw error;
        throw new OpensteerError({ code: "bad_request", message: "Invalid resource cursor." });
      }
    }
    const data = await this.#load(session, input.kind);
    if ((await this.#revisions(session))[input.kind] !== revision) return conflict();
    const page = <T>(rows: readonly T[], withRows: (rows: T[]) => Detail) => {
      const selected: T[] = [];
      const candidates = rows.slice(offset, offset + 101);
      for (const row of candidates.slice(0, 100)) {
        const next = [...selected, row];
        if (Buffer.byteLength(JSON.stringify(withRows(next))) > 63 * 1024) break;
        selected.push(row);
      }
      if (candidates.length && !selected.length)
        throw new OpensteerError({
          code: "conflict",
          message: "This resource exceeds the detail limit.",
        });
      const next =
        rows.length > offset + selected.length
          ? Buffer.from(
              JSON.stringify({ revision, kind: input.kind, offset: offset + selected.length }),
            ).toString("base64url")
          : null;
      return PersonalResourceDetailSchema.parse({ revision, data: withRows(selected), next });
    };
    switch (data.kind) {
      case "machine":
        return page(
          data.machines.filter(({ id }) => !input.id || id === input.id),
          (machines) => ({ ...data, machines }),
        );
      case "tab":
      case "tab-layout":
        return page(
          data.tabs.tabs.filter(({ tabId }) => !input.id || tabId === input.id),
          (tabs) => ({
            ...data,
            tabs: {
              ...data.tabs,
              tabs,
              complete: data.tabs.complete && tabs.length === data.tabs.tabs.length,
            },
          }),
        );
      case "browser-placement":
        return page(data.placements, (placements) => ({ ...data, placements }));
      case "browser-home":
        return page(data.homes ?? [], (homes) => ({ ...data, homes }));
      default:
        return PersonalResourceDetailSchema.parse({ revision, data, next: null });
    }
  }

  #summarize(data: Detail): PersonalResourceView {
    switch (data.kind) {
      case "environment":
      case "harness-catalog":
      case "harness-auth":
        return summary(
          data.environments.map(({ id, name, status }) => ({ id, label: name, status })),
        );
      case "machine":
        return summary(data.machines.map(({ id, name, status }) => ({ id, label: name, status })));
      case "harness":
        return summary(
          data.harnesses.map(({ id, name, enabled }) => ({
            id,
            label: name,
            status: enabled ? "enabled" : "disabled",
          })),
        );
      case "tab":
      case "tab-layout":
        return summary(
          data.tabs.tabs.map(({ tabId, title }) => ({ id: tabId, label: title })),
          !data.tabs.complete,
        );
      case "browser-profile":
        return summary(data.profiles.map(({ id, name }) => ({ id, label: name })));
      case "browser-placement":
        return summary(
          data.placements.map(({ runnerId, available }) => ({
            id: runnerId,
            status: available ? "available" : "unavailable",
          })),
        );
      case "browser-home":
        return summary((data.homes ?? []).map((id) => ({ id })));
      case "browser-availability":
        return summary([{ id: "browser", status: data.available ? "available" : "unavailable" }]);
      case "owner-profile":
        return summary(
          data.ownerProfile ? [{ id: "owner", label: data.ownerProfile.name ?? "You" }] : [],
        );
      case "identity":
        return summary([{ id: "identity" }]);
      default:
        return summary(data.settings ? [{ id: "personal" }] : []);
    }
  }

  async #load(session: AuthenticatedSession, kind: PersonalResourceKind): Promise<Detail> {
    const { store, browser, tabs, authenticator, ownerProfile } = this.#dependencies;
    const ownerId = session.user.id;
    switch (kind) {
      case "settings": {
        const [settings, executionPreferences, quietTaskDays] = await Promise.all([
          findPersonalSettings(store.database),
          store.getExecutionPreferences(ownerId),
          store.notificationState.quietTaskDaysFor(ownerId),
        ]);
        return { kind, settings, executionPreferences, quietTaskDays };
      }
      case "agent-home-settings":
        return { kind, settings: await findPersonalSettings(store.database) };
      case "owner-profile":
        return { kind, ownerProfile: (await ownerProfile?.view()) ?? null };
      case "identity":
        return { kind, identity: await authenticator.identity.configuration() };
      case "machine":
        return { kind, machines: [...(await this.#machines(session))] };
      case "environment":
      case "harness":
      case "harness-auth":
      case "harness-catalog":
        throw new Error("Execution resources require a revision cut.");
      case "tab":
      case "tab-layout":
        return { kind, tabs: await tabs.bootstrap(ownerId, 240 * 1024) };
      default: {
        const view = await browser.workspaceBootstrap(ownerId);
        switch (kind) {
          case "browser-profile":
            return {
              kind,
              profiles: view.profiles,
              ...(view.profileDeletions ? { deletions: view.profileDeletions } : {}),
            };
          case "browser-placement":
            return { kind, placements: view.placements };
          case "browser-home":
            return { kind, homes: view.profileHomes };
          case "browser-availability":
            return { kind, available: view.available };
        }
      }
    }
  }
}
