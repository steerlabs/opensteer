export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export async function settleCleanup(operations: Array<() => Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Browser cleanup did not complete cleanly.");
  }
}

/** Independent lifecycle lanes; no lane owns capacity or another lane's I/O. */
export class LifecycleLanes<Key> {
  private readonly lanes = new Map<Key, { mutex: AsyncMutex; users: number }>();
  private readonly pending = new Set<Promise<unknown>>();
  busy(key: Key): boolean {
    return this.lanes.has(key);
  }
  run<T>(key: Key, operation: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { mutex: new AsyncMutex(), users: 0 };
      this.lanes.set(key, lane);
    }
    lane.users++;
    const current = lane;
    const result = current.mutex.run(operation);
    this.pending.add(result);
    const finished = () => {
      this.pending.delete(result);
      if (--current.users === 0) this.lanes.delete(key);
    };
    void result.then(finished, finished);
    return result;
  }
  async drain(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}
