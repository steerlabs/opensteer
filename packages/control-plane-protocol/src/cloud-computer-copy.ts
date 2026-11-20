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
    "Its browser profiles, tasks, connected agents and backups are deleted. This can’t be undone.",
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
  "cloud.web.deleted.detail": "It’s gone, with its backups. You can set up a new one.",
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
