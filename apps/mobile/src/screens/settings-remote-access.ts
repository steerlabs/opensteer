import type {
  IssuePersonalPairingCodeResponse,
  PersonalRemoteAdministrationStatus,
} from "@opensteer/protocol";
import type {
  NativeSettingsRow,
  NativeSettingsSection,
  NativeSettingsStep,
  NativeSettingsTone,
} from "./native-settings-page.types.js";

/**
 * "Use from anywhere" on a phone: one state, one sentence, one obvious action.
 * `remoteAccessView` is the only place that reads the Host's remote-access
 * status; everything the Account page shows about it comes from its result.
 */

export type RemoteAccessActionId =
  | "turn-on"
  | "turn-off"
  | "try-again"
  | "cancel"
  | "remove-link"
  | "reload"
  | "private"
  | "rotate"
  | "pair";

export interface RemoteAccessAction {
  readonly id: RemoteAccessActionId;
  readonly label: string;
  readonly destructive?: boolean;
}

export interface RemoteAccessView {
  readonly tone: NativeSettingsTone;
  readonly title: string;
  readonly sentence: string | null;
  /** The sentence says what went wrong. */
  readonly failed: boolean;
  readonly address: string | null;
  readonly steps: readonly NativeSettingsStep[];
  readonly primary: RemoteAccessAction | null;
  readonly secondary: readonly RemoteAccessAction[];
  /** Rarely needed controls, shown folded away; null while access can't be read. */
  readonly advanced: readonly (RemoteAccessAction & { readonly detail: string })[] | null;
}

/** Turn on's own progress before the Host has an operation to report. */
export interface RemoteAccessTurnOn {
  readonly step: "sign-in" | "link" | "request";
  /** The first step was signing in, so it stays in the list once done. */
  readonly signedInFirst: boolean;
  readonly failed: string | null;
}

export interface RemoteAccessInput {
  readonly status: PersonalRemoteAdministrationStatus | null;
  readonly error: string | null;
  readonly signedIn: boolean;
  /** The signed-in Account, to tell a link to someone else's Account apart. */
  readonly account: { readonly issuer: string; readonly subject: string } | null;
  /** The computer's name, as the person calls it. */
  readonly computer: string;
  readonly turnOn: RemoteAccessTurnOn | null;
  readonly pairing: IssuePersonalPairingCodeResponse | null;
  readonly now: number;
}

const turnOff: RemoteAccessAction = { id: "turn-off", label: "Turn off", destructive: true };
const cancel: RemoteAccessAction = { id: "cancel", label: "Cancel" };
const tryAgain: RemoteAccessAction = { id: "try-again", label: "Try again" };

function busy(status: PersonalRemoteAdministrationStatus): boolean {
  return status.operation?.state === "pending" || status.operation?.state === "running";
}

