import type { AbortableQueryOptions, QueryExecutor } from "kysely";
import { databaseOperationOptions } from "./operation-budget.js";

function operationOptions(options?: AbortableQueryOptions): AbortableQueryOptions | undefined {
  const budget = databaseOperationOptions();
  if (!budget.signal) return options;
  return {
    ...options,
    ...budget,
    signal:
      options?.signal && options.signal !== budget.signal
        ? AbortSignal.any([options.signal, budget.signal])
        : budget.signal,
  };
}

/** Keep the budget above Kysely's acquisition and in-flight cancellation machinery. */
export function applyDatabaseOperationBudget(executor: QueryExecutor): QueryExecutor {
  const execute = executor.executeQuery.bind(executor);
  executor.executeQuery = async (query, options) => execute(query, operationOptions(options));
  const provide = executor.provideConnection.bind(executor);
  executor.provideConnection = async (consumer, options) =>
    provide(consumer, operationOptions(options));
  const stream = executor.stream.bind(executor);
  executor.stream = (query, chunkSize, options) =>
    stream(query, chunkSize, operationOptions(options));

  // Kysely derives executors for reserved connections, transactions, schemas and plugins.
  const withConnectionProvider = executor.withConnectionProvider.bind(executor);
  executor.withConnectionProvider = (provider) =>
    applyDatabaseOperationBudget(withConnectionProvider(provider));
  const withPlugin = executor.withPlugin.bind(executor);
  executor.withPlugin = (plugin) => applyDatabaseOperationBudget(withPlugin(plugin));
  const withPlugins = executor.withPlugins.bind(executor);
  executor.withPlugins = (plugins) => applyDatabaseOperationBudget(withPlugins(plugins));
  const withPluginAtFront = executor.withPluginAtFront.bind(executor);
  executor.withPluginAtFront = (plugin) => applyDatabaseOperationBudget(withPluginAtFront(plugin));
  const withoutPlugins = executor.withoutPlugins.bind(executor);
  executor.withoutPlugins = () => applyDatabaseOperationBudget(withoutPlugins());
  return executor;
}
