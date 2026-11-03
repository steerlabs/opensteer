import { canRespondToRequests, type HostClient } from "@opensteer/client/host";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMobileClient } from "../ui/mobile-client-context.js";
import type { PluginRow } from "@opensteer/protocol";

// Temporary mobile projection until workstream B's shared settings models land.
export type SettingsRpcData<K extends keyof HostClient["rpc"]> = Extract<
  Awaited<ReturnType<HostClient["rpc"][K]>>,
  { ok: true }
>["data"];
export function pluginKey(row: Pick<PluginRow, "target">): string {
  const target = row.target;
  switch (target.kind) {
    case "service":
    case "device-app":
      return JSON.stringify([target.kind, target.definitionId]);
    case "plugin":
      return JSON.stringify([target.kind, target.pluginId]);
    case "skill":
      return JSON.stringify([target.kind, target.workspaceId, target.fullName]);
    case "specialist":
      return JSON.stringify([target.kind, target.pluginId, target.ownerUserId]);
  }
}
export function pluginGroup(row: PluginRow): "Needs you" | "On" | "Turned off" {
  if (!row.placement.enabled) return "Turned off";
  return row.issues.some(
    (issue) => !["waiting-device", "waiting-setup", "unknown-source-folder"].includes(issue),
  )
    ? "Needs you"
    : "On";
}
export function filterPlugins(rows: readonly PluginRow[], query: string, tag: string | null) {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (!tag || row.tags.some((value) => value === tag)) &&
      `${row.title} ${row.description ?? ""}`.toLocaleLowerCase().includes(search),
  );
}
export function useSettingsLease(host: HostClient) {
  const mobile = useMobileClient();
  const active = useRef(true);
  const userId = useRef(host.getSnapshot().user?.id ?? null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [host]);
  return useCallback(() => {
    const snapshot = host.getSnapshot();
    if (
      !active.current ||
      mobile.getSnapshot().selection.hostClient !== host ||
      !canRespondToRequests(snapshot)
    )
      return false;
    // A page may mount before bootstrap; bind its first authenticated viewer once.
    if (userId.current === null) userId.current = snapshot.user?.id ?? null;
    return userId.current !== null && snapshot.user?.id === userId.current;
  }, [host, mobile]);
}
export function useSettingsRead<T>(host: HostClient, read: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isCurrent = useSettingsLease(host);
  const reading = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const readRef = useRef(read);
  readRef.current = read;
  const reload = useCallback((): Promise<void> => {
    if (!isCurrent()) return Promise.resolve();
    if (reading.current) {
      dirty.current = true;
      return reading.current;
    }
    const operation = (async () => {
      do {
        dirty.current = false;
        try {
          const value = await readRef.current();
          if (isCurrent()) {
            setData(value);
            setError(null);
          }
        } catch {
          if (isCurrent()) setError("Couldn’t refresh settings. Try again.");
        }
      } while (dirty.current && isCurrent());
    })().finally(() => {
      reading.current = null;
    });
    reading.current = operation;
    return operation;
  }, [isCurrent]);
  useEffect(() => {
    void reload();
    let connected = canRespondToRequests(host.getSnapshot());
    const unsubscribe = host.subscribe(() => {
      const next = canRespondToRequests(host.getSnapshot());
      if (next && !connected) void reload();
      connected = next;
    });
    const unsubscribePlugins = host.subscribePluginsChanged(() => {
      void reload();
    });
    return () => {
      unsubscribe();
      unsubscribePlugins();
    };
  }, [host, reload]);
  return { data, error, reload };
}
