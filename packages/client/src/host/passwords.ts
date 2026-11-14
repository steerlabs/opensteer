import { cardUseOutcome } from "./cards.js";
import { requestSettlementLabel } from "./request-settlement.js";
import { toolOutputRecord, type Request } from "@opensteer/core";
import {
  PasswordSignInRequestResponseSchema,
  SavedLoginResultSchema,
  type PasswordsNeed,
  type PasswordSignInRequestResponse,
  type SavedLoginResult,
  type SavedLoginUnavailableReason,
} from "@opensteer/protocol";
import {
  ChromeCookiesResultSchema,
  type ChromeCookiesResult,
  type ChromeCookiesUnavailableReason,
} from "@opensteer/protocol/browser-sources";
import type { DesktopPasswordsStatus } from "@opensteer/protocol/desktop";
import type { PasswordsBrokerAccount } from "@opensteer/protocol/passwords-broker";
import { browserSignInProblemCopy, browserSiteLabel } from "./browser-sign-in.js";

/** Shared copy for requester consent from any signed-in device. */

/** The Mac's own vault-management window. */
export const passwordsAppName = "Opensteer Passwords";

/* ------------------------------------------------------------------------- *
 * The sign-in card
 * ------------------------------------------------------------------------- */

/** The promise every sign-in card makes, word for word the same everywhere. */
export function passwordSignInPrivacy(site: string): string {
  return `Your agents can type your saved login on ${browserSiteLabel(site)} and in apps they use, like on your phone. Agents never see it, but a tricked agent could reveal it.`;
}
export function passwordSignInConsent(site: string, account: string): string {
  return `Let your agents sign in to ${browserSiteLabel(site)} as ${account}. ${passwordSignInPrivacy(site)}`;
}

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
export function passwordSignInAllowRemembers(username: string): string {
  return `Allow lets your agents sign in as ${username} from now on.`;
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
    case "expired":
      return "This sign-in timed out";
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
  if (request.payload.kind === "browser.password-sign-in" && request.payload.credential === "card")
    return cardUseOutcome(request);
  if (request.status === "pending") return null;
  if (request.status === "declined")
    return {
      signedIn: false,
      text:
        "Not allowed" +
        (requestSettlementLabel(request) ? ` · ${requestSettlementLabel(request)}` : ""),
    };
  if (request.status !== "fulfilled" || request.payload.kind !== "browser.password-sign-in") {
    return { signedIn: false, text: "No longer waiting" };
  }
  const response = PasswordSignInRequestResponseSchema.safeParse(
    request.response?.kind === "external" ? request.response.value : null,
  );
  if (!response.success) return { signedIn: false, text: "Answered" };
  return {
    signedIn: response.data.outcome === "authorized",
    text:
      passwordSignInResponseMessage(response.data, request.payload) +
      (requestSettlementLabel(request) ? ` · ${requestSettlementLabel(request)}` : ""),
  };
}

/** The transcript's line for a settled sign-in: the card's own words. */
export function passwordSignInReceipt(request: Request): string {
  return passwordSignInOutcome(request)?.text ?? "Pending";
}

/* ------------------------------------------------------------------------- *
 * Sign-in steps in the transcript
 * ------------------------------------------------------------------------- */

/** What `use_saved_login` returned, read from the text every engine records, or null. */
export function readSavedLoginResult(text: string): SavedLoginResult | null {
  const parsed = SavedLoginResultSchema.safeParse(toolOutputRecord(text));
  return parsed.success ? parsed.data : null;
}

/** What `copy_chrome_cookies` returned, read from the text every engine records, or null. */
export function readChromeCookiesResult(text: string): ChromeCookiesResult | null {
  const parsed = ChromeCookiesResultSchema.safeParse(toolOutputRecord(text));
  return parsed.success ? parsed.data : null;
}

export interface SignInStep {
  readonly hint: string;
  readonly label: string;
  /** Whether the step did what it asked; null while it is still on its way. */
  readonly succeeded: boolean | null;
}

const notAllowed: SignInStep = { hint: "", label: "Not allowed", succeeded: false };

