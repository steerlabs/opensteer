const workHomes = new WeakSet<object>();

export function isWorkHomeDatabase(database: object): boolean {
  return workHomes.has(database);
}

export function markWorkHomeDatabase(database: object): void {
  workHomes.add(database);
}

export function inheritWorkHomeDatabase(database: object, transaction: object): void {
  if (workHomes.has(database)) workHomes.add(transaction);
}
