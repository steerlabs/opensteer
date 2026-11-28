import type { CloudComputerPreparationStep, CloudComputerReasonCode } from "./cloud-computers.js";

/**
 * Every word the Opensteer Cloud Computer screens show, by stable id. Web, desktop, phone
 * and the Opensteer website all read these, so they say the same thing; this module is the
 * source, kept here so both the apps and the Account service can import it.
 * `{name}` marks a value filled in by `cloudWords`. A price is never written here: it
 * comes from the plan the Account returns.
 */
export const cloudComputerCopy = {
  "cloud.title": "Opensteer Cloud Computer",
  "cloud.shortTitle": "Cloud Computer",
  "cloud.lead": "Your Opensteer, always on in the cloud.",
  "cloud.point.awake.title": "Works while your Mac sleeps",
  "cloud.point.awake.detail": "Agents reach your browser, plugins and tasks any time.",
  "cloud.point.ip.title": "A browser with a steady address",
  "cloud.point.ip.detail": "Sites see the same IP address every day.",
  "cloud.point.backup.title": "Encrypted backups",
  "cloud.point.backup.detail": "Every day, restored the way they were saved.",
  "cloud.point.mac.title": "Your Mac can join it",
  "cloud.point.mac.detail": "Add your Mac as one of its devices, with its own browser and apps.",
  "cloud.price": "{price} a {interval}",
  "cloud.priceOnce": "{price}",
  "cloud.priceDetail": "Opensteer bills you through Stripe. Cancel any time.",
  "cloud.notForSale": "Not available yet",
  "cloud.notForSaleDetail": "Opensteer isn’t setting up new Cloud Computers right now.",
  "cloud.changes.title": "What changes",
  "cloud.changes.detail":
    "It starts as a new Home. Connected agents connect again to its new address. You sign in to your sites again in its browser. Your Mac can be added to it as a device.",
  "cloud.checkout": "Continue to checkout",
  "cloud.checkoutWeb": "Set up on the web",
  "cloud.checkoutWebDetail":
    "Set up your Cloud Computer on the Opensteer website, then come back here. This page updates by itself.",
  "cloud.checkoutWebAddress": "Opensteer website",
  "cloud.checkoutWaiting.title": "Finish checkout in your browser",
  "cloud.checkoutWaiting.detail":
    "This page updates when your Cloud Computer starts setting up. You can close it and come back.",
  "cloud.checkoutAgain": "Open checkout again",
  "cloud.notNow": "Not now",
  "cloud.preparing.title": "Preparing your Cloud Computer",
  "cloud.step.machine": "Setting up your computer",
  "cloud.step.machineDetail": "Usually a few minutes.",
  "cloud.step.ready": "Ready",
  "cloud.preparing.footer": "You can close this. It keeps going, and this page shows where it is.",
  "cloud.failed.title": "Setup didn’t finish",
  "cloud.failed.support": "Contact support",
  "cloud.setup.failed":
    "Opensteer couldn’t finish setting up this Cloud Computer. Contact support.",
  "cloud.setup.notVerified": "Opensteer couldn’t verify this computer. Contact support.",
  "cloud.setup.address": "The Cloud Computer’s address isn’t ready. Try again in a moment.",
  "cloud.setup.link":
    "Opensteer couldn’t link this Cloud Computer to your account. Contact support.",
  "cloud.setup.timeout": "Your Cloud Computer took too long to set up. Contact support.",
  "cloud.ready.title": "Cloud Computer is ready",
  "cloud.ready.open": "Open it",
  "cloud.ready.start": "Start",
  "cloud.ready.reconnect": "Connect your agents again",
  "cloud.ready.thisMac": "Connect this Mac as a device",
  "cloud.ready.thisMacDetail":
    "Your agents can then use this Mac’s browser and apps from the Cloud Computer.",
  "cloud.ready.notListed":
    "It isn’t in your Opensteer list yet. It appears there once your account has set it up for you.",
  "cloud.status.title": "Status",
  "cloud.status.running": "Running",
  "cloud.status.preparing": "Setting up",
  "cloud.status.suspended": "Suspended",
  "cloud.status.attention": "Needs attention",
  "cloud.address": "Address",
  "cloud.copy": "Copy",
  "cloud.copied": "Copied",
  "cloud.ip.title": "Browser IP",
  "cloud.ip.assigned": "Assigned",
  "cloud.ip.assignedDetail": "Sites see one steady address for this computer.",
  "cloud.ip.pending": "Being set up",
  "cloud.ip.pendingDetail": "Browsing waits until its address is ready.",
  "cloud.ip.paused": "Browsing unavailable",
  "cloud.ip.pausedDetail":
    "Its Browser IP isn’t available. Opensteer keeps trying and waits for this IP before loading pages.",
  "cloud.plan.title": "Plan",
  "cloud.plan.manage": "Manage billing",
  "cloud.plan.manageWeb": "Manage billing on the Opensteer website.",
  "cloud.suspend": "Suspend",
  "cloud.suspending": "Suspending…",
  "cloud.suspend.detail": "Agents can’t use it while it’s suspended. Everything on it is kept.",
  "cloud.suspend.title": "Suspend Cloud Computer?",
  "cloud.suspend.body":
    "Running work stops. Connected agents get “not available” until you resume.",
  "cloud.resume": "Resume",
  "cloud.resuming": "Resuming…",
  "cloud.delete": "Delete Cloud Computer",
  "cloud.deleting": "Deleting…",
  "cloud.delete.title": "Delete Cloud Computer?",
  "cloud.delete.body":
    "Its subscription is cancelled, normally within a minute, and won’t renew; the rest of the period already paid isn’t refunded. If Stripe can’t be reached, Opensteer keeps cancelling until Stripe confirms, and if a renewal is charged in that time, Opensteer refunds it. Opensteer destroys the computer and disk, including its browser profiles and tasks, makes its backups unreadable and removes the stored backup data, and deletes the payment details kept with Stripe for its subscription. Stripe keeps its own records of past payments. This can’t be undone.",
  "cloud.delete.billing":
    "Its subscription is cancelled, normally within a minute, and won’t renew; the rest of the period already paid isn’t refunded. If Stripe can’t be reached, Opensteer keeps cancelling until Stripe confirms, and if a renewal is charged in that time, Opensteer refunds it.",
  "cloud.delete.typeToConfirm": "Type delete to confirm",
  "cloud.delete.word": "delete",
  "cloud.delete.confirm": "Delete",
  "cloud.deleted": "Your Cloud Computer was deleted.",
  "cloud.account.signedOut": "Sign in to your Opensteer account to set up a Cloud Computer.",
  "cloud.account.signIn": "Sign in",
  "cloud.account.unreachable": "We couldn’t reach Opensteer. Try again in a moment.",
  "cloud.account.unavailable": "Sign-in isn’t available in this version of Opensteer.",
  "cloud.account.website":
    "Sign in to your Opensteer account on the website to set up and manage your Cloud Computer.",
  "cloud.account.openWebsite": "Open the Opensteer website",
  "cloud.tryAgain": "Try again",
  "cloud.loading": "Loading…",
  "cloud.entry.title": "Opensteer Cloud Computer",
  "cloud.entry.detail": "Keep agents working while your Mac sleeps",
  "cloud.entry.here": "Its status and address",
  "cloud.entry.running": "Running · {address}",
  "cloud.notNowDetail": "This won’t be suggested again for two weeks.",
  "cloud.asleep.link": "Keep agents working while your Mac sleeps",
  "cloud.web.title": "Opensteer Cloud Computer · Opensteer",
  "cloud.web.signIn": "Sign in to continue",
  "cloud.web.useIt": "Open Opensteer on your phone or computer to use it.",
  "cloud.web.checkout.title": "Set up your Cloud Computer",
  "cloud.web.checkout.detail": "You pay on Stripe, then come back here while it’s set up.",
  "cloud.web.checkout.back": "Back",
  "cloud.web.preparing.refresh": "This page checks again by itself every few seconds.",
  "cloud.web.deleted.detail": "You can set up a new Cloud Computer.",
  "cloud.web.checkout.paid": "Payment confirmed.",
  "cloud.deletion.computer": "Computer and disk destroyed",
  "cloud.deletion.backups": "Backups made unreadable",
  "cloud.deletion.storage": "Stored backup data removed",
  "cloud.deletion.done": "{fact} — Done {date}",
  "cloud.deletion.pending": "{fact} — Pending since {date}",
  "cloud.web.unavailable.title": "Cloud Computers aren’t available",
  "cloud.web.unavailable.detail": "This Opensteer account doesn’t offer Cloud Computers yet.",
  "cloud.web.next.unavailable": "Try again later. Nothing was charged.",
  "cloud.web.next.inProgress":
    "Finish the checkout you already started. If you closed it, it expires within a day and you can start again.",
  "cloud.web.next.subscribed": "You already have one. Manage it below.",
  "cloud.web.next.expired": "Start again to get a fresh checkout.",
  "cloud.web.next.other": "Go back to see where your Cloud Computer stands.",
  "cloud.web.manageBilling": "Manage billing on Stripe",
  "cloud.web.noBilling": "There’s no Cloud Computer subscription on this account yet.",
  "cloud.web.typeWord": "Type delete in the box to confirm.",
  "cloud.web.personal": "Your own Cloud Computer",
  "cloud.step.payment": "Payment confirmed",
  "cloud.step.opensteer": "Starting Opensteer",
  "cloud.step.claim": "Linking it to your account",
  "cloud.step.failed": "This step didn’t finish.",
  "cloud.region": "Region",
  "cloud.ip.address": "Browser IP",
  "cloud.renews": "Renews {date}",
  "cloud.backup.reported": "Last backup reported by this Cloud Computer",
  "cloud.reason.already-exists": "You already have a Cloud Computer.",
  "cloud.reason.no-capacity":
    "There’s no room for a new Cloud Computer right now. Nothing was charged.",
  "cloud.reason.sales-not-open": "Cloud Computers aren’t on sale yet.",
  "cloud.reason.checkout-expired": "This checkout expired.",
  "cloud.reason.checkout-complete": "This checkout is already paid.",
  "cloud.reason.checkout-in-progress": "You already started a checkout.",
  "cloud.reason.checkout-unavailable": "Checkout isn’t available right now. Nothing was charged.",
  "cloud.reason.billing-web-only": "Billing is managed on the Opensteer website.",
  "cloud.reason.delete-confirmation-required": "Type delete to confirm.",
  "cloud.reason.not-found": "This Cloud Computer isn’t on your account.",
  "cloud.reason.deleted": "This Cloud Computer was deleted.",
  "cloud.reason.owner-suspended": "You suspended this Cloud Computer.",
  "cloud.reason.deletion-pending": "Deleting. Waiting for Stripe to end the subscription.",
  "cloud.reason.bootstrap-expired": "Setup took too long to finish. Try again or contact support.",
  "cloud.next.already-exists": "You already have one. Manage it below.",
  "cloud.next.no-capacity": "Try again later.",
  "cloud.next.sales-not-open": "Try again later.",
  "cloud.next.checkout-expired": "Start again to get a fresh checkout.",
  "cloud.next.checkout-in-progress":
    "Finish the checkout you already started. If you closed it, it expires within a day and you can start again.",
  "cloud.next.checkout-unavailable": "Try again later.",
  "cloud.next.billing-problem": "Fix the payment in Manage billing. Nothing on it is deleted.",
} as const;

