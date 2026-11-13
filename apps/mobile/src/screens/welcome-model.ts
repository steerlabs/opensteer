import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { Share } from "react-native";
import { accountDoorPresentation } from "./account-door.js";

export interface WelcomeProps {
  readonly account: DesktopAccountAuthState["account"];
  readonly signedInAs?: string | null;
  readonly failure: string | null;
  readonly onAccount: () => void;
  readonly onAddress: () => void;
  readonly onScan: () => void;
  readonly portalOrigin: string | null;
  readonly signingIn: boolean;
}

export const welcomeCopy = {
  address: "Enter address",
  failureTitle: "Opensteer sign-in did not finish",
  mac: "Send me the Mac link",
  otherWays: "Already have Opensteer?",
  scan: "Scan QR Code",
  title: "Opensteer runs on your Mac",
} as const;

export function welcomeSentence(noun: string): string {
  return `Install it there, and this ${noun} will find it.`;
}

/** What the first run shows, shared by the iOS form and the Android screen. */
export function welcomePresentation(props: WelcomeProps): {
  /** The Account door, absent from a build with no Account to sign in to. */
  readonly account: { readonly disabled: boolean; readonly label: string } | null;
  readonly failure: string | null;
  readonly footer: string;
  readonly macLink: string | null;
  readonly signedInAs: string | null;
} {
  const door = accountDoorPresentation(props.account, props.signingIn);
  const unavailable = !props.account.available;
  return {
    account:
      unavailable || props.signedInAs != null
        ? null
        : { disabled: door.disabled, label: door.title },
    failure:
      props.failure ??
      ((props.account.status === "error" || unavailable) && props.account.detail !== null
        ? door.description
        : null),
    footer:
      props.signedInAs != null
        ? "Your Opensteer appears here as soon as your Mac has it."
        : unavailable
          ? "Use an address for Tailscale or your own server."
          : "Sign in if your Mac uses Opensteer Connect. Use an address for Tailscale or your own server.",
    macLink: props.portalOrigin ? `${props.portalOrigin}/mac` : null,
    signedInAs: props.signedInAs ?? null,
  };
}

export function shareMacLink(url: string): void {
  void Share.share({ message: url, url }).catch(() => undefined);
}
