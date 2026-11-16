import { RunnerIdSchema } from "@opensteer/core";
import type {
  DeviceCapabilities,
  DeviceCapabilityReason,
  DeviceDriverView,
  MachineSummary,
  PhoneDisplayView,
} from "@opensteer/protocol";
import { deviceAccess } from "@opensteer/protocol";
import type {
  DeviceIntegrationConnectionSummary,
  IntegrationConnectionSummary,
  DeviceComputerAppSetupRequest,
  ComputerAppSetupSummary,
} from "@opensteer/integration-core";

export type ClientMachineSummary = MachineSummary;
export type ClientComputerConnection =
  IntegrationConnectionSummary | DeviceIntegrationConnectionSummary;
export type ClientComputerSetupRequest = ComputerAppSetupSummary | DeviceComputerAppSetupRequest;

export function computerTargetId(
  target: { readonly deviceId: string } | { readonly runnerId: string } | null | undefined,
): string | null {
  return target ? ("deviceId" in target ? target.deviceId : target.runnerId) : null;
}

export function hasDeviceProjection(machine: ClientMachineSummary): boolean {
  return machine.capabilities !== undefined;
}

const projections = new WeakMap<MachineSummary, ClientMachineSummary>();
/** Only v60 self rows need inference; current Host facts always win, including null display. */
export function deviceMachine(machine: ClientMachineSummary): ClientMachineSummary {
  if (hasDeviceProjection(machine) || machine.status === "pending") return machine;
  const cached = projections.get(machine);
  if (cached) return cached;
  const runner = RunnerIdSchema.safeParse(machine.id);
  const home =
    machine.kind === "home" ||
    (machine.kind === undefined &&
      machine.ownership === "deployment" &&
      machine.allowedModules?.includes("agents"));
  const phone =
    machine.kind === "agent-phone" ||
    (machine.kind === undefined &&
      machine.apps?.some(({ definitionId }) => definitionId === "android-phone"));
  const kind =
    machine.kind ??
    (home
      ? "home"
      : phone
        ? "agent-phone"
        : machine.device?.platform === "ios" ||
            (machine.device?.app === "opensteer" && machine.device.form === "phone")
          ? "phone"
          : "unknown");
  const access = machine.access
    ? deviceAccess(machine.access.policy)
    : { browser: true, apps: true, files: true };
  const capability = (
    supported: boolean,
    enabled: boolean,
    configurable = true,
  ): DeviceCapabilities["apps"] => ({
    supported,
    enabled: supported && enabled,
    configurable: supported && configurable,
    state: !supported
      ? "unsupported"
      : !enabled
        ? "disabled"
        : machine.status === "online"
          ? "ready"
          : "unavailable",
    reason: !supported
      ? { kind: "unsupported" }
      : !enabled
        ? { kind: "access-off" }
        : machine.status === "online"
          ? null
          : { kind: "driver-offline" },
  });
  const capabilities: DeviceCapabilities = {
    browser: capability(
      Boolean(
        home ||
        machine.allowedModules?.includes("browser") ||
        machine.modules?.browser !== undefined,
      ),
      access.browser,
      !home,
    ),
    apps: capability(Boolean(machine.modules?.integrations), access.apps),
    files: capability(
      Boolean(
        home || (machine.allowedModules?.includes("shell") && machine.device?.form !== "phone"),
      ),
      access.files,
      !home,
    ),
  };
  const driver: DeviceDriverView | null = runner.success
    ? {
        role: "self",
        runnerId: runner.data,
        runnerName: machine.name,
        generation: 1,
        attached: true,
      }
    : null;
  const report = machine.computerUse;
  const reason: DeviceCapabilityReason | null =
    machine.status === "needs-update" ||
    machine.status === "updating" ||
    machine.status === "update-pending"
      ? { kind: "driver-update-required" }
      : machine.status !== "online"
        ? { kind: "driver-offline" }
        : !access.apps
          ? { kind: "access-off" }
          : !report
            ? { kind: "unreported" }
            : report.state === "permission-required"
              ? { kind: "permission-required" }
              : report.state !== "ready"
                ? { kind: "paused" }
                : null;
  const availability = { state: reason ? ("unavailable" as const) : ("ready" as const), reason };
  const phoneDisplay: PhoneDisplayView | null = phone
    ? {
        definitionId: "android-phone",
        driver,
        control: availability,
        view: report?.displayStreamSupported
          ? availability
          : { state: "unsupported", reason: { kind: "unsupported" } },
        input: availability,
        navigationButtons: [
          { id: "back", label: "Back" },
          { id: "home", label: "Home" },
          { id: "recents", label: "Recents" },
        ],
        actions: [
          "tap",
          "longPress",
          "swipe",
          "drag",
          "type",
          "clear",
          "navigate",
          "launch",
          "scroll",
          "wake",
          "wait",
        ],
        wake: true,
        lock: true,
        setup: { location: "android-usb" },
      }
    : null;
  const projected = {
    ...machine,
    kind,
    selfRunnerId: runner.success ? runner.data : null,
    drivers: driver ? [driver] : [],
    capabilities,
    phoneDisplay,
  };
  projections.set(machine, projected);
  return projected;
}

export function visibleDeviceMachines(
  machines: readonly ClientMachineSummary[],
): ClientMachineSummary[] {
  return machines
    .filter(
      (machine) =>
        hasDeviceProjection(machine) ||
        !(machine.ownership === "deployment" && !machine.allowedModules?.includes("agents")),
    )
    .map(deviceMachine);
}

export function deviceDriverKey(machine: ClientMachineSummary): string | null {
  const projected = deviceMachine(machine);
  const driver =
    projected.phoneDisplay?.driver ?? projected.drivers?.find(({ role }) => role === "self");
  if (!driver && !projected.phoneDisplay) return null;
  return JSON.stringify([
    machine.id,
    driver?.runnerId ?? null,
    driver?.generation ?? null,
    driver?.attached ?? false,
  ]);
}

export function deviceReasonLabel(reason: DeviceCapabilityReason | null): string {
  switch (reason?.kind) {
    case undefined:
      return "Ready";
    case "not-connected":
      return "Not connected";
    case "driver-offline":
      return "Driver offline";
    case "connecting":
    case "unreported":
      return "Connecting…";
    case "locked":
      return "Locked";
    case "protected":
      return "Protected";
    case "paused":
      return "Paused";
    case "access-off":
      return "Apps off";
    case "approval-required":
      return "Access needed";
    case "driver-update-required":
      return "Driver needs update";
    case "setup-required":
    case "trust-required":
    case "developer-mode-required":
    case "permission-required":
      return "Needs setup";
    case "unsupported":
      return "Not available";
    case "helper-unavailable":
    case "runtime-failed":
      return "Unavailable";
  }
}
