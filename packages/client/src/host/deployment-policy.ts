import type { LegacyHostSnapshot as HostSnapshot } from "./client.js";
export function hostCapabilities(snapshot: Pick<HostSnapshot, "can">) {
  return snapshot.can;
}
