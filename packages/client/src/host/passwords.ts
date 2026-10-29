import type { Request } from "@opensteer/core";
import {
  PasswordSignInRequestResponseSchema,
  type PasswordSignInFailureReason,
  type PasswordSignInRequestResponse,
} from "@opensteer/protocol";
import {
  AgentBrowserSignInResultSchema,
  type AgentBrowserSignInResult,
  type BrowserSignInUnavailableReason,
} from "@opensteer/protocol/browser-sources";
import type { DesktopPasswordsStatus } from "@opensteer/protocol/desktop";
import type { PasswordsBrokerAccount } from "@opensteer/protocol/passwords-broker";
import { browserSignInProblemCopy, browserSiteLabel } from "./browser-sign-in.js";
import { fullAccessOnThisMac } from "./macos-permissions.js";

/**
 * Words and small decisions every client shares for saved-password sign-ins,
 * so the web, desktop and phone say the same thing about the same Request.
 * The card on the Mac named in the Request approves one; any device may
 * decline it.
 */

/** The Mac's own window, named the way the Mac names it. */
export const passwordsAppName = "Opensteer Passwords";

/**
 * Whether the reader is at the Mac a sign-in Request names. Only the desktop
 * app can reach that Mac's Passwords, so a browser tab on that very Mac is
 * elsewhere too; the rule is otherwise the one Full Disk Access uses.
 */
export function passwordsHere(input: {
  readonly hostsDeploymentOnThisComputer: boolean;
  readonly inDesktopApp: boolean;
  /** The Runner this desktop app supervises, when it lends one. */
  readonly localRunnerId: string | null;
  /** Whether the Request's Runner is the Mac this Personal Opensteer runs on. */
  readonly runnerHostsDeployment: boolean;
  /** The Runner the Request names to approve it. */
  readonly runnerId: string;
}): boolean {
  return fullAccessOnThisMac({
    hostsDeployment: input.runnerHostsDeployment,
    hostsDeploymentOnThisComputer: input.hostsDeploymentOnThisComputer,
    inDesktopApp: input.inDesktopApp,
    lentByThisDesktop: input.localRunnerId !== null && input.localRunnerId === input.runnerId,
  });
}

/* ------------------------------------------------------------------------- *
 * The sign-in card
 * ------------------------------------------------------------------------- */

/** Where the sign-in waits, for a reader on any other device. */
export function passwordSignInWaitingOn(computerName: string): string {
  return `Waiting for you on ${computerName}`;
}

/** The promise every sign-in card makes, word for word the same everywhere. */
export function passwordSignInPrivacy(site: string, permissionVersion?: 5): string {
  if (permissionVersion === 5)
    return `Agents can type your saved login on ${browserSiteLabel(site)} and in apps they use, like on your phone. Agents never see it, but a tricked agent could reveal it.`;
  return `Opensteer fills your password into ${browserSiteLabel(site)} for them — it never sends it to the agent, but the website page holds it once filled. Sign-ins can stay saved in the browser profile.`;
}

export function passwordSignInConsent(
  workspaceName: string,
  site: string,
  account: string,
  permissionVersion?: 5,
): string {
  if (permissionVersion === 5)
    return `Agents in ${workspaceName} want to use your saved login ${account} for ${browserSiteLabel(site)}. They can type it on this website and in apps they use, like on your phone. Agents never see it, but a tricked agent could reveal it.`;
  return `Let agents in ${workspaceName} sign in to ${browserSiteLabel(site)} as ${account}. ${passwordSignInPrivacy(site)}`;
}

/** The agent wrote the reason, so it is labelled as the agent's and never as Opensteer's. */
export const passwordSignInReasonLabel = "Agent’s reason";
export const passwordSignInAccountLegend = "Sign in as";
export const passwordSignInAllowLabel = "Allow";
export const passwordSignInOnceLabel = "Only this time";
export const passwordSignInDeclineLabel = "Don’t allow";
export const passwordSignInDecliningLabel = "Declining…";
/** While the Mac asks the person to confirm Allow or Only this time. */
export const passwordSignInConfirming = "Confirm with Touch ID or your Mac password.";
/** The Mac no longer runs a sign-in whose Request the Host has not settled yet. */
export const passwordSignInGone = "This sign-in is no longer running on this Mac.";

