import type { RemoteAccessAction, RemoteAccessView } from "@opensteer/client/host";
import type { IssuePersonalPairingCodeResponse } from "@opensteer/protocol";
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
 * surface: re-reading after a failed read, and the sheet for typing a private
 * network address.
 */
export type RemoteAccessRowAction =
  | { readonly kind: "view"; readonly action: RemoteAccessAction }
  | { readonly kind: "private" }
  | { readonly kind: "reload" };

export interface RemoteAccessSectionsInput {
  readonly view: RemoteAccessView;
  readonly computer: string;
  readonly pairing: IssuePersonalPairingCodeResponse | null;
  readonly now: number;
}

const failedStates: ReadonlySet<RemoteAccessView["state"]> = new Set([
  "unreadable",
  "turn-on-failed",
  "change-failed",
  "add-device-failed",
]);

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
  const { view } = input;
  const { primary, secondary } = view;
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

  const advanced: NativeSettingsRow[] = [
    ...(view.privateNetwork
      ? [
          {
            key: "private",
            kind: "button" as const,
            label:
              view.state === "on-private" ? "Private network address" : "Use a private network",
            detail:
              view.state === "on-private"
                ? (view.address ?? "")
                : "Your own VPN or network, instead of your Opensteer Account",
            onPress: () => act({ kind: "private" }),
          },
        ]
      : []),
    ...view.advanced.map((action) => ({
      key: action.id,
      kind: "button" as const,
      label: action.label,
      detail: action.detail ?? "",
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
