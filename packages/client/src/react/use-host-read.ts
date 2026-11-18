import { useMemo, useRef } from "react";
import type { ClientSession } from "../connections/connection-controller.js";
import { createClientRead } from "../reads/client-read.js";
import { useClientRead } from "./use-client-read.js";

export function useHostRead<T>(
  read: (() => Promise<T>) | null,
  key: string,
  session: ClientSession | null,
) {
  const current = useRef(read);
  current.current = read;
  const enabled = read !== null;
  const resource = useMemo(
    () =>
      session && enabled
        ? createClientRead(session, { key, label: "this", read: () => current.current!() })
        : null,
    [session, key, enabled],
  );
  const state = useClientRead(resource);
  return {
    ...state,
    error: state.issue,
    loading: state.status === "waiting" || state.status === "loading",
    reload: state.refresh,
  };
}
