import { createHash } from "node:crypto";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import {
  AccountId,
  AppId,
  BlobKey,
  OwnerId,
  StorageError,
  StorageHost,
  linkedRequirements,
  resolveLinkedAccounts,
  type AccountRequirement,
  type App,
  type BlobStorage,
  type PluginEngine,
  type ResourceLifecycle,
  type VersionId,
} from "@opensteer/plugin-engine-sdk/core";
import { appProtocol } from "@opensteer/plugin-engine-sdk/node";
import { PluginServiceError, type PluginConsent } from "./engine-protocol.js";

const table = ["opensteer_account_links"];
const rows = Schema.Array(
  Schema.Struct({
    requirement: Schema.String,
    scope: Schema.Literals(["app", "user"]),
    account: AccountId,
    consent: Schema.String,
  }),
);
const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new StorageError()));
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b)))
      : field,
  );

export const migrateEngineProduct = (sql: SqlClient.SqlClient) =>
  sql.unsafe(`
  CREATE TABLE IF NOT EXISTS opensteer_account_links (
    app text NOT NULL REFERENCES plugin_engine_apps(id) ON DELETE CASCADE,
    requirement text NOT NULL, scope text NOT NULL CHECK (scope IN ('app', 'user')),
    account text NOT NULL REFERENCES plugin_engine_accounts(id) ON DELETE CASCADE,
    consent text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (app, requirement, scope, account)
  )`);

