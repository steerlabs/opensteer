/** Serialized async mutations. */

/**
 * One promise chain, one mutation at a time. This replaces the eight private
 * `#mutationTail` copies in apps/desktop — protected-auth-store,
 * personal-deployment-store, deployment-catalog, native-oauth,
 * cloudflared-connector-supervisor, personal-deployment-supervisor and the two
 * coordinators in personal-host-connect-orchestrator — which were byte-identical
 * apart from their method names.
 */
export class MutationQueue {
  #tail: Promise<void> = Promise.resolve();

  /**
   * Runs `operation` once every previously queued one has settled. The caller
   * gets the operation's own promise, so its rejection is theirs to handle,
   * while the chain swallows that rejection: a failed mutation must not stop
   * the next one from running.
   */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Independent keys serialize only their own operations, and leave no idle entries. */
export class KeyedMutationQueue {
  readonly #entries = new Map<string, { queue: MutationQueue; users: number }>();
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const entry = this.#entries.get(key) ?? { queue: new MutationQueue(), users: 0 };
    this.#entries.set(key, entry);
    entry.users++;
    return entry.queue.run(operation).finally(() => {
      if (--entry.users === 0) this.#entries.delete(key);
    });
  }
  keys(): readonly string[] {
    return [...this.#entries.keys()];
  }
}
