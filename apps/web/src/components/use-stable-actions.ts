import { useMemo, useRef } from "react";

type Handler = (...args: never[]) => unknown;

/**
 * Row handlers that keep their identity while the same ones are offered, so
 * memoised rows never redraw because their parent did; each calls the newest.
 */
export function useStableActions<T extends { readonly [K in keyof T]?: Handler | undefined }>(
  actions: T,
): T {
  const latest = useRef<Partial<Record<string, Handler>>>(actions);
  latest.current = actions;
  const offered = Object.entries(actions)
    .flatMap(([key, value]) => (value === undefined ? [] : [key]))
    .sort()
    .join(",");
  return useMemo(() => {
    const stable: Record<string, Handler> = {};
    for (const key of offered ? offered.split(",") : [])
      stable[key] = (...args: never[]) => latest.current[key]?.(...args);
    return stable as T;
  }, [offered]);
}
