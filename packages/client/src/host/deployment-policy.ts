import type { HostSnapshot } from "./client.js";
export function hostCapabilities(snapshot: Pick<HostSnapshot, "can">) {
  return snapshot.can;
}
