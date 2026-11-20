import { cloudComputerDeletionLines } from "../cloud-computers/portal-pages.js";
import {
  cloudComputerPriceLine,
  offboardRetentionChoices,
  orgModeLabel,
  orgWords,
  workAuditExcluded,
  workAuditRecordKinds,
  workHomeStatusLabel,
  type MyOrganizationsResponse,
  type OrganizationAdminResponse,
  type OrganizationCopyId,
  type WorkAssignmentView,
} from "@opensteer/control-plane-protocol";
import { ThreadAccessModeSchema } from "@opensteer/core";
import {
  escapeHtml,
  icon,
  statusPageBody,
  type BrowserPageIcon,
} from "@opensteer/shared/browserPage";
import type { OrganizationOffer } from "./config.js";

/**
 * The Opensteer website's organization pages. An admin reads, on every page, what they
 * control and what they can never see; an invited person reads what joining means. Every
 * page works without a script: forms post and confirmations open in place.
 */

export const organizationsPortalPath = "/organizations";
export const organizationCreatePortalPath = "/organizations/new";
export const organizationInvitationPortalPath = (id: string) =>
  `/organizations/invitations/${encodeURIComponent(id)}`;
export const organizationPortalPath = (id: string, section: OrganizationSection = "overview") =>
  `/organizations/${encodeURIComponent(id)}${section === "overview" ? "" : `/${section}`}`;
export const organizationAuditDownloadPath = (id: string, assignmentId: string) =>
  `/organizations/${encodeURIComponent(id)}/audit/${encodeURIComponent(assignmentId)}/export.jsonl`;

export const organizationSections = [
  "overview",
  "people",
  "work-homes",
  "policy",
  "audit",
] as const;
export type OrganizationSection = (typeof organizationSections)[number];
const sectionTitles: Readonly<Record<OrganizationSection, OrganizationCopyId>> = {
  overview: "org.overview.title",
  people: "org.people.title",
  "work-homes": "org.homes.title",
  policy: "org.policy.title",
  audit: "org.audit.title",
};

/** Something the Account said no to, and what the person can do next. */
export interface OrganizationRefusal {
  readonly sentence: string;
  readonly next: string | null;
}

const w = (id: OrganizationCopyId, values?: Readonly<Record<string, string | number>>) =>
  escapeHtml(orgWords(id, values));

function card(head: string, content: string, wide = false): string {
  return `<main class="card org${wide ? " org--wide" : ""}"><div class="card__head">${head}</div>${content}</main>`;
}

function head(title: string, lead: string, mark: BrowserPageIcon = "stack"): string {
  return `<span class="device device--large">${icon(mark)}</span><h1 class="title">${escapeHtml(title)}</h1><p class="lead">${escapeHtml(lead)}</p>`;
}

function row(input: {
  readonly icon: BrowserPageIcon;
  readonly title: string;
  readonly detail?: string | readonly string[] | null;
  readonly tone?: "ok" | "busy" | "warn" | "muted";
  readonly mono?: boolean;
  readonly trailing?: string;
}): string {
  const dot = input.tone ? `<span class="dot dot--${input.tone}"></span>` : "";
  const details = (
    input.detail === undefined || input.detail === null
      ? []
      : typeof input.detail === "string"
        ? [input.detail]
        : input.detail
  )
    .map(
      (line) =>
        `<span class="place__note${input.tone === "warn" ? " place__note--warn" : ""}${input.mono ? " mono" : ""}">${escapeHtml(line)}</span>`,
    )
    .join("");
  return `<li class="place place--still"><span class="device">${icon(input.icon)}${dot}</span><span class="place__body"><span class="place__name">${escapeHtml(input.title)}</span>${details}</span>${input.trailing ?? ""}</li>`;
}

function alert(refusal: OrganizationRefusal | null): string {
  return refusal
    ? `<div class="alert" role="alert"><p class="alert__title">${escapeHtml(refusal.sentence)}</p>${refusal.next ? `<p class="lead">${escapeHtml(refusal.next)}</p>` : ""}</div>`
    : "";
}

function note(text: string | null): string {
  return text ? `<p class="lead" role="status">${escapeHtml(text)}</p>` : "";
}