export function passwordSignInNoAccount(site: string): string {
  return `No saved password for ${browserSiteLabel(site)}.`;
}

/** A saved login the card offers for a site, as the broker sends it: never its password. */
export type PasswordSignInAccount = PasswordsBrokerAccount;

export interface PasswordSignInAccountRow {
  readonly account: PasswordSignInAccount;
  /** What tells this row apart from the rest, or null when nothing needs to. */
  readonly detail: string | null;
}

/** Rows used on one host; `host` is null where it goes without saying. */
export interface PasswordSignInAccountGroup {
  readonly host: string | null;
  readonly rows: readonly PasswordSignInAccountRow[];
}

/**
 * The card's account list. `primary` holds the accounts for the page the
 * agent is on, or every account by host when it is on none of their pages;
 * `others` the site's other hosts, kept behind one disclosure.
 */
export interface PasswordSignInAccountList {
  readonly others: readonly PasswordSignInAccountGroup[];
  readonly primary: readonly PasswordSignInAccountGroup[];
}

export const passwordSignInAccountFilterLabel = "Filter accounts";

/** "Other accounts on amazon.com (7)": the disclosure for the site's other hosts. */
export function passwordSignInOtherAccounts(site: string, count: number): string {
  return `Other accounts on ${browserSiteLabel(site)} (${count})`;
}

export function passwordSignInNoAccountMatch(query: string): string {
  return `No account matches “${query}”`;
}

/**
 * Lays out the broker's accounts, kept in its order, narrowed to those whose
 * username, label or host contains `query`. Each row says only what tells it
 * apart: the person's label, or for the same username on the same host, when
 * each was last updated.
 */
export function passwordSignInAccountList(
  accounts: readonly PasswordSignInAccount[],
  query = "",
): PasswordSignInAccountList {
  const needle = query.trim().toLowerCase();
  const rows = accounts
    .map((account) => ({ account, detail: accountDetail(account, accounts) }))
    .filter(
      ({ account }) =>
        needle === "" ||
        [account.username, account.label ?? "", account.host].some((field) =>
          field.toLowerCase().includes(needle),
        ),
    );
  const onPage = rows.filter(({ account }) => account.onPage);
  const offPage = rows.filter(({ account }) => !account.onPage);
  if (accounts.some(({ onPage: covers }) => covers)) {
    return {
      others: byHost(offPage, true),
      primary: onPage.length === 0 ? [] : [{ host: null, rows: onPage }],
    };
  }
  // Headings follow every account, not the filtered few, so they hold still while the person types.
  return {
    others: [],
    primary: byHost(offPage, new Set(accounts.map(({ host }) => host)).size > 1),
  };
}

function byHost(
  rows: readonly PasswordSignInAccountRow[],
  named: boolean,
): PasswordSignInAccountGroup[] {
  const groups = new Map<string, PasswordSignInAccountRow[]>();
  for (const row of rows) {
    const group = groups.get(row.account.host);
    if (group) group.push(row);
    else groups.set(row.account.host, [row]);
  }
  return [...groups].map(([host, grouped]) => ({ host: named ? host : null, rows: grouped }));
}

function accountDetail(
  account: PasswordSignInAccount,
  accounts: readonly PasswordSignInAccount[],
): string | null {
  const twins = accounts.filter(
    (other) =>
      other.id !== account.id &&
      other.host === account.host &&
      other.username.toLowerCase() === account.username.toLowerCase(),
  );
  if (twins.every((twin) => twin.label !== account.label)) return account.label;
  // Two of them updated the same month: the whole set says the day instead.
  const months = [account, ...twins].map(({ updatedAt }) => accountUpdated(updatedAt, false));
  const exact = new Set(months).size < months.length;
  const updated = `Updated ${accountUpdated(account.updatedAt, exact)}`;
  return account.label ? `${account.label} · ${updated}` : updated;
}

function accountUpdated(updatedAt: string, day: boolean): string {
  return new Intl.DateTimeFormat(
    "en-US",
    day ? { day: "numeric", month: "short", year: "numeric" } : { month: "short", year: "numeric" },
  ).format(new Date(updatedAt));
}

/** What Allow keeps that Only this time does not, once an account is chosen. */
export function passwordSignInAllowRemembers(workspaceName: string, username: string): string {
  return `Allow lets agents in ${workspaceName} sign in as ${username} from now on.`;
}