/** What one `use_saved_login` call came to, in the words its Request card uses. */
export function savedLoginStep(result: SavedLoginResult): SignInStep {
  const domain = browserSiteLabel(result.site);
  switch (result.status) {
    case "ready":
      return {
        hint: `As ${result.account}`,
        label: `Ready to sign in to ${domain}`,
        succeeded: true,
      };
    case "pending":
      return {
        hint: "Waiting for you",
        label: `Asked to use your saved login for ${domain}`,
        succeeded: null,
      };
    case "declined":
      return notAllowed;
    case "unavailable":
      return {
        hint: savedLoginUnavailableMessage(result.reason, result.site),
        label: `Couldn’t use a saved login for ${domain}`,
        succeeded: false,
      };
  }
}

/** What one `copy_chrome_cookies` call came to. */
export function chromeCookiesStep(result: ChromeCookiesResult): SignInStep {
  const domain = browserSiteLabel(result.site);
  switch (result.status) {
    case "copied":
      return {
        hint:
          result.profileName === null
            ? `From ${result.sourceName}`
            : `From ${result.sourceName} · saved to ${result.profileName}`,
        label: `Copied your Chrome sign-in for ${domain}`,
        succeeded: true,
      };
    case "pending":
      return {
        hint: "Waiting for you",
        label: `Asked to copy your Chrome sign-in for ${domain}`,
        succeeded: null,
      };
    case "declined":
      return notAllowed;
    case "unavailable":
      return {
        hint: chromeCookiesUnavailableMessage(result.reason, result.site),
        label: `Couldn’t copy your Chrome sign-in for ${domain}`,
        succeeded: false,
      };
  }
}

function savedLoginUnavailableMessage(reason: SavedLoginUnavailableReason, site: string): string {
  switch (reason) {
    case "no-saved-login":
      return `No saved login for ${browserSiteLabel(site)}`;
    case "needs-approval":
      return "A task or automation can’t ask you to allow a sign-in";
    case "rate-limited":
      return "Too many sign-in attempts for now";
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
      return "Another agent is waiting for you to allow this site. Try again later";
    case "main-browser-required":
      return "Saved logins fill only in the browser on the computer that runs Opensteer";
    case "unsupported":
    case "session-closed":
    case "runtime-outdated":
    case "not-allowed":
      return browserSignInProblemCopy(reason, { context: "request", site, sourceName: null }).title;
  }
}

function chromeCookiesUnavailableMessage(
  reason: ChromeCookiesUnavailableReason,
  site: string,
): string {
  switch (reason) {
    case "chrome-signed-out":
      return `Chrome isn’t signed in to ${browserSiteLabel(site)}`;
    case "needs-approval":
      return "A task or automation can’t ask you to allow a sign-in";
    case "rate-limited":
      return "Too many sign-in attempts for now";
    default:
      return browserSignInProblemCopy(reason, { context: "request", site, sourceName: null }).title;
  }
}

/* ------------------------------------------------------------------------- *
 * Settings
 * ------------------------------------------------------------------------- */

export const passwordsSettingsLabel = "Passwords";
export const passwordsSettingsDescription = "Saved passwords and cards agents can use";

const unsupportedMessages = {
  hardware:
    "This Mac can’t keep Opensteer Passwords. It needs Touch ID–class security hardware (Apple silicon, or an Intel Mac with a T2 chip).",
  os: "Opensteer Passwords doesn’t work on this version of macOS yet.",
  platform: "Passwords is available in the Opensteer app on a Mac.",
} as const;

export const passwordsSetUpLead = "Let agents sign in for you with passwords saved on this Mac.";
export const passwordsSetUpFacts = [
  "Opensteer never sends your password to the agent; it types it into the website or app, which can read it.",
  "You allow an account from any device signed in to this Opensteer.",
  "Passwords are kept only on this Mac and aren’t backed up. If this Mac is lost or erased, ones saved only here are gone.",
  "In the browser, each password goes only to its own website. In apps, the agent checks it’s the real app.",
] as const;
export const passwordsSetUpAction = "Set up Passwords";
export const passwordsOpenAction = "Open Passwords";
export const passwordsAgentSignInsLabel = "Agents can use saved passwords and cards";
export const passwordsAgentSignInsDetail = "Turn this off or on in the Passwords window.";
/** The Passwords window's switch for filling a person's own sign-ins; pinned by CopyParityTests. */
export const passwordsPersonFillLabel = "Fill passwords for me in Opensteer";
export const passwordsPersonFillWindowDetail =
  "Offers your saved logins when you click a sign-in field in Opensteer’s browser, on this Mac or another device.";
