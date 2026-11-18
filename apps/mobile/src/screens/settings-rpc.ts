import type { HostClient } from "@opensteer/client/host";

/** What a Host read answers when it succeeds. */
export type SettingsRpcData<K extends keyof HostClient["rpc"]> = Extract<
  Awaited<ReturnType<HostClient["rpc"][K]>>,
  { ok: true }
>["data"];
