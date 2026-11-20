import type { ThreadAccessMode } from "@opensteer/core";
import {
  WorkAuditRecordSchema,
  type WorkAssignmentView,
  type WorkAuditRecord,
  type WorkPolicy,
} from "./organizations.js";

/**
 * Every word the organization screens show, by stable id: the Account website's admin
 * and member pages and the apps' work Home screens all read these, so an admin and an
 * employee are told the same thing. `{name}` marks a value filled in by `orgWords`.
 */
export const organizationCopy = {
  "org.title": "Organizations",
  "org.web.title": "Organizations · Opensteer",
  "org.lead": "Work Homes your organization pays for, and the people who use them.",
  "org.none": "You aren’t in an organization.",
  "org.open": "Open",
  "org.role.admin": "Admin",
  "org.role.member": "Member",

  "org.split.title": "What an organization gets",
  "org.split.lead":
    "You pay for and govern each work Home. You cannot open it, watch it or read what is in it.",
  "org.split.can": "You can",
  "org.split.cannot": "You cannot",
  "org.can.seats": "Buy seats and give each one to a person as their work Home",
  "org.can.policy": "Set the policy every work Home follows",
  "org.can.status": "See each work Home’s status and which policy it has applied",
  "org.can.audit": "Download each work Home’s audit record",
  "org.can.offboard": "Offboard: cut sign-in, power it off and delete it",
  "org.cannot.signIn": "Sign in to a work Home or use it",
  "org.cannot.watch": "Watch it, or answer its Requests",
  "org.cannot.content":
    "See its pages, messages, prompts, files, screenshots or anything else on it",

  "org.create.title": "Create an organization",
  "org.create.name": "Organization name",
  "org.create.seats": "Seats",
  "org.create.seatsDetail": "One seat is one work Home for one person.",
  "org.create.price": "{price} a seat a {interval}",
  "org.create.priceOnce": "{price} a seat",
  "org.create.total": "{seats} × {price} = {total} a {interval}",
  "org.create.totalOnce": "{seats} × {price} = {total}",
  "org.create.billing": "Billed by the Opensteer Account. Change seats or cancel any time.",
  "org.checkout": "Continue to checkout",
  "org.checkout.detail": "You pay on Stripe, then come back here.",
  "org.checkout.back": "Back",
  "org.checkout.completed":
    "Payment received. Your organization appears here as soon as Stripe confirms it.",
  "org.unavailable.title": "Organizations aren’t available",
  "org.unavailable.detail": "This Opensteer Account doesn’t offer organizations yet.",

  "org.seats.title": "Seats",
  "org.seats.paid": "Paid",
  "org.seats.assigned": "Assigned",
  "org.seats.free": "Free",
  "org.seats.pending": "Pending",
  "org.seats.pendingDetail": "{seats} seats once the payment provider confirms the change.",
  "org.seats.change": "Change seats",
  "org.seats.changeDetail":
    "An increase applies when the payment provider confirms it. You can’t go below the seats you’ve assigned.",
  "org.seats.save": "Save seats",
  "org.billing.title": "Billing",
  "org.billing.manage": "Manage billing",
  "org.billing.active": "Active",
  "org.billing.payment_failed": "Payment failed",
  "org.billing.past_due": "Past due",
  "org.billing.unpaid": "Unpaid",
  "org.billing.canceled": "Canceled",
  "org.billing.inactive": "Inactive",
  "org.billing.attention":
    "New work Homes can’t be assigned until billing is fixed. Nothing is deleted.",

  "org.people.title": "People",
  "org.people.invite": "Invite",
  "org.people.email": "Email",
  "org.people.role": "Role",
  "org.people.inviteDetail":
    "Opensteer doesn’t email them. Ask them to sign in at {address} with {email} to accept.",
  "org.people.pending": "Invited",
  "org.people.makeAdmin": "Make admin",
  "org.people.makeMember": "Make member",
  "org.people.remove": "Remove",
  "org.people.removeConfirm":
    "Remove {name} from {organization}? They keep their Opensteer Account and personal Homes.",
  "org.people.you": "You",

  "org.homes.title": "Work Homes",
  "org.homes.none": "No work Homes yet. Assign a free seat to a member.",
  "org.homes.assign": "Assign a seat",
  "org.homes.assignTo": "Member",
  "org.homes.assignDetail":
    "Opensteer sets up a new Cloud Computer for them. Only they can sign in to it.",
  "org.homes.nobody": "Every member already has a work Home.",
  "org.homes.formerMember": "A former member",
  "org.status.preparing": "Setting up",
  "org.status.ready": "Running",
  "org.status.needs_attention": "Needs attention",
  "org.status.suspended": "Suspended",
  "org.status.deleted": "Deleted",
  "org.status.signInCut": "Sign-in cut",
  "org.policy.applied": "Policy applied · revision {revision}",
  "org.policy.pending": "Policy pending on the Home · revision {revision} (it has {applied})",
  "org.audit.none": "No audit records received yet",
  "org.audit.last": "Audit record {sequence} received {at}",
  "org.audit.gap": "Gap: expected record {expected}, the Home sent {received}",
  "org.audit.download": "Download audit (JSONL)",

  "org.offboard": "Offboard",
  "org.offboard.title": "Offboard {name}?",
  "org.offboard.step.cut": "Their sign-in to this work Home is cut now.",
  "org.offboard.step.off":
    "The computer is powered off, so every agent, Device and session on it stops working.",
  "org.offboard.step.delete":
    "After the time you choose, Opensteer destroys the computer and disk and makes its backups unreadable. Opensteer then removes the stored backup data. The next person gets a different work Home.",
  "org.offboard.step.recall": "What an agent already did or copied elsewhere can’t be recalled.",
  "org.offboard.step.audit":
    "The audit record stays with your organization. Opensteer asks the Home to send its last records first.",
  "org.offboard.retention": "Keep the powered-off Home for",
  "org.offboard.confirm": "Offboard",
  "org.offboard.progress": "Offboarding",
  "org.offboard.cut": "Sign-in cut",
  "org.offboard.cutPending": "Sign-in not cut yet",
  "org.offboard.off": "Powered off",
  "org.offboard.offPending": "Powering off",
  "org.offboard.deleted": "Deleted",
  "org.offboard.deletesAt": "Retention after power-off ends {at}",
  "org.offboard.retainPending": "Retention starts when power-off is confirmed",
  "org.offboard.deletionRequested": "Deletion requested",
  "org.offboard.deletionInProgress": "Deletion in progress",
  "org.audit.finalUnconfirmed": "Final records not confirmed",
  "org.billing.payInvoice": "Complete payment",
  "org.billing.abandonSeats": "Abandon seat change",
  "org.billing.close": "Close organization",
  "org.billing.closeDetail":
    "Offboard every work Home before closing the organization and ending billing.",
  "org.billing.closing": "Waiting for billing to end",
  "org.billing.closed": "Organization closed",
  "org.billing.restore": "Pay for this organization again",
  "org.offboard.deletesNow": "Deleting now",
  "org.offboard.ended": "Ended",

  "org.policy.title": "Policy",
  "org.policy.lead":
    "Every work Home follows this. It limits what agents may do there; it never lets you see in.",
  "org.policy.revision": "Revision {revision}",
  "org.policy.homes": "{applied} of {total} work Homes have applied it",
  "org.policy.save": "Save policy",
  "org.policy.on": "Allowed",
  "org.policy.off": "Not allowed",
  "org.policy.externalMaxMode.title": "Most an outside agent may do on its own",
  "org.policy.externalMaxMode.detail":
    "An agent connected from outside never acts with more freedom than this, whatever its grant says. The person’s own agents on their work Home aren’t limited by it.",
  "org.policy.allowTasks.title": "Agents may run tasks",
  "org.policy.allowTasks.detail":
    "Whether a connected agent may be given tasks to run. When this is off, it can’t be given everything either.",
  "org.policy.allowEverything.title": "Agents may be given everything",
  "org.policy.allowEverything.detail":
    "Whether a connected agent may be granted everything on the work Home at once. Needs tasks allowed too.",
  "org.policy.devices.title": "Devices",
  "org.policy.devices.detail":
    "Whether the person may connect their own computers to their work Home. Each one says it’s joining a work Home before it does.",
  "org.policy.devices.cloud-computer-only": "Only the work Home’s own Cloud Computer",
  "org.policy.devices.assignee-may-enroll": "The person may connect their own Devices",
  "org.mode.approval-required": "Supervised",
  "org.mode.auto-accept-edits": "Auto-accept edits",
  "org.mode.auto": "Auto",
  "org.mode.full-access": "Full access",

  "org.audit.title": "Audit record",
  "org.audit.lead":
    "Each work Home sends what it observed, never content. Records are numbered without gaps and chained, so a missing record shows.",
  "org.audit.included": "What’s in it",
  "org.audit.excluded": "What’s never in it",
  "org.audit.fields": "Every record holds only ids, choices and times: {fields}.",

  "org.invite.title": "Join {organization}",
  "org.invite.lead":
    "Your organization can assign you a work Home. It cannot see your personal Opensteer or your own computers.",
  "org.invite.as": "Invited as {role} · {email}",
  "org.invite.accept": "Join {organization}",
  "org.invite.none": "There are no invitations for {email}.",
  "org.invite.wrongEmail":
    "This invitation is for another email address. Sign in with the address it was sent to.",

  "org.work.title": "{organization} · Work Home",
  "org.work.badge": "Work · {organization}",
  "org.work.managed": "Managed by {organization}: they pay for it and can suspend or delete it.",
  "org.work.none": "{organization} hasn’t assigned you a work Home yet.",
  "org.work.policy": "What {organization} decides",
  "org.work.see.title": "What {organization} can see",
  "org.work.see.lead":
    "{organization} pays for this work Home and sets its policy. Only you can sign in to it.",
  "org.work.see.sees": "{organization} can see",
  "org.work.see.never": "{organization} can never see",
  "org.work.see.status": "Whether this Home is running, suspended or deleted, and its address",
  "org.work.see.policy": "Which policy revision this Home has applied",
  "org.work.see.records": "These records, sent from this Home:",
  "org.work.see.personal": "Your personal Opensteer and your own computers",
  "org.work.notAllowed": "Your organization doesn’t allow this",
  "org.overview.title": "Overview",
  "org.yours": "Your organizations",
  "org.work.yours": "Your work Home",
  "org.invite.pendingTitle": "Invitations for you",
  "org.invite.view": "View",
  "org.invite.missingTitle": "Invitation not found",
  "org.invite.can": "{organization} can assign you a work Home, pay for it and set its policy.",
  "org.invite.cannot":
    "{organization} can’t sign in to your work Home or see what’s on it, and can’t see your personal Opensteer or your own computers.",
  "org.people.members": "Members",
  "org.people.pendingTitle": "Invited",
  "org.people.lastAdmin": "The only admin. Make someone else an admin first.",
  "org.people.hasHome": "Has a work Home. Offboard it before removing them.",
  "org.homes.noSeat": "No free seats. Add seats on the Overview page.",
  "org.homes.free": "{free} free",
  "org.audit.about": "About the audit record",
  "org.refused.form": "Something in the form isn’t right.",
  "org.refused.formNext": "Check it and try again.",
  "org.refused.forbiddenNext": "Only an admin of this organization can do this.",
  "org.done.seats": "Seats saved. An increase applies when the payment provider confirms it.",
  "org.done.invited": "Invited. Send them the link below.",
  "org.done.removed": "Removed from the organization.",
  "org.done.role": "Role changed.",
  "org.done.assigned": "Seat assigned. Their work Home is being set up.",
  "org.done.offboarded": "Offboarding started. Each step’s status is below.",
  "org.done.policy": "Policy saved. Each work Home applies it the next time it checks in.",
  "org.done.joined": "You joined the organization.",
} as const;