export function engineAccounts(options: {
  sql: SqlClient.SqlClient;
  engine: Effect.Effect<PluginEngine>;
  owner: OwnerId;
  blobs: BlobStorage;
  authorizeBackground(plugin: string): Effect.Effect<void, Error>;
}) {
  const { sql, engine, owner, blobs } = options;
  const read = (sdk: PluginEngine, app: AppId) =>
    sdk[StorageHost].read(
      table,
      sql`select requirement, scope, account, consent from opensteer_account_links where app = ${app} order by created_at, account`,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(rows)), storage);
  const lock = (app: AppId) =>
    storage(sql`select id from plugin_engine_apps where id = ${app} for no key update`);
  const get = (app: AppId) => Effect.flatMap(engine, (sdk) => sdk.apps.get({ app, owner }));
  const requirement = (app: App, name: string, scope: "app" | "user") => {
    const required = app.requirements.accounts[name];
    return required?.scope === scope
      ? Effect.succeed(required)
      : Effect.fail(
          new PluginServiceError(
            "consent-changed",
            "Plugin account requirement changed; review it again",
          ),
        );
  };
  const disclosure = (app: App) =>
    Effect.gen(function* () {
      if (!app.activeVersion)
        return yield* Effect.fail(new PluginServiceError("invalid", "Plugin is not deployed"));
      const sdk = yield* engine;
      const version = yield* sdk.apps.version({ app: app.id, owner, version: app.activeVersion });
      const stored = yield* blobs.get(BlobKey.make(`${version.build}/worker.json`));
      if (Option.isNone(stored))
        return yield* Effect.fail(
          new PluginServiceError("engine", "Plugin build metadata is unavailable"),
        );
      const metadata = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ protocol: Schema.Number })),
      )(new TextDecoder().decode(stored.value));
      return (yield* appProtocol(metadata.protocol)).sealedCredentials;
    });
  const snapshot = (app: App, required: AccountRequirement) =>
    Effect.gen(function* () {
      const sealed = yield* disclosure(app);
      const sites = [...(required.definition.hosts ?? [])].sort();
      const credential = sealed && sites.length > 0 ? ("sealed" as const) : ("value" as const);
      return {
        sites,
        credential,
        digest: createHash("sha256").update(canonical({ required, credential })).digest("hex"),
      } satisfies PluginConsent;
    });
  const currentLinks = (app: App) =>
    Effect.gen(function* () {
      const sdk = yield* engine;
      const links = (yield* read(sdk, app.id)).filter(
        (link) => app.requirements.accounts[link.requirement]?.scope === link.scope,
      );
      for (const link of links) {
        const required = app.requirements.accounts[link.requirement];
        if (!required) return yield* new StorageError();
        if (canonical(yield* snapshot(app, required)) !== link.consent)
          return yield* Effect.fail(
            new PluginServiceError(
              "consent-changed",
              "Plugin credential declaration changed; the person must review and link the account again",
            ),
          );
      }
      return links;
    });
  const atVersion = (app: App, version?: VersionId) =>
    Effect.gen(function* () {
      const sdk = yield* engine;
      return version === undefined || version === app.activeVersion
        ? app
        : {
            ...app,
            requirements: (yield* sdk.apps.version({ app: app.id, owner, version })).requirements,
            activeVersion: version,
          };
    });
  const permittedLinks = (app: App, retained: App) =>
    Effect.gen(function* () {
      const active = yield* currentLinks(app);
      if (retained === app) return active;
      const links = yield* currentLinks(retained);
      return links.filter((link) =>
        active.some(
          (row) =>
            row.requirement === link.requirement &&
            row.scope === link.scope &&
            row.account === link.account,
        ),
      );
    });
  const resolved = (app: App, version?: VersionId) =>
    Effect.gen(function* () {
      const sdk = yield* engine;
      const retained = yield* atVersion(app, version);
      const links = yield* permittedLinks(app, retained);
      const accounts = new Map(
        (yield* sdk.accounts.list({ owner })).map((account) => [account.id, account]),
      );
      const linked = links.flatMap((link) => {
        const account = accounts.get(link.account);
        return account === undefined ? [] : [{ ...link, account }];
      });
      return {
        appLinks: linkedRequirements(
          retained.requirements.accounts,
          "app",
          linked.filter((link) => link.scope === "app"),
        ),
        userLinks: linkedRequirements(
          retained.requirements.accounts,
          "user",
          linked.filter((link) => link.scope === "user"),
        ),
      };
    });
  const accounts = (app: AppId, version?: VersionId) =>
    Effect.gen(function* () {
      const target = yield* get(app);
      return yield* resolveLinkedAccounts({
        app,
        version: version ?? target.activeVersion,
        ...(yield* resolved(target, version)),
      });
    });
  const syncSource = (sdk: PluginEngine, app: AppId, account: AccountId) =>
    Effect.gen(function* () {
      const links = (yield* read(sdk, app)).filter((link) => link.account === account);
      if (links.length)
        yield* sdk.webhooks.link({
          app,
          account,
          ...(links.some((link) => link.scope === "app") ? {} : { actor: owner }),
        });
      else
        yield* sdk.webhooks
          .unlink({ app, account })
          .pipe(Effect.catchTag("WebhookNotFound", () => Effect.void));
    });
  const review = (input: { plugin: string; requirement: string; scope: "app" | "user" }) =>
    Effect.gen(function* () {
      const app = yield* get(AppId.make(input.plugin));
      return yield* snapshot(app, yield* requirement(app, input.requirement, input.scope));
    });
  const link = (input: {
    plugin: string;
    requirement: string;
    scope: "app" | "user";
    account: string;
    consent: PluginConsent;
  }) =>
    Effect.gen(function* () {
      const sdk = yield* engine;
      const appId = AppId.make(input.plugin);
      const accountId = AccountId.make(input.account);
      return yield* sdk[StorageHost].transaction(
        Effect.gen(function* () {
          yield* lock(appId);
          const app = yield* get(appId);
          const required = yield* requirement(app, input.requirement, input.scope);
          const reviewed = yield* snapshot(app, required);
          if (canonical(reviewed) !== canonical(input.consent))
            return yield* Effect.fail(
              new PluginServiceError("consent-changed", "Plugin declaration changed since review"),
            );
          const account = yield* sdk.accounts.get({ account: accountId, owner });
          if (required.provider !== account.provider)
            return yield* Effect.fail(
              new PluginServiceError("invalid", "Account provider does not match the requirement"),
            );
          const replaced =
            required.cardinality === "one"
              ? (yield* read(sdk, appId)).filter(
                  (row) =>
                    row.requirement === input.requirement &&
                    row.scope === input.scope &&
                    row.account !== accountId,
                )
              : [];
          for (const row of replaced)
            yield* sdk[StorageHost].write(
              table,
              sql`delete from opensteer_account_links where app = ${appId} and requirement = ${input.requirement} and scope = ${input.scope} and account = ${row.account}`,
            );
          yield* sdk[StorageHost].write(
            table,
            sql`insert into opensteer_account_links (app, requirement, scope, account, consent) values (${appId}, ${input.requirement}, ${input.scope}, ${accountId}, ${canonical(reviewed)}) on conflict (app, requirement, scope, account) do update set consent = excluded.consent`,
          );
          for (const row of replaced) yield* syncSource(sdk, appId, row.account);
          yield* syncSource(sdk, appId, accountId);
          return reviewed;
        }),
      );
    });
  const unlink = (input: {
    plugin: string;
    requirement: string;
    scope: "app" | "user";
    account: string;
  }) =>
    Effect.gen(function* () {
      const sdk = yield* engine;
      const app = AppId.make(input.plugin);
      const account = AccountId.make(input.account);
      return yield* sdk[StorageHost].transaction(
        Effect.gen(function* () {
          yield* lock(app);
          yield* get(app);
          yield* sdk[StorageHost].write(
            table,
            sql`delete from opensteer_account_links where app = ${app} and requirement = ${input.requirement} and scope = ${input.scope} and account = ${account}`,
          );
          yield* syncSource(sdk, app, account);
        }),
      );
    });
  const appResolving: ResourceLifecycle["appResolving"] = (app, userAccounts, appUses) =>
    Effect.gen(function* () {
      if (app.owner !== owner) return yield* new StorageError();
      yield* storage(options.authorizeBackground(app.id));
      const target = yield* storage(get(app.id));
      const retained = yield* storage(atVersion(target, app.version));
      const links = yield* storage(permittedLinks(target, retained));
      const refused = new Set<AccountId>();
      for (const account of userAccounts)
        if (
          account.owner !== owner ||
          !links.some((row) => row.scope === "user" && row.account === account.id)
        )
          refused.add(account.id);
      for (const use of appUses)
        if (
          use.account.owner !== owner ||
          !links.some(
            (row) =>
              row.scope === "app" &&
              row.requirement === use.requirement &&
              row.account === use.account.id,
          )
        )
          refused.add(use.account.id);
      return new Set(
        [...userAccounts, ...appUses.map((use) => use.account)]
          .filter((account) => !refused.has(account.id))
          .map((account) => account.id),
      );
    });
  const hooks: ResourceLifecycle = {
    userLinks: ({ app, subject }) =>
      subject !== owner
        ? Effect.succeed([])
        : storage(
            Effect.flatMap(get(app), currentLinks).pipe(
              Effect.map((links) => links.filter((link) => link.scope === "user")),
            ),
          ),
    appLinks: ({ app }) =>
      storage(
        Effect.flatMap(get(app), currentLinks).pipe(
          Effect.map((links) => links.filter((link) => link.scope === "app")),
        ),
      ),
    sourceActorLost: (input) =>
      storage(Effect.flatMap(engine, (sdk) => sdk.webhooks.unlink(input))),
    appResolving,
    appsResolving: (owner, apps) =>
      Effect.forEach(apps, (app) =>
        Effect.result(
          appResolving(
            { id: app.id, owner, ...("version" in app ? { version: app.version } : {}) },
            app.accounts,
            app.appUses,
          ),
        ),
      ),
    removalResolving: (_app, accounts, uses) =>
      Effect.succeed(
        new Set(
          [...accounts, ...uses.map((use) => use.account)]
            .filter((account) => account.owner === owner)
            .map((account) => account.id),
        ),
      ),
    accountsResolving: (accounts) =>
      Effect.succeed(
        new Set(accounts.filter((account) => account.owner === owner).map((account) => account.id)),
      ),
    connectionCompleting: () => Effect.void,
    appCreated: (app) => (app.owner === owner ? Effect.void : Effect.fail(new StorageError())),
    appRemoving: () => Effect.void,
    // OAuth completion must commit a reviewed link through this hook in the account adapter.
    appAccountConnected: () => Effect.fail(new StorageError()),
    accountCreated: (account) =>
      account.owner === owner ? Effect.void : Effect.fail(new StorageError()),
    accountRemoving: () => Effect.void,
  };
  return {
    hooks,
    accounts,
    resolved,
    review,
    link,
    unlink,
    links: (app: AppId) => Effect.flatMap(engine, (sdk) => read(sdk, app)),
  };
}
