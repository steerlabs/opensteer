import type { BackgroundModelMode, BackgroundModelRole, ModelSelection } from "@opensteer/core";
import type { HostClient } from "./client.js";
export function getBackgroundModels(client: Pick<HostClient, "rpc">) {
  return client.rpc["backgroundModels.get"]({});
}
export function setBackgroundModelRole(
  client: Pick<HostClient, "rpc">,
  role: BackgroundModelRole,
  mode: BackgroundModelMode,
) {
  return client.rpc["commands.dispatch"]({
    type: "backgroundModels.role.set",
    role,
    mode,
    idempotencyKey: crypto.randomUUID(),
  });
}
export function setBackgroundProviderConsent(
  client: Pick<HostClient, "rpc">,
  providerId: ModelSelection["providerId"],
  acknowledged: boolean,
) {
  return client.rpc["commands.dispatch"]({
    type: "backgroundModels.consent.set",
    providerId,
    acknowledged,
    idempotencyKey: crypto.randomUUID(),
  });
}
