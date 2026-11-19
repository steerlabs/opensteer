import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * What the reader chose in transcript rows (a step opened, a reply expanded, earlier steps shown),
 * keyed by a stable item id. The transcript owns it, so a row drawn again after scrolling out of
 * a long transcript's window comes back as the reader left it. It ends with the transcript.
 */
export class TranscriptMemory {
  readonly #values = new Map<string, unknown>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #limit: number;

  constructor(limit = 2_000) {
    this.#limit = limit;
  }

  get(key: string): unknown {
    return this.#values.get(key);
  }

  has(key: string): boolean {
    return this.#values.has(key);
  }

  set(key: string, value: unknown) {
    if (this.#values.get(key) === value && this.#values.has(key)) return;
    this.#values.delete(key);
    this.#values.set(key, value);
    if (this.#values.size > this.#limit) {
      const oldest = this.#values.keys().next().value!;
      this.#values.delete(oldest);
      this.#notify(oldest);
    }
    this.#notify(key);
  }

  subscribe(key: string, listener: () => void) {
    const listeners = this.#listeners.get(key) ?? new Set();
    this.#listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  }

  #notify(key: string) {
    for (const listener of this.#listeners.get(key) ?? []) listener();
  }
}

const TranscriptMemoryContext = createContext<TranscriptMemory | null>(null);

export function TranscriptMemoryScope({ children }: { readonly children: ReactNode }) {
  const [memory] = useState(() => new TranscriptMemory());
  return <TranscriptMemoryContext value={memory}>{children}</TranscriptMemoryContext>;
}

/**
 * A row's choice under `key`: the reader's once made, else `initial` as the row was first drawn.
 * Outside a transcript it is the row's own state.
 */
export function useRemembered<T>(key: string, initial: T): [T, (value: T) => void] {
  const memory = useContext(TranscriptMemoryContext);
  // Like `useState`, the default is the one the row was drawn with.
  const [drawnWith] = useState(initial);
  const [own, setOwn] = useState<{ readonly value: T } | null>(null);
  const subscribe = useCallback(
    (listener: () => void) => memory?.subscribe(key, listener) ?? (() => {}),
    [key, memory],
  );
  const read = () => memory?.get(key);
  const stored = useSyncExternalStore(subscribe, read, read);
  const set = useCallback(
    (value: T) => (memory ? memory.set(key, value) : setOwn({ value })),
    [key, memory],
  );
  if (memory) return [memory.has(key) ? (stored as T) : drawnWith, set];
  return [own ? own.value : drawnWith, set];
}
