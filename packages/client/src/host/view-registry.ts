/**
 * What each Thread's views register, oldest first. The newest is the one the client asks; each
 * registration's release removes only itself, so a view closing over another hands the Thread back
 * to it, whatever order they close in.
 */
export class ViewRegistry<Value> {
  readonly #views = new Map<string, Value[]>();

  current(threadId: string): Value | undefined {
    return this.#views.get(threadId)?.at(-1);
  }

  /** Registers `value` as the newest for `threadId`; `apply` hears the current one on each change. */
  register(threadId: string, value: Value, apply: (current: Value | undefined) => void) {
    const views = this.#views.get(threadId) ?? [];
    views.push(value);
    this.#views.set(threadId, views);
    apply(this.current(threadId));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const held = this.#views.get(threadId) ?? [];
      const at = held.lastIndexOf(value);
      if (at >= 0) held.splice(at, 1);
      if (!held.length) this.#views.delete(threadId);
      apply(this.current(threadId));
    };
  }
}