/** "Expires in 14 minutes", or "Expired" once the deadline has passed. */
export function passwordSignInExpiry(expiresAt: string, now: Date = new Date()): string {
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return "Expired";
  if (remaining < 60_000) return "Expires in less than a minute";
  const minutes = Math.ceil(remaining / 60_000);
  return `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------------- *
 * How a sign-in ended
 * ------------------------------------------------------------------------- */

/** Why a sign-in did not happen, in one line. */
export function passwordSignInFailureMessage(
  reason: PasswordSignInFailureReason,
  domain: string,
): string {
  switch (reason) {
    case "needs-sign-in-page":
      return `Open the sign-in page on ${domain}, then try again`;
    case "wrong-password":
      return `${domain} didn’t accept the saved password`;
    case "unsupported-page":
      return `Opensteer couldn’t find where to sign in on ${domain}`;
    case "blocked-destination":
      return "The page tried to reach a blocked address, so nothing was handed to the agent";
    case "cleanup-failed":
      return "The private sign-in couldn’t be cleared, so nothing was handed to the agent";
    case "busy":
      return "Too many sign-ins at once";
    case "needs-fresh-session":
      return "This needs a new browser session. Ask your agent to open one and try again";
  }
}

/** What a fulfilled sign-in Request came to. */
export function passwordSignInResponseMessage(
  response: PasswordSignInRequestResponse,
  input: { readonly computerName?: string; readonly site: string },
): string {
  const domain = browserSiteLabel(input.site);
  const onComputer = input.computerName ? ` on ${input.computerName}` : "";
  switch (response.outcome) {
    case "authorized":
      return `Allowed agents to sign in to ${domain} as ${response.account}`;
    case "signed-in":
      return response.method === "saved-password"
        ? `Signed in to ${domain}`
        : `You signed in to ${domain}`;
    case "expired":
      return "This sign-in timed out";
    case "failed":
      return passwordSignInFailureMessage(response.reason, domain);
    case "unavailable":
      switch (response.reason) {
        case "no-saved-login":
          return `No saved login for ${domain}`;
        case "passwords-off":
          return `Agent sign-ins are off${onComputer}`;
        case "not-set-up":
          return `Passwords isn’t set up${onComputer}`;
        case "not-responding":
          return `Passwords didn’t respond${onComputer}`;
      }
    case "outcome-unknown":
      return "Opensteer couldn’t confirm the sign-in";
    case "session-closed":
      return "The agent’s browser closed";
    case "interrupted":
      return `The sign-in stopped${onComputer}`;
  }
}

export interface PasswordSignInOutcome {
  readonly signedIn: boolean;
  readonly text: string;
}

/**
 * How a declined or fulfilled sign-in ended, or null while it waits. A
 * response this client cannot read is never reported as a sign-in.
 */
export function passwordSignInOutcome(request: Request): PasswordSignInOutcome | null {
  if (request.status === "pending") return null;
  if (request.status === "declined") return { signedIn: false, text: "Not allowed" };
  if (request.status !== "fulfilled" || request.payload.kind !== "browser.password-sign-in") {
    return { signedIn: false, text: "No longer waiting" };
  }
  const response = PasswordSignInRequestResponseSchema.safeParse(
    request.response?.kind === "external" ? request.response.value : null,
  );
  if (!response.success) return { signedIn: false, text: "Answered" };
  return {
    signedIn: response.data.outcome === "signed-in" || response.data.outcome === "authorized",
    text: passwordSignInResponseMessage(response.data, request.payload),
  };
}

/** The transcript's line for a settled sign-in: the card's own words. */
export function passwordSignInReceipt(request: Request): string {
  return passwordSignInOutcome(request)?.text ?? "Pending";
}

/* ------------------------------------------------------------------------- *
 * A `sign_in` step in the transcript
 * ------------------------------------------------------------------------- */

/**
 * The result `sign_in` returned, read from the text every engine
 * records for it, or null when this client cannot read it.
 */
export function readBrowserSignInResult(text: string): AgentBrowserSignInResult | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = AgentBrowserSignInResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface BrowserSignInStep {
  readonly hint: string;
  readonly label: string;
  /** Whether it signed in; null while the sign-in is still on its way. */
  readonly signedIn: boolean | null;
}

/**
 * What one `sign_in` call came to, in the words its Request card and
 * receipt use. `requestedSite` is the site the call asked for, which names the
 * results that carry none.
 */
export function browserSignInStep(
  result: AgentBrowserSignInResult,
  requestedSite: string | null,
): BrowserSignInStep {
  const site = "site" in result ? result.site : requestedSite;
  const domain = site === null ? "the site" : browserSiteLabel(site);
  const failed = (hint: string): BrowserSignInStep => ({
    hint,
    label: `Couldn’t sign in to ${domain}`,
    signedIn: false,
  });
  switch (result.status) {
    case "applied":
      return {
        hint:
          result.profileName === null
            ? `From ${result.sourceName}`
            : `From ${result.sourceName} · saved to ${result.profileName}`,
        label: `Signed in to ${domain}`,
        signedIn: true,
      };
    case "ready":
      return {
        hint: `As ${result.account}`,
        label: `Ready to sign in to ${domain}`,
        signedIn: null,
      };
    case "signed-in":
      return result.method === "saved-password"
        ? { hint: "With your saved password", label: `Signed in to ${domain}`, signedIn: true }
        : { hint: "", label: `You signed in to ${domain}`, signedIn: true };
    case "failed":
      return failed(passwordSignInFailureMessage(result.reason, domain));
    case "needs-code":
      return { hint: "", label: `${domain} sent a code; the agent is getting it`, signedIn: null };
    case "pending":
      return {
        hint: "Waiting for you",
        label:
          result.waitingFor === "person" || result.waitingFor === "code"
            ? `${domain} needs you to finish signing in`
            : `Asked you to sign in to ${domain}`,
        signedIn: null,
      };
    case "declined":
      return { hint: "", label: "Not allowed", signedIn: false };
    case "resolved":
      return { hint: "Already answered", label: `Asked to sign in to ${domain}`, signedIn: null };
    case "not-signed-in":
      return failed(`Chrome isn’t signed in to ${domain}`);
    case "unavailable":
      return failed(browserSignInUnavailableMessage(result.reason, result.site));
  }
}

function browserSignInUnavailableMessage(
  reason: BrowserSignInUnavailableReason,
  site: string,
): string {
  switch (reason) {
    case "no-saved-login":
      return `No saved login for ${browserSiteLabel(site)}. Save one in Opensteer Passwords or sign in in the browser tab`;
    case "needs-approval":
      return "A task or automation can’t ask you to allow a sign-in";
    case "rate-limited":
      return "Too many sign-in attempts for now";
    case "needs-fresh-session":
      return passwordSignInFailureMessage(reason, browserSiteLabel(site));
    case "no-code-expected":
      return "No sign-in was waiting for a code";
    case "passwords-off":
      return passwordSignInResponseMessage(
        { outcome: "unavailable", reason: "passwords-off" },
        { site },
      );
    case "passwords-not-set-up":
      return passwordSignInResponseMessage(
        { outcome: "unavailable", reason: "not-set-up" },
        { site, computerName: "your Passwords Mac" },
      );
    case "passwords-not-responding":
      return passwordSignInResponseMessage(
        { outcome: "unavailable", reason: "not-responding" },
        { site },
      );
    case "expired":
      return passwordSignInResponseMessage({ outcome: "expired" }, { site });
    case "interrupted":
    case "stopped":
      return passwordSignInResponseMessage({ outcome: "interrupted" }, { site });
    case "busy":
      return "Another agent is waiting for you to sign in to this site. Try again later";
    case "chrome-blocked":
    case "limit":
    case "unsupported":
    case "too-large":
    case "session-closed":
    case "runtime-outdated":
    case "not-allowed":
      return browserSignInProblemCopy(reason, { context: "request", site, sourceName: null }).title;
  }
}

/* ------------------------------------------------------------------------- *
 * Settings
 * ------------------------------------------------------------------------- */

export const passwordsSettingsLabel = "Passwords";
export const passwordsSettingsDescription = "Saved passwords agents can sign in with";

const unsupportedMessages = {
  hardware:
    "This Mac can’t keep Opensteer Passwords. It needs Touch ID–class security hardware (Apple silicon, or an Intel Mac with a T2 chip).",
  os: "Opensteer Passwords doesn’t work on this version of macOS yet.",
  platform: "Passwords is available in the Opensteer app on a Mac.",
} as const;

export const passwordsSetUpLead =
  "Let agents sign in to websites and apps with passwords saved on this Mac. Opensteer never sends your password to the agent; it types it into the website or app, which can read it. You allow an account with Touch ID or your Mac password.";
export const passwordsSetUpFacts = [
  "Import from Chrome, Safari, Firefox, 1Password or Bitwarden.",
  "Opensteer fills the fields the agent focuses on, in the browser, on your phone or in Mac apps.",
  "In the browser, each password goes only to its own website. In apps, the agent checks it’s the real app.",
] as const;
/** What the setup says plainly, apart from what Passwords does for you. */
export const passwordsSetUpNote =
  "Passwords are kept only on this Mac and aren’t backed up. If this Mac is lost or erased, ones saved only here are gone.";
export const passwordsSetUpAction = "Set up Passwords";
export const passwordsOpenAction = "Open Passwords";
export const passwordsAgentSignInsLabel = "Agents can sign in with your passwords";
export const passwordsAgentSignInsDetail = "Turn this off or on in the Passwords window.";
export const passwordsWaitingLabel = "Waiting for you";
export const passwordsDeclineAllAction = "Don’t allow all";
export const passwordsDecliningAllAction = "Not allowing…";
export const passwordsSavedLabel = "Your saved passwords";
export const passwordsSavedDetail =
  "Add, import or remove them, and see which Workspaces may use each, in the Passwords window.";
export const passwordsHowItWorksLabel = "How it works";

/** "2 sign-ins to answer in their conversations": the sign-in cards waiting in the chat. */
export function passwordsWaitingDetail(count: number): string {
  return count === 1
    ? "1 sign-in to answer in its conversation"
    : `${count} sign-ins to answer in their conversations`;
}
export const passwordsHowItWorks = [
  "You allow an account once per Workspace with Touch ID or your Mac password. After that, agents there sign in with it on their own.",
  "Take that access away any time in the Passwords window.",
  "Sign-ins can stay saved in the browser profile.",
  "Sites you allowed from Chrome keep using Chrome.",
] as const;
export const passwordsNeedsReset =
  "Set up Opensteer Passwords again. The passwords saved here before can’t be opened on this Mac.";
export const passwordsDevelopmentBanner = "Development build: use test passwords only.";

/** What Settings shows on the Mac itself, read from what the Mac reports. */
export type PasswordsSettingsState =
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly development: boolean; readonly kind: "needs-reset" | "not-set-up" }
  | {
      readonly agentSignIns: "off" | "on";
      readonly development: boolean;
      readonly kind: "ready";
    };

export function passwordsSettingsState(status: DesktopPasswordsStatus): PasswordsSettingsState {
  switch (status.availability) {
    case "unsupported":
      return { kind: "unsupported", message: unsupportedMessages[status.reason] };
    case "unavailable":
      return { kind: "unavailable", message: status.message };
    case "available": {
      const { broker, development } = status;
      switch (broker.vault) {
        // The broker found no Secure Enclave on this Mac.
        case "unsupported":
          return { kind: "unsupported", message: unsupportedMessages.hardware };
        case "ready":
          return { agentSignIns: broker.agentSignIns, development, kind: "ready" };
        case "needs-reset":
        case "not-set-up":
          return { development, kind: broker.vault };
      }
    }
  }
}

/**
 * Passwords seen from anywhere but the Mac that keeps them: a browser, a
 * phone, or the desktop app on another computer. Only a Personal Opensteer has
 * a Mac to keep them on.
 */
export function passwordsElsewhere(input: {
  readonly homeName: string;
  readonly personal: boolean;
}): string {
  return input.personal
    ? `Passwords are kept in the Opensteer app on ${input.homeName}. Set them up and manage them there.`
    : "Saved-password sign-ins are available on a Personal Opensteer for now.";
}

/** The line under Passwords in a list of settings. */
export function passwordsSettingsSubtitle(input: {
  readonly homeName: string;
  readonly personal: boolean;
}): string {
  return input.personal ? `Kept on ${input.homeName}` : "Not available on this Opensteer";
}