export type CloudComputerCopyId = keyof typeof cloudComputerCopy;

export function cloudWords(
  id: CloudComputerCopyId,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return cloudComputerCopy[id].replace(/\{(\w+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/**
 * A plan's price in its own currency, with its interval: "$20.00 a month". Every
 * surface formats it here, from the plan the Account returns.
 */
export function cloudComputerPriceLine(
  plan: {
    readonly currency: string;
    readonly amountMinor: number;
    readonly interval?: "day" | "week" | "month" | "year" | undefined;
  },
  locale?: string,
): { readonly price: string; readonly line: string } {
  const format = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: plan.currency.toUpperCase(),
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  const price = format.format(plan.amountMinor / 10 ** digits);
  return {
    price,
    line: plan.interval
      ? cloudWords("cloud.price", { price, interval: plan.interval })
      : cloudWords("cloud.priceOnce", { price }),
  };
}

/**
 * The app's own sentence for an Account reason code, or null where the Account's sentence
 * carries details the app doesn't have (an operator's note, a setup error, which billing
 * problem) and must be shown as given.
 */
export function cloudComputerReasonSentence(
  code: CloudComputerReasonCode | undefined,
): string | null {
  if (!code) return null;
  const id = `cloud.reason.${code.replace(/^cloud-computer-/u, "")}`;
  return Object.hasOwn(cloudComputerCopy, id) ? cloudWords(id as CloudComputerCopyId) : null;
}

export function cloudComputerSetupIssue(details: string | null): string {
  switch (details) {
    case "The Cloud Computer reported a different Home identity for this generation.":
      return cloudWords("cloud.setup.notVerified");
    case "The Cloud Computer DNS operation failed.":
      return cloudWords("cloud.setup.address");
    case "Your Cloud Computer couldn’t be set up for your Account. Contact support.":
      return cloudWords("cloud.setup.link");
    case "The Cloud Computer did not become ready before its deadline.":
    case "Your Cloud Computer took too long to set up. Contact support.":
      return cloudWords("cloud.setup.timeout");
    default:
      return cloudWords("cloud.setup.failed");
  }
}

/** What to do next after a refusal with this reason code, when there is one thing to do. */
export function cloudComputerReasonNext(code: CloudComputerReasonCode | undefined): string | null {
  if (!code) return null;
  const id = `cloud.next.${code.replace(/^cloud-computer-/u, "")}`;
  return Object.hasOwn(cloudComputerCopy, id) ? cloudWords(id as CloudComputerCopyId) : null;
}

/** The words for each preparation step the Account reports, in its order. */
export function cloudComputerStepLabel(id: CloudComputerPreparationStep["id"]): string {
  return cloudWords(id === "machine" ? "cloud.step.machine" : `cloud.step.${id}`);
}
