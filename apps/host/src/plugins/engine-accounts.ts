import type { ResolvedAccounts } from "apps/contracts";
import { migrateEngineProduct, lockEngineApp, readEngineLinks } from "./engine-storage.js";
export { migrateEngineProduct };
import { createHash } from "node:crypto";
import { Context, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import {
  AccountId,
  AccountConnectionTargetChanged,
  OAuthBrokerFailed,
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
import {
  ConsentSchema,
  PluginServiceError,
  operations,
  type PluginConsent,
  type EngineAccountMetadata,
} from "./engine-protocol.js";

const table = ["opensteer_account_links"];
type CreationKind =
  "plugin" | "account" | "connection" | "oauth-client" | "schedule-run" | "schedule-configuration";
const Creation = Context.Reference<
  { key: string; kind: CreationKind; origin?: string | undefined } | undefined
>("opensteer/PluginCreation", { defaultValue: () => undefined });
const RemovingAccount = Context.Reference<string[] | undefined>("opensteer/RemovingAccount", {
  defaultValue: () => undefined,
});
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

export function engineAccounts(options: {
  sql: SqlClient.SqlClient;
  engine: Effect.Effect<PluginEngine>;
  owner: OwnerId;
  blobs: BlobStorage;
  authorizeBackground(plugin: string): Effect.Effect<void, Error>;
}) {
  const { sql, engine, owner, blobs } = options;
  const creationReceipt = (key: string, kind: CreationKind) =>
    storage(
      sql<{
        result: unknown;
      }>`select result from opensteer_resource_creations where owner = ${owner} and key = ${key} and kind = ${kind}`,
    ).pipe(Effect.map((rows) => rows[0]));
  const rememberCreation = (kind: CreationKind, result: unknown) =>
    Effect.gen(function* () {
      const creation = yield* Creation;
      if (creation?.kind === kind)
        yield* storage(
          sql`insert into opensteer_resource_creations (owner, key, kind, result) values (${owner}, ${creation.key}, ${kind}, ${JSON.stringify(result)}::jsonb)`,
        );
    });
  const once = <A, B, E extends Error, R>(
    key: string | undefined,
    kind: CreationKind,
    work: Effect.Effect<A, E, R>,
    recover: (receipt: { result: unknown }) => Effect.Effect<B, Error>,
    origin?: string,
  ) => {
    if (!key) return work;
    return Effect.gen(function* () {
      const receipt = yield* creationReceipt(key, kind);
      return receipt
        ? yield* recover(receipt)
        : yield* work.pipe(Effect.provideService(Creation, { key, kind, origin }));
    }).pipe(
      Effect.catch((error) =>
        Effect.flatMap(creationReceipt(key, kind), (receipt) =>
          receipt ? recover(receipt) : Effect.fail(error),
        ),
      ),
    );
  };
  const read = (sdk: PluginEngine, app: AppId) =>
    sdk[StorageHost].read(table, readEngineLinks(sql, app)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(rows)),
      storage,
    );
  const lock = (app: AppId) => storage(lockEngineApp(sql, app));
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
  const consentFor = (required: AccountRequirement, sealed: boolean) => {
    const sites = [...(required.definition.hosts ?? [])].sort();
    // Review precedes account/method selection: disclose the widest runtime exposure.
    const exposed = Object.values(required.definition.auth).some((method) => {
      if ((method.raw?.length ?? 0) > 0 || (method.plain?.length ?? 0) > 0) return true;
      if (method.type !== "secrets") return false;
      const fields = method.fields.properties;
      // The runtime replaces strings only; other credential values remain readable.
      return (
        !fields ||
        typeof fields !== "object" ||
        Array.isArray(fields) ||
        Object.values(fields).some(
          (field) =>
            !field ||
            typeof field !== "object" ||
            Array.isArray(field) ||
            !("type" in field) ||
            field.type !== "string",
        )
      );
    });
    const credential =
      sealed && required.definition.hosts !== undefined && !exposed
        ? ("sealed" as const)
        : ("value" as const);
    return {
      sites,
      credential,
      digest: createHash("sha256").update(canonical({ required, credential })).digest("hex"),
    } satisfies PluginConsent;
  };
  const snapshot = (app: App, required: AccountRequirement) =>
    disclosure(app).pipe(Effect.map((sealed) => consentFor(required, sealed)));
  const metadata = (app: App) =>
    Effect.gen(function* () {
      const required = Object.entries(app.requirements.accounts);
      const links = yield* read(yield* engine, app.id);
      const sealed = required.length
        ? yield* disclosure(app).pipe(Effect.option)
        : Option.none<boolean>();
      const readiness: EngineAccountMetadata["readiness"] = Object.fromEntries(
        required.map(([name, declaration]) => {
          const consent = Option.isSome(sealed) ? consentFor(declaration, sealed.value) : null;
          const slot = links.filter(
            (link) => link.requirement === name && link.scope === declaration.scope,
          );
          const state = slot.some((link) => consent === null || canonical(consent) !== link.consent)
            ? "consent-needs-review"
            : declaration.cardinality === "one" && slot.length === 0
              ? "required-but-missing"
              : "usable";
          return [name, { state, consent }];
        }),
      );
      return {
        readiness,
        links: links.map(({ requirement, scope, account, consent }) => {
          const expected = readiness[requirement]?.consent;
          return {
            requirement,
            scope,
            account,
            current:
              expected != null &&
              app.requirements.accounts[requirement]?.scope === scope &&
              canonical(expected) === consent,
          };
        }),
      };
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
  const recheckLinks = (plugin: string, accounts: ResolvedAccounts) =>
    Effect.gen(function* () {
      const selected = (["app", "user"] as const).flatMap((scope) =>
        Object.entries(accounts[scope] ?? {}).flatMap(([requirement, slot]) =>
          (Array.isArray(slot) ? slot : [slot]).map(({ id }) => ({ scope, requirement, id })),
        ),
      );
      if (!selected.length) return;
      const links = yield* read(yield* engine, AppId.make(plugin));
      if (
        selected.some(
          ({ scope, requirement, id }) =>
            !links.some(
              (link) =>
                link.scope === scope && link.requirement === requirement && link.account === id,
            ),
        )
      )
        return yield* Effect.fail(
          new PluginServiceError("forbidden", "A plugin account link changed before dispatch"),
        );
    });
  const validateBinding = (generation: string) =>
    sql`
    select link.subject from public.personal_remote_account_link link
    join public.personal_settings settings on settings.singleton_key = 'personal'
    join public.users owner on owner.id = settings.owner_id and owner.disabled_at is null
    where link.singleton_key = 'opensteer-account' and link.state = 'active'
      and link.link_generation = ${generation}
      and exists (select 1 from opensteer_oauth_connections pin where pin.owner_user_id = owner.id
        and pin.account_binding->>'linkGeneration' = link.link_generation
        and pin.account_binding->>'issuer' = link.issuer and pin.account_binding->>'subject' = link.subject)
    for share of link, settings, owner
  `.pipe(
      Effect.flatMap((rows) =>
        rows.length === 1
          ? Effect.void
          : Effect.fail(new OAuthBrokerFailed({ reason: "binding_changed" })),
      ),
      Effect.mapError(() => new OAuthBrokerFailed({ reason: "binding_changed" })),
    );
  const validateConnectionBinding = (connection: string) =>
    Effect.gen(function* () {
      const pins = yield* sql<{
        owner: string;
        binding: { issuer: string; subject: string; linkGeneration: string } | null;
      }>`select owner_user_id as owner, account_binding as binding from opensteer_oauth_connections where connection = ${connection}`;
      const pin = pins[0];
      if (!pin?.owner) return yield* Effect.fail(new StorageError());
      yield* sql.unsafe("LOCK TABLE public.personal_remote_account_link IN SHARE MODE");
      const owners =
        yield* sql`select owner.id from public.personal_settings settings join public.users owner on owner.id = settings.owner_id and owner.disabled_at is null where settings.singleton_key = 'personal' and owner.id = ${pin.owner} for share of settings, owner`;
      const links = yield* sql<{
        issuer: string;
        subject: string;
        generation: string;
      }>`select issuer, subject, link_generation as generation from public.personal_remote_account_link where singleton_key = 'opensteer-account' and state = 'active' for share`;
      const current = links[0];
      if (
        owners.length !== 1 ||
        (pin.binding
          ? !current ||
            current.issuer !== pin.binding.issuer ||
            current.subject !== pin.binding.subject ||
            current.generation !== pin.binding.linkGeneration
          : current !== undefined)
      )
        return yield* Effect.fail(new StorageError());
    });
  const pinConnection = (input: {
    connection: string;
    ownerUserId: string;
    localId: string;
    account: { issuer: string; subject: string; linkGeneration: string } | null;
  }) =>
    sql`update opensteer_oauth_connections set local_attempt = ${input.localId}, owner_user_id = ${input.ownerUserId}, account_binding = ${input.account === null ? null : JSON.stringify(input.account)}::jsonb where connection = ${input.connection}`.pipe(
      Effect.as(null),
    );
  const connectionReview = (connection: string) =>
    sql<{ app: string; requirement: string; scope: "app" | "user"; consent: string }>`
    select app, requirement, scope, consent from opensteer_oauth_connections where connection = ${connection}
  `.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new StorageError()),
      ),
    );
  const prepare = (input: {
    plugin: string;
    requirement: string;
    scope: "app" | "user";
    key?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const sdk = yield* engine;
      return yield* once(
        input.key,
        "connection",
        sdk[StorageHost].transaction(
          Effect.gen(function* () {
            yield* lock(AppId.make(input.plugin));
            const consent = yield* review(input);
            const connection = yield* sdk.accountConnections.create({
              owner,
              target: {
                app: AppId.make(input.plugin),
                requirement: input.requirement,
                scope: input.scope,
              },
            });
            yield* sql`insert into opensteer_oauth_connections (connection, app, requirement, scope, consent)
        values (${connection.id}, ${input.plugin}, ${input.requirement}, ${input.scope}, ${canonical(consent)})`;
            const prepared = {
              connection: connection.id,
              consent,
              callbackProvider: Object.values(connection.provider.definition.auth).some(
                (method) => method.type === "oauth2" && "discover" in method,
              )
                ? ("mcp" as const)
                : ("plugin" as const),
            };
            yield* rememberCreation("connection", prepared);
            return prepared;
          }),
        ),
        (receipt) => Effect.try(() => operations.prepareOAuth.output.parse(receipt.result)),
      );
    });
  const reviewedConnection = (connection: string, consent?: PluginConsent) =>
    Effect.gen(function* () {
      const pinned = yield* connectionReview(connection);
      const current = yield* review({
        plugin: pinned.app,
        requirement: pinned.requirement,
        scope: pinned.scope,
      });
      if (
        canonical(current) !== pinned.consent ||
        (consent && canonical(consent) !== pinned.consent)
      )
        return yield* Effect.fail(
          new PluginServiceError("consent-changed", "Plugin declaration changed since review"),
        );
      return pinned;
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
    // The saved origin, not a later request's input, labels a recovered install.
    appDeployed: (app, version) =>
      Effect.flatMap(Creation, (creation) =>
        rememberCreation("plugin", {
          status: "installed",
          plugin: app,
          version,
          origin: creation?.origin,
        }),
      ),
    appRemoving: () => Effect.void,
    appAccountConnected: (input) =>
      Effect.gen(function* () {
        const claim =
          yield* sql`select attempt.id from public.integration_auth_attempts attempt join opensteer_oauth_connections pin on pin.local_attempt = attempt.id where pin.connection = ${input.connection} and attempt.status = 'claimed' and attempt.expires_at > clock_timestamp() for no key update of attempt`.pipe(
            storage,
          );
        if (claim.length !== 1) return yield* Effect.fail(new StorageError());
        yield* validateConnectionBinding(input.connection).pipe(storage);
        const pinned = yield* connectionReview(input.connection).pipe(storage);
        if (
          pinned.app !== input.app ||
          pinned.requirement !== input.requirement ||
          pinned.scope !== input.scope
        )
          return yield* Effect.fail(
            new AccountConnectionTargetChanged({ app: input.app, requirement: input.requirement }),
          );
        yield* link({
          plugin: input.app,
          requirement: input.requirement,
          scope: input.scope,
          account: input.account.id,
          consent: ConsentSchema.parse(JSON.parse(pinned.consent)),
        }).pipe(
          Effect.mapError(
            () =>
              new AccountConnectionTargetChanged({
                app: input.app,
                requirement: input.requirement,
              }),
          ),
        );
        yield* sql`update public.integration_auth_attempts set status = 'completed', completed_at = clock_timestamp(), encrypted_payload = ${Buffer.from("erased")} where id = (select local_attempt from opensteer_oauth_connections where connection = ${input.connection}) and status = 'claimed'`.pipe(
          storage,
        );
      }),
    accountCreated: (account) =>
      account.owner === owner
        ? rememberCreation("account", account)
        : Effect.fail(new StorageError()),
    accountRemoving: ({ id }) =>
      Effect.gen(function* () {
        const plugins = yield* RemovingAccount;
        if (!plugins) return;
        // FOR UPDATE: this account row is deleted next; take it before reading the links that cascade.
        yield* storage(sql`select id from plugin_engine_accounts where id = ${id} for update`);
        const links = yield* storage(sql<{ app: string }>`
          select distinct app from opensteer_account_links where account = ${id} order by app
        `);
        plugins.push(...links.map(({ app }) => app));
      }),
    oauthClientCreated: (client) => rememberCreation("oauth-client", client),
  };
  return {
    hooks,
    removeAccount: (account: AccountId) =>
      Effect.gen(function* () {
        const affectedPlugins: string[] = [];
        const sdk = yield* engine;
        yield* sdk.accounts
          .remove({ owner, account })
          .pipe(Effect.provideService(RemovingAccount, affectedPlugins));
        return { account, affectedPlugins };
      }),
    once,
    committed: <A, E extends Error, R>(
      key: string | undefined,
      kind: CreationKind,
      work: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const sdk = yield* engine;
        return yield* sdk[StorageHost].transaction(
          Effect.gen(function* () {
            if (key)
              yield* storage(
                sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([owner, kind, key])}, 0))`,
              );
            return yield* once(
              key,
              kind,
              work.pipe(Effect.tap((result) => rememberCreation(kind, result))),
              (receipt) => Effect.succeed(receipt.result),
            );
          }),
        );
      }),
    standing: (app: AppId) =>
      options.authorizeBackground(app).pipe(Effect.andThen(accounts(app)), Effect.asVoid),
    recheckLinks,
    validateBinding,
    prepare,
    pinConnection,
    reviewedConnection,
    accounts,
    resolved,
    review,
    link,
    unlink,
    metadata,
  };
}
