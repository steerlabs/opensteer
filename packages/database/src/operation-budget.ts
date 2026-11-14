import { AsyncLocalStorage } from "node:async_hooks";
import type { AbortableQueryOptions } from "kysely";
interface Operation {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly transaction: boolean;
}
const operation = new AsyncLocalStorage<Operation>();
export function withDatabaseOperationSignal<T>(
  signal: AbortSignal,
  expiresAt: number,
  action: () => T,
): T {
  signal.throwIfAborted();
  const remaining = Math.ceil(expiresAt - Date.now());
  const deadline =
    remaining > 0
      ? AbortSignal.timeout(remaining)
      : AbortSignal.abort(new DOMException("Database operation deadline expired", "TimeoutError"));
  return operation.run(
    {
      signal: AbortSignal.any([signal, deadline]),
      expiresAt,
      transaction: false,
    },
    action,
  );
}
export function withoutDatabaseOperationSignal<T>(action: () => T): T {
  return operation.exit(action);
}
export function databaseOperation() {
  return operation.getStore();
}
export function inDatabaseOperationTransaction<T>(action: () => T): T {
  const current = operation.getStore();
  return current ? operation.run({ ...current, transaction: true }, action) : action();
}
export function databaseOperationOptions(): AbortableQueryOptions {
  const current = operation.getStore();
  current?.signal.throwIfAborted();
  // A transaction's server-side deadline must cancel its lock wait before rollback starts.
  return current && !current.transaction
    ? { signal: current.signal, inflightQueryAbortStrategy: "cancel query" }
    : {};
}
