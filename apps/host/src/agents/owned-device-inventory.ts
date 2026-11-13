import type { UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";

export async function ownedDeviceInventory(options: {
  readonly store: Pick<OpensteerStore, "listOwnedDevices">;
  readonly runners: Pick<RunnerRegistry, "isRunnerConnected">;
  readonly requestedBy: UserId;
}): Promise<string> {
  const devices = await options.store.listOwnedDevices(options.requestedBy);
  if (!devices.length) return "";
  const lines = [
    "Owned devices (discovery only; this does not grant shell routes). Access is enabled, disabled or unsupported. For an online disabled capability, device_access_request asks in Needs you. Never ask for an offline device or re-ask after Not now in this task. Fulfillment resumes in a new Run with rebuilt routes.",
  ];
  let kept = 0;
  for (const device of devices) {
    const line = JSON.stringify({
      ...device,
      status: options.runners.isRunnerConnected(device.machineId) ? "online" : "offline",
    });
    if (Buffer.byteLength(lines.join("\n")) + Buffer.byteLength(line) > 16 * 1024 || kept >= 32)
      break;
    lines.push(line);
    kept++;
  }
  if (kept < devices.length) lines.push(`${devices.length - kept} more owned devices omitted.`);
  return lines.join("\n");
}
