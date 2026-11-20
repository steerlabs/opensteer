/**
 * Every word the Opensteer Cloud Computer screens show, keyed by the design's copy ids
 * (`.opensteer/overhaul/design/copy.json`), so web, desktop and phone say the same thing.
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
