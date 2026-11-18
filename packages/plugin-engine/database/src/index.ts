/** Effect-native schema, query, and migration services. */
export { pluginDatabase } from "./implementation/database.ts";
export type { PluginDatabase, PluginDatabaseFactory, InferPluginDatabase, InferOrm } from "./contracts/database.ts";
export type { Adapter, AdapterContext, LibraryConfig } from "./contracts/adapter.ts";
export {
  MigrationError,
  NotInitialized,
  QueryError,
  SchemaDefinitionError,
} from "./contracts/errors.ts";
export {
  defaultRelationMode,
  dialectOf,
  isProvider,
  providers,
  type Provider,
  type RelationMode,
} from "./contracts/provider.ts";
export type { NameVariantsBuilder } from "./contracts/names.ts";
export type { Orm, OrmError } from "./contracts/query.ts";
export type { Migrator, MigrationResult, MigrateOptions } from "./contracts/migration.ts";