export function remoteAccessView(input: RemoteAccessInput): RemoteAccessView {
  const { status, computer } = input;
  const view = (fields: Partial<RemoteAccessView> & Pick<RemoteAccessView, "title">) => ({
    tone: "neutral" as const,
    sentence: null,
    failed: false,
    address: null,
    steps: [],
    primary: null,
    secondary: [],
    advanced: status === null ? null : advancedActions(status, computer),
    ...fields,
  });
  if (status === null)
    return input.error === null
      ? view({ title: "Checking…" })
      : view({
          tone: "bad",
          title: "Couldn’t check",
          sentence: `This phone couldn’t read whether ${computer} can be used from anywhere.`,
          failed: true,
          primary: { id: "reload", label: "Try again" },
        });

  const access = status.access;
  const operation = status.operation;
  const link = access.accountLink;
  const address = access.route?.document.route.origin ?? null;
  const connectAvailable = status.accountIssuer !== null;
  const turningOn =
    input.turnOn !== null ||
    (operation !== null &&
      busy(status) &&
      operation.intent.action === "configure" &&
      operation.intent.mode !== "off");

  if (input.turnOn?.failed)
    return view({
      tone: "bad",
      title: "Couldn’t turn on",
      sentence: input.turnOn.failed,
      failed: true,
      steps: turnOnSteps(input),
      primary: tryAgain,
      secondary: [cancel],
    });
  if (turningOn) {
    const waiting = input.turnOn === null && !status.executorConnected;
    return view({
      title: waiting ? `Waiting for ${computer}` : "Turning on…",
      sentence: waiting
        ? `Open Opensteer on ${computer} to finish. This finishes by itself.`
        : input.turnOn?.step === "sign-in"
          ? "Approve the sign-in in your browser. This continues by itself."
          : null,
      steps: turnOnSteps(input),
      secondary: [cancel],
    });
  }
  if (operation !== null && busy(status)) {
    const removing = operation.intent.action === "unlink";
    return view({
      title: removing
        ? "Removing link…"
        : operation.intent.action === "rotate"
          ? "Resetting key…"
          : "Turning off…",
      sentence: status.executorConnected
        ? null
        : `Open Opensteer on ${computer} to finish. This finishes by itself.`,
      secondary: removing ? [] : [turnOff],
    });
  }

  if (
    link !== null &&
    input.account !== null &&
    (link.issuer !== input.account.issuer || link.subject !== input.account.subject)
  )
    return view({
      tone: "attention",
      title: "Linked to a different Account",
      sentence: `${computer} is linked to another Opensteer Account. Remove the link to connect it to yours.`,
      primary: { id: "remove-link", label: "Remove link", destructive: true },
      secondary: access.mode === "off" ? [] : [turnOff],
    });

  const failedChange = operation?.state === "failed" ? operation : null;
  const failure = failedChange?.detail ?? input.error ?? "Something went wrong. Try again.";

  if (access.mode !== "off") {
    const on = {
      tone: "good" as const,
      title: access.mode === "connect" ? "On" : "On · private network",
      address,
    };
    if (failedChange !== null || input.error !== null)
      return view({
        ...on,
        tone: "bad",
        title:
          failedChange?.intent.action === "rotate"
            ? "Couldn’t reset the key"
            : failedChange?.intent.action === "unlink"
              ? "Couldn’t remove the link"
              : failedChange?.intent.action === "configure" && failedChange.intent.mode === "off"
                ? "Couldn’t turn off"
                : "Something went wrong",
        sentence: `${failure} It’s still on.`,
        failed: true,
        primary: failedChange === null ? null : tryAgain,
        secondary: [turnOff],
      });
    return view({
      ...on,
      sentence:
        access.mode === "connect"
          ? `Your phone and signed-in devices can open ${computer} from anywhere.`
          : `Devices on your private network can open ${computer}.`,
      secondary: [turnOff],
    });
  }

  if (failedChange !== null && failedChange.intent.action === "configure")
    return view({
      tone: "bad",
      title: "Couldn’t turn on",
      sentence: failure,
      failed: true,
      primary: tryAgain,
      secondary: [cancel],
    });
  if (!connectAvailable)
    return view({
      title: "Off",
      sentence: `This version can only use a private network. Set one up under Advanced.`,
    });
  if (link?.state === "activating")
    return view({
      tone: "attention",
      title: "Finishing setup",
      sentence: `${computer} is still being added to your Account.`,
      primary: { id: "turn-on", label: "Continue" },
    });
  return view({
    title: "Off",
    sentence: input.signedIn
      ? `Only devices on the same network can open ${computer}. Turn on to open it from anywhere.`
      : "Turn on signs you in to your Opensteer Account first, in your browser.",
    failed: false,
    ...(input.error === null ? {} : { tone: "bad" as const, sentence: input.error, failed: true }),
    primary: { id: "turn-on", label: "Turn on" },
  });
}

