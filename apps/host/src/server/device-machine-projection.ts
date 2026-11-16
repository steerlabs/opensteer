import { androidPhoneDefinitionId, iphoneScreenDefinitionId, type DeviceId } from "@opensteer/core";
import type { DeviceDriverRecord, DeviceInventoryRecord } from "@opensteer/database";
import {
  deviceAccess,
  type MachineSummary,
  type DeviceCapabilities,
  type DeviceCapability,
  type PhoneDisplayView,
  type RunnerModuleName,
} from "@opensteer/protocol";

export interface DeviceMachineLivePort {
  status(deviceId: DeviceId): Pick<MachineSummary, "apps" | "computerUse" | "phoneDisplay"> & {
    readonly connected: boolean;
  };
}

export function deviceCapabilities(
  device: DeviceInventoryRecord,
  self:
    | {
        readonly allowedModules: readonly RunnerModuleName[];
        readonly modules: Partial<Record<RunnerModuleName, unknown>>;
      }
    | undefined,
  connected: boolean,
  phoneDisplay?: PhoneDisplayView | null,
): DeviceCapabilities {
  const screen = !self && device.platform === "ios" && device.kind === "phone";
  const access = deviceAccess(device.accessPolicy);
  const support = {
    browser: !!self?.allowedModules.includes("browser") && !!self.modules.browser,
    apps:
      screen || (!!self?.allowedModules.includes("integrations") && !!self.modules.integrations),
    files:
      device.kind === "home" || (!!self?.allowedModules.includes("shell") && !!self.modules.shell),
  };
  const capability = (name: "browser" | "apps" | "files"): DeviceCapability => {
    const supported = support[name];
    const enabled = supported && (access[name] || (device.kind === "home" && name !== "apps"));
    return {
      supported,
      enabled,
      configurable: supported && !(device.kind === "home" && name !== "apps"),
      state: !supported
        ? "unsupported"
        : !enabled
          ? "disabled"
          : connected
            ? "ready"
            : "unavailable",
      reason: !supported
        ? { kind: "unsupported" }
        : !enabled
          ? { kind: "access-off" }
          : connected
            ? null
            : { kind: "driver-offline" },
    };
  };
  return {
    browser: capability("browser"),
    apps: phoneDisplay
      ? {
          supported: true,
          configurable: true,
          enabled: access.apps,
          ...(access.apps
            ? phoneDisplay.control
            : { state: "disabled" as const, reason: { kind: "access-off" as const } }),
        }
      : capability("apps"),
    files: capability("files"),
  };
}

export function projectDeviceMachines(input: {
  readonly devices: readonly DeviceInventoryRecord[];
  readonly drivers: readonly DeviceDriverRecord[];
  readonly selfMachines: readonly MachineSummary[];
  readonly runnerNames: ReadonlyMap<string, string>;
  readonly runnerConnected: (id: DeviceDriverRecord["runnerId"]) => boolean;
  readonly live?: DeviceMachineLivePort;
}): MachineSummary[] {
  return input.devices
    .filter((device) => !device.removedAt)
    .map((device) => {
      const bindings = input.drivers.filter((driver) => driver.deviceId === device.id);
      const selfBinding = bindings.find((driver) => driver.role === "self" && !driver.detachedAt);
      const self = selfBinding
        ? input.selfMachines.find((machine) => machine.id === selfBinding.runnerId)
        : undefined;
      const drivers = bindings.map((driver) => ({
        role: driver.role,
        runnerId: driver.runnerId,
        generation: driver.generation,
        attached: driver.detachedAt === null,
        runnerName: input.runnerNames.get(driver.runnerId) ?? "Computer",
      }));
      const live = input.live?.status(device.id);
      const active = bindings.find(
        (driver) => !driver.detachedAt && driver.role === (self ? "self" : "screen"),
      );
      const connected = live?.connected ?? self?.status === "online";
      const capabilities = deviceCapabilities(device, self, connected);
      let phoneDisplay = live?.phoneDisplay ?? null;
      const screen = !selfBinding && device.kind === "phone" && device.platform === "ios";
      if (!phoneDisplay && (screen || device.kind === "agent-phone")) {
        const driver =
          drivers.find((driver) => driver.role === (screen ? "screen" : "self")) ?? null;
        const reason: "not-connected" | "driver-offline" | "unreported" = !active
          ? "not-connected"
          : !input.runnerConnected(active.runnerId)
            ? "driver-offline"
            : "unreported";
        const unavailable = { state: "unavailable" as const, reason: { kind: reason } };
        phoneDisplay = {
          definitionId: screen ? iphoneScreenDefinitionId : androidPhoneDefinitionId,
          driver,
          control: !capabilities.apps.enabled
            ? { state: "disabled", reason: { kind: "access-off" } }
            : unavailable,
          view: unavailable,
          input: unavailable,
          navigationButtons: [],
          actions: [],
          wake: false,
          lock: null,
          setup:
            screen && driver
              ? {
                  location: "driver-mac",
                  driverRunnerId: driver.runnerId,
                  driverRunnerName: driver.runnerName,
                }
              : { location: screen ? "this-device" : "android-usb" },
        } satisfies PhoneDisplayView;
      }
      if (phoneDisplay && !deviceAccess(device.accessPolicy).apps)
        phoneDisplay = {
          ...phoneDisplay,
          control: { state: "disabled", reason: { kind: "access-off" } },
        };
      if (phoneDisplay)
        capabilities.apps = {
          ...capabilities.apps,
          supported: true,
          configurable: true,
          ...phoneDisplay.control,
          enabled: device.accessPolicy.apps ?? true,
        };
      return {
        ...(self ?? {
          access: null,
          allowedModules: [],
          apps: null,
          computerUse: null,
          detail: null,
          enrollmentId: null,
          expiresAt: null,
          fullDiskAccess: null,
          lastSeenAt: null,
          modules: {},
          pinnedThreads: 0,
          runtimeVersion: null,
          status: "offline" as const,
          revocable: true,
        }),
        id: device.id,
        name: device.name,
        kind: device.kind,
        selfRunnerId: selfBinding?.runnerId ?? null,
        drivers,
        capabilities,
        phoneDisplay,
        device:
          self?.device ??
          (device.platform && device.form
            ? { platform: device.platform, form: device.form }
            : null),
        ownership: device.ownerKind === "deployment" ? "deployment" : "mine",
        access: self?.access ?? {
          activeSessions: [],
          ownerReachAvailable: true,
          policy: {
            ...device.accessPolicy,
            browser: device.accessPolicy.browser ?? true,
            apps: device.accessPolicy.apps ?? true,
          },
          revision: device.accessPolicyRevision,
        },
        ...(live
          ? {
              apps: live.apps,
              computerUse: live.computerUse,
              status: live.connected ? ("online" as const) : ("offline" as const),
            }
          : {}),
      };
    });
}
