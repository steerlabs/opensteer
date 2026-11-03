import { useCallback, useEffect, useRef, useState } from "react";

export interface HostRead<T> {
  /** The last answer for this `key`; null until one arrives. */
  readonly data: T | null;
  readonly error: unknown;
  readonly loading: boolean;
  /** Reads again, keeping what is shown until the new answer lands. */
  readonly reload: () => void;
}

/**
 * One read from the Host for a page section, with its loading and failure
 * states kept apart. An answer read for another `key` is never shown as this
 * one's, even for a moment: until a read for it answers, it is unknown, not
 * empty. A null `read` reads nothing.
 */
export function useHostRead<T>(read: (() => Promise<T>) | null, key: string): HostRead<T> {
  const [state, setState] = useState<{
    readonly key: string;
    readonly data: T | null;
    readonly error: unknown;
    readonly loading: boolean;
  }>({ key, data: null, error: null, loading: read !== null });
  const [generation, setGeneration] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const enabled = read !== null;
  useEffect(() => {
    const current = readRef.current;
    if (!current) return;
    let alive = true;
    setState((previous) =>
      previous.key === key
        ? { ...previous, loading: true }
        : { key, data: null, error: null, loading: true },
    );
    current().then(
      (data) => {
        if (alive) setState({ key, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (alive) setState((previous) => ({ ...previous, key, error, loading: false }));
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled, generation, key]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const own = state.key === key;
  return {
    data: own ? state.data : null,
    error: own ? state.error : null,
    loading: enabled && (!own || state.loading),
    reload,
  };
}
