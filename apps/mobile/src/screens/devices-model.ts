import type { AuthSessionSummary } from "@opensteer/core";
import {
  computerGlyph,
  deviceStoppedLabel,
  deviceWords,
  devicesScreen,
  type DeviceRowTone,
  type HomeKindFact,
} from "@opensteer/client/computers";
import type { MachineSummary, OtherDevice } from "@opensteer/protocol";
import type { SFSymbolName } from "../ui/symbol.js";
import { computerSymbols } from "./settings-model.js";

type DeviceRowOpens =
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
  /** Amber for a Device that is asleep or needs an update; absent otherwise. */
  readonly tone?: "attention";
}

interface DeviceListSection {
  readonly key: "home" | "devices" | "signed-in";
  readonly title: string;
  readonly footer: string | null;
  readonly rows: readonly DeviceListRow[];
}

export type PhoneHere =
  | { readonly state: "member"; readonly runnerId: string }
  | { readonly state: "elsewhere"; readonly deploymentId: string; readonly deploymentName: string }
  | { readonly state: "needs-setup"; readonly deviceName: string }
  | { readonly state: "none" };

const homeSymbols = { server: "server.rack", cloud: "cloud" } as const;

/** The phone's Devices screen: the Home, then every Device with this phone first, then sessions. */
export function deviceListSections(input: {
  readonly machines: readonly MachineSummary[];
  readonly sessions: readonly AuthSessionSummary[];
  readonly here: PhoneHere;
  readonly noun: string;
  readonly home: HomeKindFact;
  readonly deploymentName: string;
  readonly devicesAvailable: boolean;
  readonly otherDevices?: readonly OtherDevice[];
  readonly now?: Date;
}): readonly DeviceListSection[] {
  const hereId = input.here.state === "member" ? input.here.runnerId : null;
  const screen = devicesScreen({
    machines: input.machines,
    sessions: input.sessions,
    hereId,
    home: input.home,
    deploymentName: input.deploymentName,
    devicesAvailable: input.devicesAvailable,
    ...(input.now ? { now: input.now } : {}),
  });
  const homeMachine = input.machines.find(({ id }) => id === screen.home.machineId) ?? null;
  const homeRow: DeviceListRow = {
    key: screen.home.machineId ?? "home",
    title: screen.home.title,
    // The person's Stop on the Home Mac itself, in the Mac's own words, says more than its kind.
    detail:
      (homeMachine === null ? null : deviceStoppedLabel(homeMachine, input.now)) ??
      screen.home.detail,
    symbol:
      screen.home.symbol === "laptop"
        ? homeMachine === null
          ? "laptopcomputer"
          : computerSymbols[computerGlyph(homeMachine)]
        : homeSymbols[screen.home.symbol],
    opens:
      screen.home.machineId === null ? null : { kind: "device", machineId: screen.home.machineId },
  };
  const row = (device: (typeof screen.devices)[number]): DeviceListRow => {
    const kind = device.thisDevice ? null : deviceKindLabel(device.machine);
    return {
      key: device.machine.id,
      title: device.title,
      detail: device.thisDevice
        ? `This ${input.noun} · ${device.detail}`
        : kind === null
          ? device.detail
          : `${kind} · ${device.detail}`,
      symbol: deviceSymbol(device.machine, device.thisDevice),
      opens: { kind: "device", machineId: device.machine.id },
      ...(attention(device.tone) ? { tone: "attention" as const } : {}),
    };
  };
  const thisDevice = screen.devices.find((device) => device.thisDevice);
  const first: DeviceListRow[] =
    thisDevice !== undefined
      ? [row(thisDevice)]
      : input.here.state === "elsewhere"
        ? [
            {
              key: "this-phone",
              title: `This ${input.noun}`,
              detail: `Set up with ${input.here.deploymentName}`,
              symbol: "smartphone",
              opens: {
                kind: "use-here",
                elsewhere: input.here.deploymentId,
                elsewhereName: input.here.deploymentName,
              },
            },
          ]
        : input.here.state === "needs-setup"
          ? [
              {
                key: "this-phone",
                title: input.here.deviceName,
                detail: `This ${input.noun} · Finish setting up`,
                symbol: "smartphone",
                opens: { kind: "set-up" },
              },
            ]
          : [];
  const others = screen.devices.filter((device) => !device.thisDevice).map(row);
  // This phone's own unbound session is the phone itself, never "also signed in".
  const signedIn = screen.alsoSignedIn
    .filter(({ session }) => !session.current)
    .map(({ session, label, status }): DeviceListRow => ({
      key: session.id,
      title: label,
      detail: status,
      symbol: session.form === "mobile" ? "smartphone" : "globe",
      opens: { kind: "session", session },
    }));
  const sections: DeviceListSection[] = [
    {
      key: "home",
      title: deviceWords("devices.section.home"),
      footer: screen.lead,
      rows: [homeRow],
    },
    {
      key: "devices",
      title: deviceWords("devices.section.devices"),
      footer: null,
      rows: [...first, ...others],
    },
    {
      key: "signed-in",
      title: deviceWords("devices.section.alsoSignedIn"),
      footer: screen.alsoSignedInCaption,
      rows: signedIn,
    },
  ];
  return sections.filter((section) => section.rows.length > 0);
}

function attention(tone: DeviceRowTone): boolean {
  return tone === "asleep" || tone === "attention";
}

/** What kind of device it is, where its name alone doesn't say: from the Host's kind only. */
export function deviceKindLabel(machine: Pick<MachineSummary, "kind">): string | null {
  if (machine.kind === "agent-phone") return "Agent Phone";
  if (machine.kind === "server") return "Server";
  return null;
}

function deviceSymbol(machine: MachineSummary, thisDevice: boolean): SFSymbolName {
  if (thisDevice || machine.kind === "phone" || machine.kind === "agent-phone") return "smartphone";
  if (machine.kind === "server") return "server.rack";
  return computerSymbols[computerGlyph(machine)];
}
