import type {
  RemoteAccessAction,
  RemoteAccessActionId,
  RemoteAccessView,
} from "@opensteer/client/host";
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
 * "Use from anywhere" on a phone. What it says and offers is the shared
 * `RemoteAccessView`, word for word the same as on the computer; this file only
 * lays it out as native rows. The phone adds two things the view leaves to each
 * surface: re-reading after a failed read, and typing a private network address.
 */
export type RemoteAccessRowAction =
  | { readonly kind: "view"; readonly action: RemoteAccessAction }
  | { readonly kind: "private" }
  | { readonly kind: "reload" };

export interface RemoteAccessSectionsInput {
  readonly view: RemoteAccessView;
  readonly status: PersonalRemoteAdministrationStatus | null;
  readonly computer: string;
  readonly pairing: IssuePersonalPairingCodeResponse | null;
  readonly now: number;
}

/** Rare, technical actions sit under Advanced; the status keeps the one obvious choice. */
const advancedActions: ReadonlySet<RemoteAccessActionId> = new Set(["reset-key", "remove-link"]);
const failedStates: ReadonlySet<RemoteAccessView["state"]> = new Set([
  "unreadable",
  "turn-on-failed",
  "change-failed",
]);
const advancedDetail: Partial<Record<RemoteAccessActionId, string>> = {
  "reset-key": "Only if you think it leaked. Your devices reconnect on their own.",
  "remove-link": "Your devices stop reaching this computer from anywhere.",
};

function tone(view: RemoteAccessView): NativeSettingsTone {
  if (failedStates.has(view.state)) return "bad";
  if (view.tone === "on") return "good";
  if (view.tone === "attention") return "attention";
  return "neutral";
}

const stepState: Record<
  NonNullable<RemoteAccessView["steps"]>[number]["state"],
  NativeSettingsStep["state"]
> = {
  active: "current",
  done: "done",
  todo: "pending",
};

const destructive = (action: RemoteAccessAction) =>
  action.id === "turn-off" || action.id === "remove-link";

export function remoteAccessSections(
  input: RemoteAccessSectionsInput,
  act: (action: RemoteAccessRowAction) => void,
): readonly NativeSettingsSection[] {
  const { view, status } = input;
  const offered = [view.primary, ...view.secondary].filter(
    (action): action is RemoteAccessAction => action !== null,
  );
  const primary = view.primary && !advancedActions.has(view.primary.id) ? view.primary : null;
  const secondary = view.secondary.filter((action) => !advancedActions.has(action.id));
  const rows: NativeSettingsRow[] = [
    {
      key: "status",
      kind: "status",
      tone: tone(view),
      label: view.title,
      ...(view.address === null ? {} : { detail: view.address }),
      ...(view.steps === null
        ? {}
        : {
            steps: view.steps.map((step) => ({ label: step.label, state: stepState[step.state] })),
          }),
    },
    ...(primary
      ? [
          {
            key: primary.id,
            kind: "primary" as const,
            label: primary.label,
            onPress: () => act({ kind: "view", action: primary }),
          },
        ]
      : view.state === "unreadable"
        ? [
            {
              key: "reload",
              kind: "primary" as const,
              label: "Try again",
              onPress: () => act({ kind: "reload" }),
            },
          ]
        : []),
    ...secondary.map((action) => ({
      key: action.id,
      kind: "button" as const,
      label: action.label,
      destructive: destructive(action),
      onPress: () => act({ kind: "view", action }),
    })),
  ];
  const pairing =
    input.pairing !== null && Date.parse(input.pairing.expiresAt) > input.now
      ? input.pairing
      : null;
  if (pairing)
    rows.push({
      key: "pairing",
      kind: "text",
      label: pairing.code,
      detail: `Enter this on the other device. It works once, until ${new Date(
        pairing.expiresAt,
      ).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`,
    });

  const settled =
    view.state === "off" ||
    view.state === "connect-unavailable" ||
    view.state === "on-connect" ||
    view.state === "on-private";
  const advanced: NativeSettingsRow[] =
    status === null || !settled
      ? []
      : [
          {
            key: "private",
            kind: "button",
            label:
              status.access.mode === "private"
                ? "Private network address"
                : "Use a private network",
            detail:
              status.access.mode === "private"
                ? (status.access.route?.document.route.origin ?? "")
                : "Your own VPN or network, instead of your Opensteer Account",
            onPress: () => act({ kind: "private" }),
          },
          ...offered
            .filter((action) => advancedActions.has(action.id))
            .map((action) => ({
              key: action.id,
              kind: "button" as const,
              label: action.label,
              detail: advancedDetail[action.id] ?? "",
              destructive: destructive(action),
              onPress: () => act({ kind: "view", action }),
            })),
        ];
  return [
    {
      key: "remote",
      title: `${input.computer} · Use from anywhere`,
      rows,
      footer: {
        text: view.sentence,
        ...(failedStates.has(view.state) ? { tone: "danger" as const } : {}),
      },
    },
    ...(advanced.length === 0
      ? []
      : [{ key: "remote-advanced", title: "Advanced", rows: advanced, collapsed: true }]),
  ];
}
