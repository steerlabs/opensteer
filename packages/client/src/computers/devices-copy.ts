/**
 * Every word the Devices screens, the Device and Home pages and the asleep moment show, by
 * stable id. Web and phone both read these, so they say the same thing. `{name}` marks a
 * value filled in by `deviceWords`.
 */
export const devicesCopy = {
  "devices.title": "Devices",
  "devices.lead": "Your Opensteer lives on {home}. Agents reach your other Devices through it.",
  "devices.lead.cloud": "your Cloud Computer",
  "devices.lead.work": "your {organization} work Home",
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
    "Connected agents also need you to choose this Device’s profile or app for them.",
  "devices.reach.title": "Who can use it",
  "devices.reach.nobody": "Allow no other computers",
  "devices.reach.owner": "Allow my agents",
  "devices.reach.deployment": "Allow agents in this Opensteer",
  "devices.switch.browserDetail": "Open and use tabs",
  "devices.switch.appsDetail": "See and control apps",
  "devices.switch.filesDetail": "Read files and run commands",
  "home.remoteAccess": "Remote access",
  "home.thisMac": "Running on this Mac",
  "home.address": "Address",
  "home.version": "Version",
  "home.owner": "Signed in as owner",
  "asleep.gate":
    "{device} isn’t reachable. It may be asleep or offline. Agents can’t use it until it’s back.",
  "asleep.activity": "Couldn’t reach {device}: asleep",
  "asleep.someDevice": "a Device",
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
