import { deviceSwitchOn, withDeviceSwitch } from "@opensteer/client/computers";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import { setPhoneUseAccess } from "@opensteer/client/integrations";
import type { IntegrationAccess } from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";

export type IphoneAgentAccess = IntegrationAccess | "none";

/**
 * Sets what the agent may do with an iPhone's screen in one choice: allowing it
 * also turns the iPhone's Apps switch on, and "none" withdraws the screen
 * approval. Both go through the Host's own access commands, which decide.
 */
export async function setIphoneAgentAccess(
  client: Pick<HostClient, "dispatch" | "refresh" | "getSnapshot" | "updateMachineAccess">,
  machine: MachineSummary,
  connectionId: string | null,
  choice: IphoneAgentAccess,
): Promise<void> {
  if (choice === "none") {
    if (connectionId === null) return;
    const result = await client.dispatch({
      connectionId,
      idempotencyKey: mutationIdempotencyKey(`phone-access:${machine.id}`),
      type: "integration.disconnect",
    });
    if (result.type !== "integration.disconnect") throw new Error("Access didn’t change.");
    await client.refresh();
    return;
  }
  if (deviceSwitchOn(machine, "apps") === false && machine.access) {
    const result = await client.updateMachineAccess({
      deviceId: machine.id,
      expectedRevision: machine.access.revision,
      policy: withDeviceSwitch(machine.access.policy, "apps", true),
    });
    if (result.outcome === "conflict") {
      await client.refresh();
      throw new Error("This changed on another device. Choose again.");
    }
  }
  await setPhoneUseAccess(client, machine, choice);
}
