/** Database factory, client, and schema inference contracts. */
import type { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import type { SqlClient } from "effect/sql/SqlClient";
import type { Adapter } from "./adapter.ts";
import type { MigrationError, NotInitialized } from "./errors.ts";
import type { Migrator } from "./migration.ts";
import type { Orm } from "./query.ts";
import type { NameVariantsBuilder } from "./names.ts";
import type { AnySchema } from "./schema/schema.ts";

type Last<T extends ReadonlyArray<unknown>> = T extends readonly [...infer _, infer L]
  ? L
  : T[number];

/** A configured client: the factory bound to an adapter. */
export interface PluginDatabase<
  Schemas extends ReadonlyArray<AnySchema> = ReadonlyArray<AnySchema>,
  R = never,
> {
  readonly schemas: Schemas;
  readonly adapter: Adapter<R>;
  /**
   * The schema version applied to the database. Queries the settings table
   * every time; use {@link PluginDatabase.cachedVersion} inside a long-lived program.
   */
  readonly version: Effect.Effect<Schemas[number]["version"], NotInitialized | SqlError, R>;
  /**
   * A memoised {@link PluginDatabase.version}: the returned effect reads the database
   * once and replays the result. Build it once per program (for example in a
   * layer) and reuse it; build a fresh one after running a migration.
   */
  readonly cachedVersion: Effect.Effect<
    Effect.Effect<Schemas[number]["version"], NotInitialized | SqlError, R>
  >;
  /** The query interface for a schema version. */
  readonly orm: <V extends Schemas[number]["version"]>(
    version: V,
  ) => Orm<Extract<Schemas[number], { version: V }>, R>;
  /** Shorthand for `orm(<latest version>)`. */
  readonly latest: Orm<Last<Schemas>, R>;
  /** The migrator. Fails when the adapter does not support migrations. */
  readonly createMigrator: Effect.Effect<Migrator<R>, MigrationError>;
}

/** What `pluginDatabase()` returns: a library's database, before an adapter is bound. */
export interface PluginDatabaseFactory<Schemas extends ReadonlyArray<AnySchema>> {
  /** A static type check for a version literal. */
  readonly version: <T extends Schemas[number]["version"]>(target: T) => T;
  /** Bind an adapter (consumer side). */
  readonly client: <R>(adapter: Adapter<R>) => PluginDatabase<Schemas, R>;
  /** Override table and column names (consumer side). */
  readonly names: NameVariantsBuilder<Schemas, PluginDatabaseFactory<Schemas>>;
}

/**
 * The client type a library receives, from the type of its factory.
 *
 * `R` is the environment the consumer's adapter needs; it defaults to the SQL
 * adapter's `SqlClient`. `Factory` is deliberately unconstrained: `Orm` is
 * invariant in its schema, so a factory over concrete schema types is not
 * assignable to one over `AnySchema`.
 */
export type InferPluginDatabase<Factory, R = SqlClient> =
  Factory extends PluginDatabaseFactory<infer Schemas>
    ? PluginDatabase<Schemas, R>
    : { readonly "InferPluginDatabase expects the result of pluginDatabase(...)": Factory };

/** The ORM type of one schema version of a client, tagged with that version. */
export type InferOrm<Client, Version extends string> =
  Client extends PluginDatabase<infer Schemas, infer R>
    ? Orm<Extract<Schemas[number], { version: Version }>, R> & { readonly version: Version }
    : never;