/** The Passwords window's switch for offering to save a person's own sign-ins; pinned by CopyParityTests. */
export const passwordsPersonSaveLabel = "Offer to save passwords in Opensteer";
export const passwordsPersonSaveWindowDetail =
  "After you sign in by hand in Opensteer’s browser, on this Mac or another device, asks to keep that login on this Mac.";
export const passwordsWaitingLabel = "Waiting for you";
export const passwordsDeclineAllAction = "Don’t allow all";
export const passwordsDecliningAllAction = "Not allowing…";
export const passwordsSavedLabel = "Your saved passwords and cards";
export const passwordsSavedDetail =
  "Manage passwords and cards in the Passwords window. Import is for passwords only.";
export const passwordsHowItWorksLabel = "How it works";

/** "2 sign-ins to answer in their conversations": the sign-in cards waiting in the chat. */
export function passwordsWaitingDetail(count: number): string {
  return count === 1
    ? "1 password or card request to answer in its conversation"
    : `${count} password or card requests to answer in their conversations`;
}
export const passwordsCardsFact =
  "Cards work on websites only. Every use needs a fresh approval, lasting up to 30 minutes; it does not approve a charge.";
export const passwordsHowItWorks = [
  "You allow an account from any device signed in to this Opensteer. Your agents can then use it for your tasks.",
  "Take that access away any time in the Passwords window.",
  "Sign-ins can stay saved in the browser profile.",
  passwordsCardsFact,
] as const;
export const passwordsNeedsReset =
  "Set up Opensteer Passwords again. The passwords saved here before can’t be opened on this Mac.";
export const passwordsDevelopmentBanner = "Development build: use test passwords only.";

/** The offer's words, with the one name the reader's eye should land on set apart. */
export interface PasswordsOfferLine {
  readonly after: string;
  readonly before: string;
  readonly name: string;
}

/**
 * The line that offers Passwords after a sign-in found it lacking. `computer`
 * is null on the Mac itself, where the line's button is the way there. Nothing
 * asks the person to tell the agent: the Host does that when the login exists.
 */
export function passwordsOfferLine(input: {
  readonly card: boolean;
  readonly computer: string | null;
  readonly need: PasswordsNeed;
  readonly site: string;
}): PasswordsOfferLine {
  const { computer } = input;
  // A card has no wake: nothing watches for one, so the person still asks again.
  if (input.card) {
    return {
      after:
        computer === null
          ? " Add a card and enable agent use, then ask the agent again."
          : ` lets agents fill saved cards at checkout. Open Passwords on ${computer} and add a card.`,
      before: "",
      name: passwordsAppName,
    };
  }
  const there = computer === null ? "" : ` on ${computer}`;
  switch (input.need) {
    case "not-set-up":
      return {
        after: ` lets agents sign in for you.${computer === null ? "" : ` Set it up${there}.`}`,
        before: "",
        name: passwordsAppName,
      };
    case "no-login":
      return { after: ` login${there}.`, before: "Add your ", name: browserSiteLabel(input.site) };
    case "off":
      return { after: ` are off${there}.`, before: "", name: "Agent sign-ins" };
  }
}

/** The offer as this Mac sees it now, newer than the agent's word, or null when it can't help. */
export function passwordsOfferNeedHere(
  state: PasswordsSettingsState["kind"] | null,
  agentSignIns: "on" | "off" | null,
): PasswordsNeed | null {
  if (state === "not-set-up") return "not-set-up";
  if (state !== "ready") return null;
  return agentSignIns === "off" ? "off" : "no-login";
}

export const passwordsSuggestionAction = "Set up";
/** Dismissed with the usage notices: one small per-device list, one line of it per Deployment. */
export function passwordsSuggestionKey(deploymentId: string, userId: string): string {
  return `passwords-suggestion:${deploymentId}:${userId}`;
}

/** What Settings shows on the Mac itself, read from what the Mac reports. */
export type PasswordsSettingsState =
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly development: boolean; readonly kind: "needs-reset" | "not-set-up" }
  | {
      readonly agentSignIns: "off" | "on";
      /** Null when this Mac's Passwords predates filling for people. */
      readonly personFill: "off" | "on" | null;
      /** Null when this Mac's Passwords predates saving for people. */
      readonly personSave: "off" | "on" | null;
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
          return {
            agentSignIns: broker.agentSignIns,
            personFill: broker.personFill ?? null,
            personSave: broker.personSave ?? null,
            development,
            kind: "ready",
          };
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
