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
  "cloud.point.ip.detail": "Sign in once. Sites see the same IP address every day.",
  "cloud.point.backup.title": "Encrypted backups",
  "cloud.point.backup.detail": "Every day, restored the way they were saved.",
  "cloud.point.mac.title": "Your Mac stays connected",
  "cloud.point.mac.detail": "It becomes one of your Devices, with its own browser and apps.",
  "cloud.price": "{price} a {interval}",
  "cloud.priceOnce": "{price}",
  "cloud.priceDetail": "Billed by the Opensteer Account. Cancel any time.",
  "cloud.changes.title": "What changes",
  "cloud.changes.detail":
    "Your Cloud Computer starts as a new Opensteer. Connected agents connect again to its new address. Your Mac’s browser profiles and apps stay usable through your Mac.",
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
  "cloud.ready.title": "Cloud Computer is ready",
  "cloud.ready.open": "Open it",
  "cloud.ready.start": "Start",
  "cloud.ready.reconnect": "Connect your agents again",
  "cloud.ready.thisMac": "Connect this Mac as a Device",
  "cloud.ready.thisMacDetail":
    "Your agents can then use this Mac’s browser and apps from the Cloud Computer.",
  "cloud.ready.notListed":
    "It isn’t in your Opensteer list yet. It appears there once your Account has set it up for you.",
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
  "cloud.ip.paused": "Browsing paused",
  "cloud.ip.pausedDetail":
    "Its IP route isn’t answering, so pages won’t load from a different address. Opensteer keeps trying.",
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
    "Opensteer destroys the computer and disk, including its browser profiles and tasks, and makes its backups unreadable. Opensteer then removes the stored backup data. This can’t be undone.",
  "cloud.delete.typeToConfirm": "Type delete to confirm",
  "cloud.delete.word": "delete",
  "cloud.delete.confirm": "Delete",
  "cloud.deleted": "Your Cloud Computer was deleted.",
  "cloud.account.signedOut": "Sign in to your Opensteer Account to set up a Cloud Computer.",
  "cloud.account.signIn": "Sign in",
  "cloud.account.unreachable": "Opensteer Account isn’t answering. Try again in a moment.",
  "cloud.account.unavailable": "This build of Opensteer has no Opensteer Account.",
  "cloud.account.website":
    "Set up and manage your Cloud Computer on the Opensteer website, where your Account is signed in.",
  "cloud.account.openWebsite": "Open the Opensteer website",
  "cloud.tryAgain": "Try again",
  "cloud.loading": "Loading…",
  "cloud.entry.title": "Opensteer Cloud Computer",
  "cloud.entry.detail": "Keep agents working while your Mac sleeps",
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
  "cloud.web.checkout.paid": "Payment received.",
  "cloud.deletion.computer": "Computer and disk destroyed",
  "cloud.deletion.backups": "Backups made unreadable",
  "cloud.deletion.storage": "Stored backup data removed",
  "cloud.deletion.done": "{fact} — Done {date}",
  "cloud.deletion.pending": "{fact} — Pending since {date}",
  "cloud.web.unavailable.title": "Cloud Computers aren’t available",
  "cloud.web.unavailable.detail": "This Opensteer Account doesn’t offer Cloud Computers yet.",
  "cloud.web.next.unavailable": "Try again later. Nothing was charged.",
  "cloud.web.next.inProgress":
    "Finish the checkout you already started. If you closed it, it expires within a day and you can start again.",
  "cloud.web.next.subscribed": "You already have one. Manage it below.",
  "cloud.web.next.expired": "Start again to get a fresh checkout.",
  "cloud.web.next.other": "Go back to see where your Cloud Computer stands.",
  "cloud.web.noBilling": "There’s no Cloud Computer subscription on this Account yet.",
  "cloud.web.typeWord": "Type delete in the box to confirm.",
  "cloud.web.managed": "Your organization manages this Cloud Computer. Ask them to change it.",
  "cloud.web.personal": "Your own Cloud Computer",
  "cloud.step.payment": "Payment received",
  "cloud.step.opensteer": "Starting Opensteer",
  "cloud.step.claim": "Linking it to your Account",
  "cloud.step.failed": "This step didn’t finish.",
  "cloud.region": "Region",
  "cloud.ip.address": "Browser address",
  "cloud.renews": "Renews {date}",
  "cloud.reason.already-exists": "You already have a Cloud Computer.",
  "cloud.reason.no-capacity":
    "There’s no room for a new Cloud Computer right now. Nothing was charged.",
  "cloud.reason.sales-not-open": "Cloud Computers aren’t on sale yet.",
  "cloud.reason.work-managed": "Your organization manages this Cloud Computer.",
  "cloud.reason.checkout-expired": "This checkout expired.",
  "cloud.reason.checkout-complete": "This checkout is already paid.",
  "cloud.reason.checkout-in-progress": "You already started a checkout.",
  "cloud.reason.checkout-unavailable": "Checkout isn’t available right now. Nothing was charged.",
  "cloud.reason.billing-web-only": "Billing is managed on the Opensteer website.",
  "cloud.reason.delete-confirmation-required": "Type delete to confirm.",
  "cloud.reason.not-found": "This Cloud Computer isn’t on your Account.",
  "cloud.reason.deleted": "This Cloud Computer was deleted.",
  "cloud.reason.owner-suspended": "You paused this Cloud Computer.",
  "cloud.reason.deletion-pending": "Deleting. Waiting for Stripe to end the subscription.",
  "cloud.reason.bootstrap-expired": "Its setup took too long to start.",
  "cloud.next.already-exists": "You already have one. Manage it below.",
  "cloud.next.no-capacity": "Try again later.",
  "cloud.next.sales-not-open": "Try again later.",
  "cloud.next.work-managed": "Ask your organization to change it.",
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
