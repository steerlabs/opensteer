import type { AuthSessionSummary } from "@opensteer/core";
import {
  computerGlyph,
  computerStatus,
  devicesView,
  hostsDeployment,
  isServiceMachine,
} from "@opensteer/client/computers";
import type { MachineSummary, OtherDevice } from "@opensteer/protocol";
import type { SFSymbolName } from "../ui/symbol.js";
import { computerSymbols } from "./settings-model.js";

/** Where a row of Devices leads. */
export type DeviceRowOpens =
  | { readonly kind: "device"; readonly machineId: string }
  | { readonly kind: "set-up" }
  | { readonly kind: "use-here"; readonly elsewhere: string; readonly elsewhereName: string }
  | { readonly kind: "session"; readonly session: AuthSessionSummary }
  | null;

export interface DeviceListRow {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly symbol: SFSymbolName;
  readonly opens: DeviceRowOpens;
}

export interface DeviceListSection {
  readonly key: "here" | "other" | "signed-in";
  readonly title: string;
  readonly footer: string | null;
  readonly rows: readonly DeviceListRow[];
}

/** This phone as Devices sees it, when it is not (yet) one of this Opensteer's devices. */
export type PhoneHere =
  | { readonly state: "member"; readonly runnerId: string }
  | { readonly state: "elsewhere"; readonly deploymentId: string; readonly deploymentName: string }
  | { readonly state: "needs-setup"; readonly deviceName: string }
  | { readonly state: "none" };

/**
 * Devices, as the phone lists them: this phone and Home first under no
 * header, then other devices, then sessions that run nothing. A phone that
 * belongs to another Opensteer says so, with the explicit way to move it.
 */
export function deviceListSections(input: {
  readonly machines: readonly MachineSummary[];
  readonly sessions: readonly AuthSessionSummary[];
  readonly here: PhoneHere;
  readonly noun: string;
  readonly otherDevices?: readonly OtherDevice[];
  readonly now?: Date;
}): readonly DeviceListSection[] {
  const hereId = input.here.state === "member" ? input.here.runnerId : null;
  const view = devicesView({
    machines: input.machines,
    sessions: input.sessions,
    hereId,
    otherDevices: input.otherDevices ?? [],
  });
  const row = (machine: MachineSummary, thisDevice: boolean): DeviceListRow => {
    const home = machine.kind === "home" || hostsDeployment(machine);
    const status = home ? "Home · your agent runs here" : computerStatus(machine, input.now).label;
    return {
      key: machine.id,
      title: machine.name,
      detail: thisDevice ? `This ${input.noun} · ${status}` : status,
      symbol: deviceSymbol(machine, thisDevice),
      opens: { kind: "device", machineId: machine.id },
    };
  };
  const first: DeviceListRow[] = [];
  const thisDevice = view.devices.find((device) => device.thisDevice);
  if (thisDevice !== undefined) first.push(row(thisDevice.machine, true));
  else if (input.here.state === "elsewhere")
    first.push({
      key: "this-phone",
      title: `This ${input.noun}`,
      detail: `Set up with ${input.here.deploymentName}`,
      symbol: "smartphone",
      opens: {
        kind: "use-here",
        elsewhere: input.here.deploymentId,
        elsewhereName: input.here.deploymentName,
      },
    });
  else if (input.here.state === "needs-setup")
    first.push({
      key: "this-phone",
      title: input.here.deviceName,
      detail: `This ${input.noun} · Finish setting up`,
      symbol: "smartphone",
      opens: { kind: "set-up" },
    });
  const home = view.devices.find(
    (device) =>
      !device.thisDevice && (device.machine.kind === "home" || hostsDeployment(device.machine)),
  );
  if (home !== undefined) first.push(row(home.machine, false));
  const others = view.devices
    .filter((device) => !device.thisDevice && device !== home && !isServiceMachine(device.machine))
    .map((device) => row(device.machine, false));
  // This phone's own unbound session is the phone itself, never "also signed in".
  const signedIn = view.alsoSignedIn
    .filter(({ session }) => !session.current)
    .map(({ session, label, status }): DeviceListRow => ({
      key: session.id,
      title: label,
      detail: status,
      symbol: session.form === "mobile" ? "smartphone" : "globe",
      opens: { kind: "session", session },
    }));
  return [
    { key: "here" as const, title: "", footer: null, rows: first },
    { key: "other" as const, title: "Other devices", footer: null, rows: others },
    {
      key: "signed-in" as const,
      title: "Also signed in",
      footer: view.alsoSignedInCaption,
      rows: signedIn,
    },
  ].filter((section) => section.rows.length > 0);
}

function deviceSymbol(machine: MachineSummary, thisDevice: boolean): SFSymbolName {
  if (thisDevice || machine.kind === "phone" || machine.kind === "agent-phone") return "smartphone";
  if (machine.kind === "server") return "server.rack";
  return computerSymbols[computerGlyph(machine)];
}