function section(title: string, content: string): string {
  return `<section class="org__section"><h2 class="section-title">${escapeHtml(title)}</h2>${content}</section>`;
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

/** What an organization controls and what it never sees, said the same way everywhere. */
export function organizationSplit(): string {
  const list = (ids: readonly OrganizationCopyId[], mark: string) =>
    `<ul class="org__list org__list--${mark}">${ids.map((id) => `<li>${w(id)}</li>`).join("")}</ul>`;
  return `<div class="org__split"><div><h3 class="org__split-title">${w("org.split.can")}</h3>${list(
    ["org.can.seats", "org.can.policy", "org.can.status", "org.can.audit", "org.can.offboard"],
    "can",
  )}</div><div><h3 class="org__split-title">${w("org.split.cannot")}</h3>${list(
    ["org.cannot.signIn", "org.cannot.watch", "org.cannot.content"],
    "cannot",
  )}</div></div>`;
}

function priceLines(offer: OrganizationOffer, seats: number) {
  const per = cloudComputerPriceLine(offer, "en-US");
  const total = cloudComputerPriceLine(
    { ...offer, amountMinor: offer.amountMinor * seats },
    "en-US",
  );
  return {
    each: offer.interval
      ? orgWords("org.create.price", { price: per.price, interval: offer.interval })
      : orgWords("org.create.priceOnce", { price: per.price }),
    total: offer.interval
      ? orgWords("org.create.total", {
          seats,
          price: per.price,
          total: total.price,
          interval: offer.interval,
        })
      : orgWords("org.create.totalOnce", { seats, price: per.price, total: total.price }),
  };
}

const instant = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
export function organizationTime(iso: string): string {
  return `${instant.format(new Date(iso))} UTC`;
}

/** `{portal}/organizations`: the person's organizations and invitations. */
export function organizationListBody(input: {
  readonly mine: MyOrganizationsResponse;
  readonly canCreate: boolean;
  readonly notice: string | null;
  readonly refusal: OrganizationRefusal | null;
}): string {
  const { organizations, invitations } = input.mine;
  const orgs = organizations.length
    ? `<ul class="places">${organizations
        .map((org) =>
          row({
            icon: "stack",
            title: org.name,
            detail: orgWords(org.role === "admin" ? "org.role.admin" : "org.role.member"),
            trailing:
              org.role === "admin"
                ? `<a class="btn org__row-action" href="${organizationPortalPath(org.id)}">${w("org.open")}</a>`
                : `<a class="btn org__row-action" href="/cloud-computer">${w("org.work.yours")}</a>`,
          }),
        )
        .join("")}</ul>`
    : `<p class="lead">${w("org.none")}</p>`;
  const invites = invitations.length
    ? section(
        orgWords("org.invite.pendingTitle"),
        `<ul class="places">${invitations
          .map((invite) =>
            row({
              icon: "person",
              title: invite.organization.name,
              detail: orgWords("org.invite.as", {
                role: orgWords(invite.role === "admin" ? "org.role.admin" : "org.role.member"),
                email: invite.email,
              }),
              trailing: `<a class="btn btn--primary org__row-action" href="${organizationInvitationPortalPath(invite.id)}">${w("org.invite.view")}</a>`,
            }),
          )
          .join("")}</ul>`,
      )
    : "";
  const create = input.canCreate
    ? `<a class="btn btn--block" href="${organizationCreatePortalPath}">${w("org.create.title")}</a>`
    : "";
  return card(
    head(orgWords("org.title"), orgWords("org.lead")),
    `${alert(input.refusal)}${note(input.notice)}${invites}${section(orgWords("org.yours"), orgs)}${create}`,
  );
}

/** `{portal}/organizations/new`: name, seats, the per-seat price, and checkout. */
export function organizationCreateBody(input: {
  readonly offer: OrganizationOffer;
  readonly requestId: string;
  readonly name: string;
  readonly seats: number;
  readonly refusal: OrganizationRefusal | null;
}): string {
  const price = priceLines(input.offer, input.seats);
  return card(
    head(orgWords("org.create.title"), orgWords("org.split.lead")),
    `${alert(input.refusal)}${organizationSplit()}
    <form class="form" method="post" action="${organizationCreatePortalPath}">${hidden("requestId", input.requestId)}
      <label class="org__label" for="org-name">${w("org.create.name")}</label>
      <span class="field"><input id="org-name" name="name" maxlength="120" required autocomplete="organization" value="${escapeHtml(input.name)}"></span>
      <label class="org__label" for="org-seats">${w("org.create.seats")}</label>
      <span class="field"><input id="org-seats" name="seats" type="number" inputmode="numeric" min="1" max="1000" required value="${input.seats}"></span>
      <p class="fine org__left">${w("org.create.seatsDetail")}</p>
      <p class="lead org__price"><strong>${escapeHtml(price.each)}</strong><br>${escapeHtml(price.total)}<br>${w("org.create.billing")}</p>
      <div class="actions"><a class="btn" href="${organizationsPortalPath}">${w("org.checkout.back")}</a><button class="btn btn--primary" type="submit">${w("org.checkout")}</button></div>
      <p class="fine">${w("org.checkout.detail")}</p>
    </form>`,
  );
}

export function organizationUnavailableBody(): string {
  return statusPageBody({
    action: { href: organizationsPortalPath, label: orgWords("org.checkout.back") },
    detail: orgWords("org.unavailable.detail"),
    mark: "stack",
    title: orgWords("org.unavailable.title"),
    tone: "warn",
  });
}

/** `{portal}/organizations/invitations/:id`: what joining means, and one button. */
export function organizationInvitationBody(input: {
  readonly invitation: MyOrganizationsResponse["invitations"][number] | null;
  readonly email: string;
  readonly refusal: OrganizationRefusal | null;
}): string {
  const { invitation } = input;
  if (!invitation)
    return card(
      head(
        orgWords("org.invite.missingTitle"),
        orgWords("org.invite.none", { email: input.email }),
        "person",
      ),
      `${alert(input.refusal)}<p class="lead">${w("org.invite.wrongEmail")}</p><a class="btn btn--block" href="${organizationsPortalPath}">${w("org.title")}</a>`,
    );
  const organization = invitation.organization.name;
  return card(
    head(orgWords("org.invite.title", { organization }), orgWords("org.invite.lead"), "person"),
    `${alert(input.refusal)}<ul class="places">${row({
      icon: "person",
      title: input.email,
      detail: orgWords("org.invite.as", {
        role: orgWords(invitation.role === "admin" ? "org.role.admin" : "org.role.member"),
        email: invitation.email,
      }),
    })}</ul>
    <ul class="org__list org__list--can"><li>${w("org.invite.can", { organization })}</li></ul>
    <ul class="org__list org__list--cannot"><li>${w("org.invite.cannot", { organization })}</li></ul>
    <form method="post" action="${organizationInvitationPortalPath(invitation.id)}/accept"><button class="btn btn--primary btn--block" type="submit">${w("org.invite.accept", { organization })}</button></form>`,
  );
}

function tabs(view: OrganizationAdminResponse, current: OrganizationSection): string {
  return `<nav class="org__tabs" aria-label="${escapeHtml(view.name)}">${organizationSections
    .map(
      (name) =>
        `<a class="org__tab" href="${organizationPortalPath(view.id, name)}"${name === current ? ' aria-current="page"' : ""}>${w(sectionTitles[name])}</a>`,
    )
    .join("")}</nav>`;
}

function liveAssignments(view: OrganizationAdminResponse): readonly WorkAssignmentView[] {
  return view.assignments.filter((assignment) => assignment.state !== "ended");
}

function personName(assignment: WorkAssignmentView): string {
  return assignment.assignee
    ? `${assignment.assignee.displayName} · ${assignment.assignee.email}`
    : orgWords("org.homes.formerMember");
}

function overview(view: OrganizationAdminResponse, requestId: string): string {
  const { seats } = view;
  const cells = (
    [
      ["org.seats.paid", seats.paid],
      ["org.seats.assigned", seats.assigned],
      ["org.seats.free", seats.free],
      ...(seats.pending === null ? [] : [["org.seats.pending", seats.pending] as const]),
    ] as const
  )
    .map(
      ([id, value]) =>
        `<div class="org__stat"><span class="org__stat-value">${value}</span><span class="org__stat-label">${w(id)}</span></div>`,
    )
    .join("");
  const billingOk = view.billingStatus === "active";
  const change =
    view.closedAt || view.closingAt || !billingOk
      ? ""
      : seats.pending === null
        ? `<form class="org__inline" method="post" action="${organizationPortalPath(view.id)}/seats">${hidden("requestId", requestId)}
        <label class="org__label" for="org-seats">${w("org.seats.change")}</label>
        <div class="org__inline-row"><span class="field"><input id="org-seats" name="seats" type="number" inputmode="numeric" min="1" max="1000" required value="${seats.paid}"></span><button class="btn" type="submit">${w("org.seats.save")}</button></div>
        <p class="fine org__left">${w("org.seats.changeDetail")}</p></form>`
        : `<p class="lead" role="status">${w("org.seats.pendingDetail", { seats: seats.pending })}</p>${
            view.pendingSeatChange?.invoiceUrl
              ? `<a class="btn btn--block" href="${escapeHtml(view.pendingSeatChange.invoiceUrl)}">${w("org.billing.payInvoice")}</a>`
              : ""
          }${
            view.pendingSeatChange
              ? `<form method="post" action="${organizationPortalPath(view.id)}/seats/abandon">${hidden("requestId", view.pendingSeatChange.requestId)}<button class="btn btn--block" type="submit">${w("org.billing.abandonSeats")}</button></form>`
              : ""
          }`;
  const closure = view.closedAt
    ? `<p class="lead">${w("org.billing.closed")}</p>`
    : view.closingAt
      ? `<p class="lead">${w("org.billing.closing")}</p>`
      : `${
          view.billingStatus === "canceled"
            ? `<form method="post" action="${organizationPortalPath(view.id)}/billing/restore">${hidden("requestId", requestId)}<button class="btn btn--primary btn--block" type="submit">${w("org.billing.restore")}</button></form>`
            : ""
        }${
          seats.assigned === 0
            ? `<details><summary class="btn btn--block">${w("org.billing.close")}</summary><p class="lead">${w("org.billing.closeDetail")}</p><form method="post" action="${organizationPortalPath(view.id)}/close"><button class="btn btn--danger btn--block" type="submit">${w("org.billing.close")}</button></form></details>`
            : `<p class="fine">${w("org.billing.closeDetail")}</p>`
        }`;
  return `${section(orgWords("org.seats.title"), `<div class="org__stats">${cells}</div>${change}`)}
  ${section(
    orgWords("org.billing.title"),
    `<ul class="places">${row({
      icon: "key",
      title: orgWords(`org.billing.${view.billingStatus}`),
      detail: billingOk ? null : orgWords("org.billing.attention"),
      tone: billingOk ? "ok" : "warn",
    })}</ul><form method="post" action="${organizationPortalPath(view.id)}/billing"><button type="submit" class="btn btn--block">${w("org.billing.manage")}</button></form>${closure}`,
  )}
  ${section(orgWords("org.split.title"), `<p class="lead">${w("org.split.lead")}</p>${organizationSplit()}`)}`;
}

function people(view: OrganizationAdminResponse, self: string, portalOrigin: string): string {
  const admins = view.members.filter((member) => member.role === "admin").length;
  const members = `<ul class="places">${view.members
    .map((member) => {
      const live = view.assignments.some(
        (assignment) =>
          assignment.state !== "ended" && assignment.assignee?.accountId === member.accountId,
      );
      const action = (kind: string, label: string, danger = false) =>
        `<form method="post" action="${organizationPortalPath(view.id)}/members">${hidden("accountId", member.accountId)}${hidden("action", kind)}<button class="btn org__row-action${danger ? " btn--danger" : ""}" type="submit">${escapeHtml(label)}</button></form>`;
      const lastAdmin = member.role === "admin" && admins === 1;
      const role =
        member.role === "admin"
          ? lastAdmin
            ? ""
            : action("member", orgWords("org.people.makeMember"))
          : action("admin", orgWords("org.people.makeAdmin"));
      const remove =
        lastAdmin || live
          ? ""
          : `<details class="org__confirm"><summary class="btn org__row-action btn--danger">${w("org.people.remove")}</summary><p class="lead">${w(
              "org.people.removeConfirm",
              { name: member.displayName, organization: view.name },
            )}</p>${action("remove", orgWords("org.people.remove"), true)}</details>`;
      const notes = [
        `${member.email} · ${orgWords(member.role === "admin" ? "org.role.admin" : "org.role.member")}${member.accountId === self ? ` · ${orgWords("org.people.you")}` : ""}`,
        ...(lastAdmin ? [orgWords("org.people.lastAdmin")] : []),
        ...(live ? [orgWords("org.people.hasHome")] : []),
      ];
      return row({
        icon: "person",
        title: member.displayName,
        detail: notes,
        trailing: `<span class="org__row-actions">${role}${remove}</span>`,
      });
    })
    .join("")}</ul>`;
  const invites = view.invitations.length
    ? `<ul class="places">${view.invitations
        .map((invite) =>
          row({
            icon: "clock",
            title: invite.email,
            detail: [
              `${orgWords("org.people.pending")} · ${orgWords(invite.role === "admin" ? "org.role.admin" : "org.role.member")}`,
              orgWords("org.people.inviteDetail", {
                address: `${portalOrigin}${organizationInvitationPortalPath(invite.id)}`,
                email: invite.email,
              }),
            ],
          }),
        )
        .join("")}</ul>`
    : "";
  const invite = `<form class="form" method="post" action="${organizationPortalPath(view.id)}/invitations">
    <label class="org__label" for="org-invite-email">${w("org.people.email")}</label>
    <span class="field"><input id="org-invite-email" name="email" type="email" required autocomplete="off"></span>
    <label class="org__label" for="org-invite-role">${w("org.people.role")}</label>
    <span class="field"><select id="org-invite-role" name="role"><option value="member">${w("org.role.member")}</option><option value="admin">${w("org.role.admin")}</option></select></span>
    <button class="btn btn--primary btn--block" type="submit">${w("org.people.invite")}</button></form>`;
  return `${section(orgWords("org.people.members"), members)}${invites ? section(orgWords("org.people.pendingTitle"), invites) : ""}${section(orgWords("org.people.invite"), invite)}`;
}

/** The real status of each offboarding step, as the Account reports it. */
export function offboardSteps(assignment: WorkAssignmentView): readonly string[] {
  if (assignment.state === "active") return [];
  return [
    orgWords(assignment.signInCut ? "org.offboard.cut" : "org.offboard.cutPending"),
    orgWords(
      assignment.suspended || assignment.deleted ? "org.offboard.off" : "org.offboard.offPending",
    ),
    assignment.deleted
      ? orgWords("org.offboard.deleted")
      : assignment.deletion?.startedAt
        ? orgWords("org.offboard.deletionInProgress")
        : assignment.deletion
          ? orgWords("org.offboard.deletionRequested")
          : assignment.retainUntil
            ? orgWords("org.offboard.deletesAt", { at: organizationTime(assignment.retainUntil) })
            : orgWords("org.offboard.retainPending"),
    ...cloudComputerDeletionLines(assignment.deletion),
  ];
}

function policyLine(view: OrganizationAdminResponse, assignment: WorkAssignmentView): string {
  return assignment.policyStatus === "Applied"
    ? orgWords("org.policy.applied", { revision: view.policyRevision })
    : orgWords("org.policy.pending", {
        revision: view.policyRevision,
        applied: assignment.appliedRevision,
      });
}

function auditLines(assignment: WorkAssignmentView): readonly string[] {
  const { audit } = assignment;
  return [
    ...(audit.finalFlush === "unconfirmed" ? [orgWords("org.audit.finalUnconfirmed")] : []),
    audit.lastReceivedAt
      ? orgWords("org.audit.last", {
          sequence: audit.lastSequence,
          at: organizationTime(audit.lastReceivedAt),
        })
      : orgWords("org.audit.none"),
    ...(audit.gap
      ? [orgWords("org.audit.gap", { expected: audit.gap.expected, received: audit.gap.received })]
      : []),
  ];
}

function homeTone(assignment: WorkAssignmentView) {
  if (assignment.deleted || assignment.signInCut) return "muted" as const;
  return assignment.homeStatus === "ready"
    ? ("ok" as const)
    : assignment.homeStatus === "needs_attention"
      ? ("warn" as const)
      : assignment.homeStatus === "preparing"
        ? ("busy" as const)
        : ("muted" as const);
}

function workHomes(view: OrganizationAdminResponse, requestId: string): string {
  const rows = view.assignments.length
    ? `<ul class="places">${view.assignments
        .map((assignment) => {
          const offboard =
            assignment.state === "active"
              ? `<details class="org__confirm"><summary class="btn org__row-action btn--danger">${w("org.offboard")}</summary>
              <form class="form org__offboard" method="post" action="${organizationPortalPath(view.id, "work-homes")}/${encodeURIComponent(assignment.assignmentId)}/offboard">
                <p class="alert__title">${w("org.offboard.title", { name: assignment.assignee?.displayName ?? orgWords("org.homes.formerMember") })}</p>
                <ol class="org__sequence">${(
                  [
                    "org.offboard.step.cut",
                    "org.offboard.step.off",
                    "org.offboard.step.delete",
                    "org.offboard.step.recall",
                    "org.offboard.step.audit",
                  ] as const
                )
                  .map((id) => `<li>${w(id)}</li>`)
                  .join("")}</ol>
                <fieldset class="org__choices"><legend class="org__label">${w("org.offboard.retention")}</legend>${offboardRetentionChoices
                  .map(
                    (choice, index) =>
                      `<label class="org__choice"><input type="radio" name="retentionSeconds" value="${choice.seconds}"${index === 2 ? " checked" : ""}> ${escapeHtml(choice.label)}</label>`,
                  )
                  .join("")}</fieldset>
                <button class="btn btn--danger btn--block" type="submit">${w("org.offboard.confirm")}</button>
              </form></details>`
              : "";
          const steps = offboardSteps(assignment);
          return row({
            icon: "server",
            title: personName(assignment),
            detail: [
              workHomeStatusLabel(assignment) +
                (assignment.reason && !assignment.deleted ? ` · ${assignment.reason}` : ""),
              ...(assignment.address ? [assignment.address] : []),
              policyLine(view, assignment),
              ...auditLines(assignment),
              ...(steps.length
                ? [`${orgWords("org.offboard.progress")}: ${steps.join(" · ")}`]
                : []),
            ],
            tone: homeTone(assignment),
            trailing: `<span class="org__row-actions">${offboard}</span>`,
          });
        })
        .join("")}</ul>`
    : `<p class="lead">${w("org.homes.none")}</p>`;
  const taken = new Set(
    liveAssignments(view).flatMap((assignment) =>
      assignment.assignee ? [assignment.assignee.accountId] : [],
    ),
  );
  const candidates = view.members.filter((member) => !taken.has(member.accountId));
  const assign =
    view.seats.free < 1
      ? `<p class="lead">${w("org.homes.noSeat")}</p>`
      : candidates.length === 0
        ? `<p class="lead">${w("org.homes.nobody")}</p>`
        : `<form class="form" method="post" action="${organizationPortalPath(view.id, "work-homes")}">${hidden("requestId", requestId)}
      <label class="org__label" for="org-assign">${w("org.homes.assignTo")}</label>
      <span class="field"><select id="org-assign" name="accountId">${candidates
        .map(
          (member) =>
            `<option value="${escapeHtml(member.accountId)}">${escapeHtml(member.displayName)} · ${escapeHtml(member.email)}</option>`,
        )
        .join("")}</select></span>
      <p class="fine org__left">${w("org.homes.assignDetail")}</p>
      <button class="btn btn--primary btn--block" type="submit">${w("org.homes.assign")}</button></form>`;
  return `${section(orgWords("org.homes.title"), rows)}${section(
    `${orgWords("org.homes.assign")} · ${orgWords("org.homes.free", { free: view.seats.free })}`,
    assign,
  )}`;
}

function policy(view: OrganizationAdminResponse): string {
  const live = liveAssignments(view).filter((assignment) => !assignment.signInCut);
  const applied = live.filter((assignment) => assignment.policyStatus === "Applied").length;
  const p = view.policy;
  const choice = (
    title: OrganizationCopyId,
    detail: OrganizationCopyId,
    key: string,
    control: string,
  ) =>
    `<div class="org__switch"><div class="org__switch-text"><span class="place__name">${w(title)}</span><span class="mono org__key">${key}</span><span class="place__note">${w(detail)}</span></div>${control}</div>`;
  const checkbox = (name: string, on: boolean) =>
    `<label class="org__toggle"><input type="checkbox" name="${name}" value="on"${on ? " checked" : ""}> ${w("org.policy.on")}</label>`;
  const form = `<form class="form" method="post" action="${organizationPortalPath(view.id, "policy")}">${hidden("expectedRevision", String(view.policyRevision))}
    ${choice(
      "org.policy.externalMaxMode.title",
      "org.policy.externalMaxMode.detail",
      "externalMaxMode",
      `<span class="field"><select name="externalMaxMode" aria-label="${w("org.policy.externalMaxMode.title")}">${ThreadAccessModeSchema.options
        .map(
          (mode) =>
            `<option value="${mode}"${mode === p.externalMaxMode ? " selected" : ""}>${escapeHtml(orgModeLabel(mode))}</option>`,
        )
        .join("")}</select></span>`,
    )}
    ${choice("org.policy.allowTasks.title", "org.policy.allowTasks.detail", "allowTasks", checkbox("allowTasks", p.allowTasks))}
    ${choice("org.policy.allowEverything.title", "org.policy.allowEverything.detail", "allowEverything", checkbox("allowEverything", p.allowEverything))}
    ${choice(
      "org.policy.devices.title",
      "org.policy.devices.detail",
      "devices",
      `<fieldset class="org__choices">${(["cloud-computer-only", "assignee-may-enroll"] as const)
        .map(
          (value) =>
            `<label class="org__choice"><input type="radio" name="devices" value="${value}"${value === p.devices ? " checked" : ""}> ${w(`org.policy.devices.${value}`)}</label>`,
        )
        .join("")}</fieldset>`,
    )}
    <button class="btn btn--primary btn--block" type="submit">${w("org.policy.save")}</button></form>`;
  const homes = live.length
    ? `<ul class="places">${live
        .map((assignment) =>
          row({
            icon: "server",
            title: personName(assignment),
            detail: policyLine(view, assignment),
            tone: assignment.policyStatus === "Applied" ? "ok" : "busy",
          }),
        )
        .join("")}</ul>`
    : "";
  return `${section(
    `${orgWords("org.policy.revision", { revision: view.policyRevision })} · ${orgWords("org.policy.homes", { applied, total: live.length })}`,
    `<p class="lead">${w("org.policy.lead")}</p>${form}`,
  )}${homes ? section(orgWords("org.homes.title"), homes) : ""}`;
}

/** What an audit export holds and what it never does, read from the record schema. */
export function auditDescription(): string {
  return `<p class="lead">${w("org.audit.lead")}</p>
  <h3 class="org__split-title">${w("org.audit.included")}</h3>
  <ul class="org__list org__list--can">${workAuditRecordKinds.map(({ words }) => `<li>${escapeHtml(words)}</li>`).join("")}</ul>
  <p class="fine org__left">${w("org.audit.fields")}</p>
  <h3 class="org__split-title">${w("org.audit.excluded")}</h3>
  <ul class="org__list org__list--cannot">${workAuditExcluded.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function audit(view: OrganizationAdminResponse): string {
  const rows = view.assignments.length
    ? `<ul class="places">${view.assignments
        .map((assignment) =>
          row({
            icon: "download",
            title: personName(assignment),
            detail: auditLines(assignment),
            ...(assignment.audit.gap ? { tone: "warn" as const } : {}),
            trailing: `<a class="btn org__row-action" href="${organizationAuditDownloadPath(view.id, assignment.assignmentId)}" download>${w("org.audit.download")}</a>`,
          }),
        )
        .join("")}</ul>`
    : `<p class="lead">${w("org.homes.none")}</p>`;
  return `${section(orgWords("org.homes.title"), rows)}${section(orgWords("org.audit.about"), auditDescription())}`;
}

/** `{portal}/organizations/:id[/section]`: one admin page, with the same tabs on each. */
export function organizationAdminBody(input: {
  readonly view: OrganizationAdminResponse;
  readonly section: OrganizationSection;
  readonly self: string;
  readonly portalOrigin: string;
  readonly requestId: string;
  readonly refusal: OrganizationRefusal | null;
  readonly notice: string | null;
}): string {
  const { view } = input;
  const content =
    input.section === "overview"
      ? overview(view, input.requestId)
      : input.section === "people"
        ? people(view, input.self, input.portalOrigin)
        : input.section === "work-homes"
          ? workHomes(view, input.requestId)
          : input.section === "policy"
            ? policy(view)
            : audit(view);
  return card(
    head(view.name, orgWords("org.split.lead")),
    `${tabs(view, input.section)}${alert(input.refusal)}${note(input.notice)}${content}`,
    true,
  );
}

/** Where a non-admin lands on an admin page: the Account's sentence, and the way back. */
export function organizationRefusedBody(refusal: OrganizationRefusal): string {
  return statusPageBody({
    action: { href: organizationsPortalPath, label: orgWords("org.title") },
    detail: refusal.next ?? "",
    mark: "lock",
    title: refusal.sentence,
    tone: "warn",
  });
}

/** The few rules these pages add to the portal's stylesheet. */
export const organizationStyles = `<style>
.org--wide{width:min(100%,38rem)}
.org .places{margin:0}
.org__section{display:grid;grid-template-columns:minmax(0,1fr);gap:10px}
.org__tabs{display:flex;flex-wrap:wrap;gap:6px}
.org__tab{padding:6px 11px;border:1px solid var(--rim-plate);border-radius:999px;color:var(--muted);font-size:13px;text-decoration:none}
.org__tab[aria-current="page"]{color:var(--text);border-color:var(--rim-accent)}
.org__split{display:grid;gap:12px}
@media (min-width:560px){.org__split{grid-template-columns:1fr 1fr}}
.org__split-title{margin:0;color:var(--text);font-size:13px;font-weight:600}
.org__list{display:grid;gap:6px;margin:6px 0 0;padding:0;list-style:none;color:var(--muted);font-size:13px;line-height:1.45}
.org__list li{position:relative;padding-left:18px}
.org__list li::before{position:absolute;left:0;top:0}
.org__list--can li::before{content:"✓";color:var(--green)}
.org__list--cannot li::before{content:"✕";color:var(--red)}
.org__label{color:var(--muted);font-size:12px;font-weight:600}
.org__left{text-align:left}
.org__price strong{color:var(--text);font-weight:600}
.org__stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(5.5rem,1fr));gap:8px}
.org__stat{display:grid;gap:2px;padding:10px 12px;border:1px solid var(--rim-plate);border-radius:var(--radius-sm)}
.org__stat-value{color:var(--text);font-size:20px;font-weight:600}
.org__stat-label{color:var(--muted);font-size:12px}
.org__inline{display:grid;gap:8px;margin-top:6px}
.org__inline-row{display:grid;grid-template-columns:1fr auto;gap:8px}
.org .place{flex-wrap:wrap}
.org .place__body{flex:1 1 12rem}
.org__row-actions{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.org__row-action{min-height:32px;padding:0 12px;font-size:13px}
.org__confirm{display:grid;gap:8px}
.org__confirm>summary{list-style:none;cursor:pointer}
.org__confirm>summary::-webkit-details-marker{display:none}
.org__confirm[open]{flex-basis:100%}
.org__offboard{padding:12px;border:1px solid var(--rim-plate);border-radius:var(--radius-sm)}
.org__sequence{display:grid;gap:6px;margin:0;padding-left:18px;color:var(--muted);font-size:13px;line-height:1.45}
.org__choices{display:grid;gap:6px;margin:0;padding:0;border:0}
.org__choice,.org__toggle{display:flex;align-items:center;gap:8px;color:var(--text);font-size:13.5px}
.org__switch{display:grid;gap:8px;padding:12px;border:1px solid var(--rim-plate);border-radius:var(--radius-sm)}
.org__switch-text{display:grid;gap:3px}
.org__key{color:var(--muted)}
.field select{flex:1;min-width:0;height:var(--control);padding:0 10px;border:0;background:transparent;color:var(--text);font:inherit;outline:none}
.field select option{background:#151515}
</style>`;
