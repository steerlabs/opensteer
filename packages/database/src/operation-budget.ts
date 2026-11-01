import { AsyncLocalStorage } from "node:async_hooks";
import type { AbortableQueryOptions } from "kysely";
interface Operation {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly transaction: boolean;
}
const operation = new AsyncLocalStorage<Operation>();
/** A transaction has a server-side deadline; cancelling its waiter can race rollback with pg_cancel_backend. */
export function withDatabaseOperationSignal<T>(
  signal: AbortSignal,
  expiresAt: number,
  action: () => T,
): T {
  signal.throwIfAborted();
  return operation.run({ signal, expiresAt, transaction: false }, action);
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
  return current && !current.transaction
    ? { signal: current.signal, inflightQueryAbortStrategy: "cancel query" }
    : {};
}
