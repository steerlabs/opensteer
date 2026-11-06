import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { Share } from "react-native";
import { accountDoorPresentation } from "./account-door.js";

export interface WelcomeProps {
  readonly account: DesktopAccountAuthState["account"];
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
  mac: "Get Opensteer for Mac",
  otherWays: "Other ways to connect",
  scan: "Scan QR Code",
  sentence: "Open Opensteer on your Mac and choose Connect your phone. Then scan the code.",
  title: "Connect your computer",
} as const;

/** What the first run shows, shared by the iOS form and the Android screen. */
export function welcomePresentation(props: WelcomeProps): {
  /** The Account door, absent from a build with no Account to sign in to. */
  readonly account: { readonly disabled: boolean; readonly label: string } | null;
  readonly failure: string | null;
  readonly footer: string;
  readonly macLink: string | null;
} {
  const door = accountDoorPresentation(props.account, props.signingIn);
  const unavailable = !props.account.available;
  return {
    account: unavailable ? null : { disabled: door.disabled, label: door.title },
    failure:
      props.failure ??
      ((props.account.status === "error" || unavailable) && props.account.detail !== null
        ? door.description
        : null),
    footer: unavailable
      ? "Use an address for Tailscale or your own server."
      : "Sign in if your Mac uses Opensteer Connect. Use an address for Tailscale or your own server.",
    macLink: props.portalOrigin ? `${props.portalOrigin}/mac` : null,
  };
}

export function shareMacLink(url: string): void {
  void Share.share({ message: url, url }).catch(() => undefined);
}
