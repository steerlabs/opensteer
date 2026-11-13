import type { IphoneAppId } from "../platform/iphone-apps.js";
import { addIphoneFailureText } from "../iphone-apps/model.js";
import type { PhoneSetupDraft, PhoneSetupOutcome, PhoneSetupState } from "./phone-setup.js";

/** One switch on Set up, in the words both platforms show. */
export interface SetupSwitch {
  readonly key: "browser" | "notifications" | IphoneAppId;
  readonly title: string;
  readonly detail: string;
  readonly value: boolean;
  /** The OS said no after Continue: the switch reads off and offers Settings. */
  readonly denied: boolean;
  readonly disabled: boolean;
}

export interface SetupFormProps {
  readonly title: string;
  readonly name: string;
  readonly onName: (name: string) => void;
  readonly agent: readonly SetupSwitch[];
  /** Photos, alone under its own footer: it shares the whole library. */
  readonly photos: SetupSwitch | null;
  readonly notifications: SetupSwitch;
  readonly noun: string;
  readonly onToggle: (key: SetupSwitch["key"], value: boolean) => void;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly continueLabel: string;
  readonly onContinue: () => void;
  /** Offered only once setup failed, so a Host problem never traps the person here. */
  readonly onNotNow: (() => void) | null;
  readonly onOpenSettings: () => void;
  readonly disclosure: string;
}

const appCopy: Readonly<Record<IphoneAppId, { readonly title: string; readonly detail: string }>> =
  {
    "apple-calendar": { title: "Calendar", detail: "Read and add events" },
    "apple-contacts": { title: "Contacts", detail: "Look people up" },
    "apple-reminders": { title: "Reminders", detail: "Read and add reminders" },
    "iphone-location": { title: "Location", detail: "Where you are, when asked" },
    "iphone-photos": { title: "Photos", detail: "Find photos by date and place" },
  };

export const photosFooter = "Shares your whole library";

/** The one review the switches get: where what the agent reads goes, and what is never shared. */
export function setupDisclosure(opensteer: string, companies: string, noun: string): string {
  return `What your agent reads here goes to ${opensteer} and may go to ${companies}. Nothing else on this ${noun} is shared: not other apps, files, messages or the screen.`;
}
export const allowInSettings = "Allow in Settings";

export function setupSwitches(input: {
  readonly draft: PhoneSetupDraft;
  readonly state: PhoneSetupState;
  readonly busy: boolean;
  readonly devicesAvailable: boolean;
  readonly noun: string;
}): {
  readonly agent: readonly SetupSwitch[];
  readonly photos: SetupSwitch | null;
  readonly notifications: SetupSwitch;
} {
  const one = (
    key: SetupSwitch["key"],
    title: string,
    detail: string,
    chosen: boolean,
    outcome: PhoneSetupOutcome | undefined,
    locked = false,
  ): SetupSwitch => ({
    key,
    title,
    detail,
    denied: outcome === "denied",
    value: chosen && outcome !== "denied",
    disabled: input.busy || locked,
  });
  const apps = (Object.keys(input.draft.apps) as IphoneAppId[]).map((app) =>
    one(
      app,
      appCopy[app].title,
      appCopy[app].detail,
      input.draft.apps[app] === true,
      input.state.apps[app],
    ),
  );
  return {
    agent: [
      // An older Host stores no switches, so its Browser stays as it always was.
      one(
        "browser",
        "Browser",
        input.devicesAvailable
          ? `Open and use tabs on this ${input.noun}`
          : "Update Opensteer on your Mac to choose",
        input.draft.browser || !input.devicesAvailable,
        input.state.browser,
        !input.devicesAvailable,
      ),
      ...apps.filter(({ key }) => key !== "iphone-photos"),
    ],
    photos: apps.find(({ key }) => key === "iphone-photos") ?? null,
    notifications: one(
      "notifications",
      "Notifications",
      "Tell you when your agent needs you or finishes",
      input.draft.notifications,
      input.state.notifications,
    ),
  };
}

export function setupFailureText(
  state: PhoneSetupState,
  opensteer: string,
  noun: string,
): string | null {
  return state.phase.kind === "failed"
    ? addIphoneFailureText(state.phase.failure, opensteer, noun)
    : null;
}

export interface ReadyFormProps {
  readonly title: string;
  readonly body: string;
  readonly agent: readonly ReadyRow[];
  readonly here: readonly ReadyRow[];
  readonly noun: string;
  readonly onDone: () => void;
}

/** Ready, honestly: each switch as it settled, never as it was hoped. */
export interface ReadyRow {
  readonly key: string;
  readonly title: string;
  readonly value: string;
  readonly attention: boolean;
}

export function readyRows(
  state: PhoneSetupState,
  devicesAvailable: boolean,
): { readonly agent: readonly ReadyRow[]; readonly here: readonly ReadyRow[] } {
  const value = (outcome: PhoneSetupOutcome | undefined): string => {
    switch (outcome) {
      case "on":
        return "On";
      case "denied":
        return "Not allowed in Settings";
      case "waiting":
        return "Waiting to be confirmed";
      case "unavailable":
        return "Not available";
      case "off":
      case undefined:
        return "Off";
    }
  };
  const row = (key: string, title: string, outcome: PhoneSetupOutcome | undefined): ReadyRow => ({
    key,
    title,
    value: value(outcome),
    attention: outcome === "denied" || outcome === "waiting" || outcome === "unavailable",
  });
  return {
    agent: [
      row("browser", "Browser", devicesAvailable ? state.browser : "on"),
      ...(Object.keys(state.apps) as IphoneAppId[]).map((app) =>
        row(app, appCopy[app].title, state.apps[app]),
      ),
    ],
    here: [row("notifications", "Notifications", state.notifications)],
  };
}

export function readyTitle(name: string): string {
  return `${name} is ready`;
}

export function readyBody(input: {
  readonly name: string;
  readonly homeName: string | null;
  readonly sharesAnything: boolean;
}): string {
  if (!input.sharesAnything)
    return `${input.name} is signed in. Your agent can't use it until you turn something on.`;
  return `Tabs you open here run here. Your agent${
    input.homeName === null ? "" : ` on ${input.homeName}`
  } can reach what you shared.`;
}

export function readyFooter(noun: string): string {
  return `Change any of this in Devices › This ${noun}.`;
}
