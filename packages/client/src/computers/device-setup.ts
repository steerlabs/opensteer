import type { HostClient } from "../host/client.js";
import { mutationIdempotencyKey } from "../host/host-session-client.js";

export async function cancelDeviceSetup(
  hostClient: Pick<HostClient, "dispatch" | "refresh">,
  enrollmentId: string,
): Promise<"cancelled" | "joined"> {
  const result = await hostClient.dispatch({
    enrollmentId,
    idempotencyKey: mutationIdempotencyKey(`device-setup-cancel:${enrollmentId}`),
    type: "runner.enrollment.retire",
  });
  if (result.type !== "runner.enrollment.retire") throw new Error("Cancelling didn’t finish.");
  await hostClient.refresh();
  return result.state === "consumed" ? "joined" : "cancelled";
}
