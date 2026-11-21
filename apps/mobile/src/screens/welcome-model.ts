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
  otherWays: "Other ways in",
  scan: "Scan QR Code",
  title: "Open your Opensteer",
} as const;

/**
 * What the first screen says Opensteer is: it runs on a Mac or on a Cloud Computer, and the
 * Opensteer account finds either. A build with no account to sign in to has only the Mac.
 * It never offers to buy anything.
 */
export function welcomeSentence(noun: string, account = true): string {
  return account
    ? `It runs on your Mac or on a Cloud Computer. Sign in with your Opensteer account, and this ${noun} will find it.`
    : `Install it on your Mac, and this ${noun} will find it.`;
}

/** What the first run shows, shared by the iOS form and the Android screen. */
export function welcomePresentation(props: WelcomeProps): {
  /** The Account door, absent from a build with no Account to sign in to. */
  readonly account: { readonly disabled: boolean; readonly label: string } | null;
  readonly failure: string | null;
  readonly footer: string;
  readonly macLink: string | null;
  readonly signedInAs: string | null;
  /** What the first screen says, with the account in it while there is one to sign in to. */
  readonly sentence: (noun: string) => string;
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
        ? "Your Opensteer appears here as soon as it’s ready."
        : "Use an address for Tailscale or your own server.",
    macLink: props.portalOrigin ? `${props.portalOrigin}/mac` : null,
    signedInAs: props.signedInAs ?? null,
    sentence: (noun) => welcomeSentence(noun, !unavailable),
  };
}

export function shareMacLink(url: string): void {
  void Share.share({ message: url, url }).catch(() => undefined);
}