export type OrganizationCopyId = keyof typeof organizationCopy;

export function orgWords(
  id: OrganizationCopyId,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return organizationCopy[id].replace(/\{(\w+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

export function orgModeLabel(mode: ThreadAccessMode): string {
  return orgWords(`org.mode.${mode}`);
}

/** How long an offboarded work Home is kept, powered off, before it is deleted. */
export const offboardRetentionChoices = [
  { seconds: 0, label: "Now" },
  { seconds: 7 * 86_400, label: "After 7 days" },
  { seconds: 30 * 86_400, label: "After 30 days" },
  { seconds: 90 * 86_400, label: "After 90 days" },
] as const;

/** What each audit record kind says, in plain words. A new kind fails to compile here. */
const auditKindWords: Readonly<Record<WorkAuditRecord["kind"], string>> = {
  "connection.consent": "An agent was connected, and by whom",
  "connection.grant_changed": "An agent’s access was changed",
  "connection.disconnected": "An agent was disconnected",
  "connection.expired": "An agent’s connection expired",
  "agent_session.started": "An agent session started",
  "agent_session.ended": "An agent session ended",
  "operation.direct":
    "Each direct action: its kind of tool and target, the access it ran with, who decided and the outcome",
  "request.opened": "A Request was opened",
  "request.answered": "A Request was answered, and how",
  "request.expired": "A Request expired",
  stop: "Stop was pressed",
  "device.enrolled": "A Device was connected",
  "device.removed": "A Device was removed",
  "device.switch_changed": "A Device was switched on or off",
  "owner.signed_in": "The person signed in",
  "owner.signed_out": "The person signed out",
  "policy.applied": "A policy revision was applied",
};

/** Every record kind a work Home sends, read from the record schema itself. */
export const workAuditRecordKinds: readonly {
  readonly kind: WorkAuditRecord["kind"];
  readonly words: string;
}[] = WorkAuditRecordSchema.options.map((option) => {
  const kind = option.shape.kind.value;
  return { kind, words: auditKindWords[kind] };
});

/** Every field any record can carry, read from the record schema itself. */
export const workAuditRecordFields: readonly string[] = [
  ...new Set(WorkAuditRecordSchema.options.flatMap((option) => Object.keys(option.shape))),
];

/** What no record carries, by design. A schema test keeps every field clear of these. */
export const workAuditExcluded: readonly string[] = [
  "Addresses or titles of pages",
  "Page content",
  "Scripts or their arguments",
  "Results of actions",
  "Messages or prompts",
  "File names or paths",
  "Screenshots",
  "Labels or any free text",
];

/** The policy as an employee reads it, one sentence per switch. */
export function workPolicyLines(policy: WorkPolicy): readonly {
  readonly title: string;
  readonly value: string;
  readonly detail: string;
}[] {
  return [
    {
      title: orgWords("org.policy.externalMaxMode.title"),
      value: orgModeLabel(policy.externalMaxMode),
      detail: orgWords("org.policy.externalMaxMode.detail"),
    },
    {
      title: orgWords("org.policy.allowTasks.title"),
      value: orgWords(policy.allowTasks ? "org.policy.on" : "org.policy.off"),
      detail: orgWords("org.policy.allowTasks.detail"),
    },
    {
      title: orgWords("org.policy.allowEverything.title"),
      value: orgWords(
        policy.allowEverything && policy.allowTasks ? "org.policy.on" : "org.policy.off",
      ),
      detail: orgWords("org.policy.allowEverything.detail"),
    },
    {
      title: orgWords("org.policy.devices.title"),
      value: orgWords(`org.policy.devices.${policy.devices}`),
      detail: orgWords("org.policy.devices.detail"),
    },
  ];
}

/** A work Home's status as the Account reports it, with sign-in cut said first. */
export function workHomeStatusLabel(
  view: Pick<WorkAssignmentView, "homeStatus" | "signInCut" | "deleted">,
): string {
  if (view.signInCut && !view.deleted) return orgWords("org.status.signInCut");
  return orgWords(`org.status.${view.homeStatus}`);
}
