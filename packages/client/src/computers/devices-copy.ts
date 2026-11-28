/**
 * Every word the Devices screens, the Device and Home pages and the asleep moment show, by
 * stable id. Web and phone both read these, so they say the same thing. `{name}` marks a
 * value filled in by `deviceWords`.
 */
export const devicesCopy = {
  "devices.title": "Devices",
  "devices.lead": "Your Opensteer lives on {home}. Agents reach your other devices through it.",
  "devices.lead.cloud": "your Cloud Computer",
  "devices.section.home": "Home",
  "devices.section.devices": "Devices",
  "devices.section.alsoSignedIn": "Also signed in",
  "devices.add": "Add a device",
  "devices.home.thisMac": "This Mac · Home · Running",
  "devices.home.mac": "Home · Online",
  "devices.home.server": "Home · Server · Online",
  "devices.home.cloud": "Home · Always on",
  "devices.status.online": "Online",
  "devices.status.asleep": "Asleep · seen {time}",
  "devices.status.asleepNow": "Asleep",
  "devices.status.offline": "Offline · seen {time}",
  "devices.status.offlineNow": "Offline",
  "devices.status.needsUpdate": "Update Opensteer on {device}",
  "devices.status.screenThrough": "iPhone Screen · through {device}",
  "devices.asleep.explain": "Its tabs and apps wait until it wakes. Agents can’t use it meanwhile.",
  "devices.switch.browser": "Browser",
  "devices.switch.apps": "Apps",
  "devices.switch.files": "Files and commands",
  "devices.switch.footer":
    "Connected agents also need you to choose this device’s profile or app for them.",
  "devices.reach.title": "Who can use it",
  "devices.reach.nobody": "Allow no other computers",
  "devices.reach.owner": "Allow my agents",
  "devices.reach.deployment": "Allow agents in this Opensteer",
  "devices.switch.browserDetail": "Open and use tabs",
  "devices.switch.appsDetail": "See and control apps",
  "devices.switch.filesDetail": "Read files and run commands",
  "home.remoteAccess": "Remote access",
  "place.kind.cloud": "Cloud Computer",
  "home.thisMac": "Running on this Mac",
  "home.kept.mac": "Your Opensteer lives on this Mac, so it can’t be removed.",
  "home.kept.server": "Your Opensteer lives on this server, so it can’t be removed.",
  "home.kept.cloud": "Your Opensteer lives on this Cloud Computer, so it can’t be removed.",
  "home.address": "Address",
  "home.version": "Version",
  "home.owner": "Signed in as owner",
  "asleep.gate":
    "{device} isn’t reachable. It may be asleep or offline. Agents can’t use it until it’s back.",
  "asleep.activity": "Couldn’t reach {device}: asleep",
  "asleep.someDevice": "a device",
} as const;

export type DevicesCopyId = keyof typeof devicesCopy;

export function deviceWords(
  id: DevicesCopyId,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return devicesCopy[id].replace(/\{(\w+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/**
 * Why the Home's own device can't be removed, said of what it is: a Mac, a server, or a
 * Cloud Computer. Never "this Mac" for a Home that isn't one.
 */
export function homeKeptWords(home: "this-mac" | "mac" | "server" | "cloud"): string {
  return deviceWords(homeKept[home]);
}

const homeKept = {
  "this-mac": "home.kept.mac",
  mac: "home.kept.mac",
  server: "home.kept.server",
  cloud: "home.kept.cloud",
} as const satisfies Record<string, DevicesCopyId>;
