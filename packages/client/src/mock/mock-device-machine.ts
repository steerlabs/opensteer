import { RunnerIdSchema } from "@opensteer/core";
import {
  deviceAccess,
  type MachineSummary,
  type DeviceCapabilities,
  type DeviceCapabilityReason,
  type DeviceDriverView,
  type PhoneDisplayView,
} from "@opensteer/protocol";

const projections = new WeakMap<MachineSummary, MachineSummary>();

export function mockDeviceMachine(machine: MachineSummary): MachineSummary {
  if (machine.capabilities !== undefined || machine.status === "pending") return machine;
  const cached = projections.get(machine);
  if (cached) return cached;
  const parsed = RunnerIdSchema.safeParse(machine.id);
  const runnerId =
    machine.selfRunnerId === undefined
      ? parsed.success
        ? parsed.data
        : null
      : machine.selfRunnerId;
  const home =
    machine.kind === "home" ||
    (machine.kind === undefined &&
      machine.ownership === "deployment" &&
      machine.allowedModules?.includes("agents"));
  const phone =
    (machine.kind === "agent-phone" ||
      (machine.kind === undefined &&
        machine.apps?.some(({ definitionId }) => definitionId === "android-phone"))) &&
    Boolean(machine.allowedModules?.includes("integrations") || machine.modules?.integrations);
  const kind = machine.kind ?? (home ? "home" : phone ? "agent-phone" : "unknown");
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
  const driver: DeviceDriverView | null = runnerId
    ? {
        role: "self",
        runnerId,
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
    selfRunnerId: runnerId,
    drivers: driver ? [driver] : [],
    capabilities,
    phoneDisplay,
  };
  projections.set(machine, projected);
  return projected;
}
