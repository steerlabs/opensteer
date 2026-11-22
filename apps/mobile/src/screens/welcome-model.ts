import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { Share } from "react-native";
import { accountDoorPresentation } from "./account-door.js";
import { phoneShowsCloudComputerPrice } from "./cloud-computer-entry.js";

export interface WelcomeProps {
  readonly account: DesktopAccountAuthState["account"];
  readonly signedInAs?: string | null;
  readonly failure: string | null;
  readonly onAccount: () => void;
  readonly onAddress: () => void;
  readonly onScan: () => void;
  readonly portalOrigin: string | null;
  readonly signingIn: boolean;
  /** Where a Cloud Computer is set up on the Opensteer website, shown as text to copy. */
  readonly cloudAddress?: string | null;
  /** The price checkout sells now; shown only where `phoneShowsCloudComputerPrice` allows. */
  readonly cloudPrice?: string | null;
  readonly cloudCopied?: boolean;
  readonly onCopyCloudAddress?: (address: string) => void;
}

export const welcomeCopy = {
  address: "Enter an address",
  addressDetail: "For Tailscale or your own server.",
  failureTitle: "Opensteer sign-in did not finish",
  mac: "Send me the Mac link",
  otherWays: "Other ways in",
  scan: "Scan a code",
  scanDetail: "From Opensteer on your Mac, for a private network.",
  title: "Open your Opensteer",
  where: "Where should your Opensteer live?",
  whereLead: "Your browser profiles, apps, plugins, tasks and rules live in one Home.",
  onMac: "On your Mac",
  onMacDetail: "Free. Works while your Mac is awake.",
  onCloud: "On an Opensteer Cloud Computer",
  onCloudDetail: "Always on. Set it up on the Opensteer website, then come back here.",
  cloudAddress: "Opensteer website",
  copy: "Copy",
  copied: "Copied",
  waiting: "Your Opensteer appears here as soon as it’s ready.",
} as const;

/** What a build with no Opensteer account to sign in to has always said, word for word. */
export const keylessWelcomeCopy = {
  address: "Enter address",
  footer: "Use an address for Tailscale or your own server.",
  scan: "Scan QR Code",
} as const;

/**
 * What the first screen says Opensteer is: it runs on a Mac or on a Cloud Computer, and the
 * Opensteer account finds either. A build with no account to sign in to has only the Mac.
 * It never offers to buy anything.
 */
export function welcomeSentence(noun: string, account = true): string {
  return account
    ? `Sign in with your Opensteer account, and this ${noun} will find your Opensteer, on your Mac or on a Cloud Computer.`
    : `Install it on your Mac, and this ${noun} will find it.`;
}

export type WelcomeMode =
  /** A build with no Opensteer account: the Mac link, a code to scan and an address, as always. */
  | "keyless"
  /** Signed out: the account is the front door, and the other ways in are one small link. */
  | "door"
  /** Signed in, and the account has no Opensteer yet: where should it live? */
  | "where";

/** What the first run shows, shared by the iOS form and the Android screen. */
export function welcomePresentation(props: WelcomeProps): {
  readonly mode: WelcomeMode;
  readonly title: string;
  /** The Account door, on the door only. */
  readonly account: { readonly disabled: boolean; readonly label: string } | null;
  readonly failure: string | null;
  /** Under the other ways in: what they are for (keyless), or when the Opensteer appears (where). */
  readonly footer: string | null;
  readonly macLink: string | null;
  readonly signedInAs: string | null;
  /** What the first screen says, with the account in it while there is one to sign in to. */
  readonly sentence: (noun: string) => string;
  /** A Cloud Computer, on "where": what it is, and the website's address as text to copy. */
  readonly cloud: {
    readonly detail: string;
    readonly price: string | null;
    readonly address: string | null;
  } | null;
} {
  const door = accountDoorPresentation(props.account, props.signingIn);
  const unavailable = !props.account.available;
  const signedIn = props.signedInAs != null;
  const mode: WelcomeMode = unavailable ? "keyless" : signedIn ? "where" : "door";
  return {
    mode,
    title: mode === "where" ? welcomeCopy.where : welcomeCopy.title,
    account: mode === "door" ? { disabled: door.disabled, label: door.title } : null,
    failure:
      props.failure ??
      ((props.account.status === "error" || unavailable) && props.account.detail !== null
        ? door.description
        : null),
    footer:
      mode === "keyless"
        ? keylessWelcomeCopy.footer
        : mode === "where"
          ? welcomeCopy.waiting
          : null,
    macLink: mode !== "door" && props.portalOrigin ? `${props.portalOrigin}/mac` : null,
    signedInAs: props.signedInAs ?? null,
    sentence: (noun) =>
      mode === "where" ? welcomeCopy.whereLead : welcomeSentence(noun, !unavailable),
    cloud:
      mode === "where"
        ? {
            detail: welcomeCopy.onCloudDetail,
            // The phone never shows a price unless the stores' rules are known to allow it.
            price: phoneShowsCloudComputerPrice ? (props.cloudPrice ?? null) : null,
            address: props.cloudAddress ?? null,
          }
        : null,
  };
}

export function shareMacLink(url: string): void {
  void Share.share({ message: url, url }).catch(() => undefined);
}