function turnOnSteps(input: RemoteAccessInput): readonly NativeSettingsStep[] {
  const status = input.status;
  const flow = input.turnOn;
  const linked = status?.access.accountLink?.state === "active";
  const order = ["sign-in", "link", "request"] as const;
  const at = flow === null ? (linked ? 2 : 1) : order.indexOf(flow.step);
  const state = (index: number): NativeSettingsStep["state"] =>
    index < at ? "done" : index > at ? "pending" : flow?.failed ? "failed" : "current";
  return [
    ...(flow?.signedInFirst
      ? [{ label: "Sign in to your Opensteer Account", state: state(0) }]
      : []),
    { label: `Add ${input.computer} to your Account`, state: linked ? "done" : state(1) },
    { label: "Open a secure connection", state: state(2) },
  ];
}

function advancedActions(
  status: PersonalRemoteAdministrationStatus,
  computer: string,
): readonly (RemoteAccessAction & { readonly detail: string })[] {
  const access = status.access;
  return [
    {
      id: "private",
      label: access.mode === "private" ? "Private network address" : "Use a private network",
      detail:
        access.mode === "private"
          ? (access.route?.document.route.origin ?? "")
          : "Your own VPN or network, instead of your Opensteer Account",
    },
    ...(access.mode === "connect"
      ? [
          {
            id: "rotate" as const,
            label: "Reset connection key",
            detail: "Only if you think it leaked. Your devices reconnect on their own.",
          },
        ]
      : []),
    ...(access.mode === "private"
      ? [
          {
            id: "pair" as const,
            label: "Add a device",
            detail: "Make a one-time code for a device on your network",
          },
        ]
      : []),
    ...(access.accountLink !== null
      ? [
          {
            id: "remove-link" as const,
            label: "Remove from your Account",
            detail: `${computer} stops showing up on your other devices`,
            destructive: true,
          },
        ]
      : []),
  ];
}

/**
 * The Account page's "Use from anywhere" groups, built from `remoteAccessView`.
 * `act` runs the action the person chose; confirmations are the caller's.
 */
export function remoteAccessSections(
  input: RemoteAccessInput,
  act: (action: RemoteAccessActionId) => void,
): readonly NativeSettingsSection[] {
  const view = remoteAccessView(input);
  const rows: NativeSettingsRow[] = [
    {
      key: "status",
      kind: "status",
      tone: view.tone,
      label: view.title,
      ...(view.address === null ? {} : { detail: view.address }),
      ...(view.steps.length === 0 ? {} : { steps: view.steps }),
    },
    ...(view.primary === null
      ? []
      : [
          {
            key: view.primary.id,
            kind: "primary" as const,
            label: view.primary.label,
            onPress: () => act(view.primary!.id),
          },
        ]),
    ...view.secondary.map((action) => ({
      key: action.id,
      kind: "button" as const,
      label: action.label,
      destructive: action.destructive ?? false,
      onPress: () => act(action.id),
    })),
  ];
  const pairing =
    input.pairing !== null && Date.parse(input.pairing.expiresAt) > input.now
      ? input.pairing
      : null;
  const advanced: NativeSettingsRow[] = [
    ...(view.advanced ?? []).map((action) => ({
      key: action.id,
      kind: "button" as const,
      label: action.label,
      detail: action.detail,
      destructive: action.destructive ?? false,
      onPress: () => act(action.id),
    })),
    ...(pairing === null
      ? []
      : [
          {
            key: "pairing",
            kind: "text" as const,
            label: pairing.code,
            detail: `Pairing code · works until ${new Date(pairing.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
          },
        ]),
  ];
  return [
    {
      key: "remote",
      title: `${input.computer} · Use from anywhere`,
      rows,
      ...(view.sentence === null
        ? {}
        : { footer: { text: view.sentence, ...(view.failed ? { tone: "danger" as const } : {}) } }),
    },
    ...(advanced.length === 0
      ? []
      : [{ key: "remote-advanced", title: "Advanced", rows: advanced, collapsed: true }]),
  ];
}
