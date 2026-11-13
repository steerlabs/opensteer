import type { ShellConnectError } from "@opensteer/protocol";
export const shellSocketCloseWaitMs = 1_000;

export function shellSentence(message: string, fallback: string): string {
  const trimmed = message.trim();
  if (!trimmed) return `${fallback}.`;
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function shellConnectRefusalMessage(error: ShellConnectError["error"]): string {
  if (
    (error.code !== "device-access-off" && error.code !== "device-offline") ||
    !error.machineId ||
    !error.capability
  )
    return error.message;
  const next =
    error.code === "device-access-off"
      ? "Use device_access_request if needed."
      : "Do not request access while offline.";
  return `${error.code}: machineId=${error.machineId}, capability=${error.capability}. ${error.message} ${next}`;
}
