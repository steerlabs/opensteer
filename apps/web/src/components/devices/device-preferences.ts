/**
 * What this window keeps about this device per Opensteer: whether it shows
 * notifications and where an unfinished setup stands. The Host and desktop main
 * own the device itself.
 */
export type DeviceSetupStep = "choose" | "macos" | "ready";
export type DeferredSetup = "use-from-anywhere" | "bind" | "failed";

const notificationsKey = (deploymentId: string) =>
  `opensteer.device-notifications.v1:${deploymentId}`;
const setupKey = (deploymentId: string) => `opensteer.device-setup.v1:${deploymentId}`;
const deferredKey = (deploymentId: string) => `opensteer.device-setup-deferred.v1:${deploymentId}`;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Without storage this window simply doesn't remember it.
  }
}

export function deviceNotificationsOn(deploymentId: string): boolean {
  return read(notificationsKey(deploymentId)) !== "off";
}

export function setDeviceNotifications(deploymentId: string, on: boolean): void {
  write(notificationsKey(deploymentId), on ? null : "off");
}

export function rememberedSetupStep(deploymentId: string): DeviceSetupStep | null {
  const value = read(setupKey(deploymentId));
  return value === "choose" || value === "macos" || value === "ready" ? value : null;
}

export function rememberSetupStep(deploymentId: string, step: DeviceSetupStep | null): void {
  write(setupKey(deploymentId), step);
}

export function deferredSetup(deploymentId: string): DeferredSetup | null {
  const value = read(deferredKey(deploymentId));
  return value === "use-from-anywhere" || value === "bind" || value === "failed" ? value : null;
}

export function rememberDeferredSetup(deploymentId: string, cause: DeferredSetup | null): void {
  write(deferredKey(deploymentId), cause);
}
