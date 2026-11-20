import {
  cloudComputerPriceLine,
  cloudComputerReasonNext,
  cloudComputerReasonSentence,
  cloudComputerStepLabel,
  cloudWords,
  orgWords,
  workAuditExcluded,
  workAuditRecordKinds,
  workHomeStatusLabel,
  workPolicyLines,
  type CloudComputerCopyId,
  type CloudComputerDeletion,
  type CloudComputerListResponse,
  type CloudComputerReasonCode,
  type CloudComputerView,
  type WorkHomeResponse,
} from "@opensteer/control-plane-protocol";
import {
  escapeHtml,
  icon,
  statusPageBody,
  type BrowserPageIcon,
} from "@opensteer/shared/browserPage";

/**
 * The Opensteer website's Cloud Computer pages, in the words and order of the apps'
 * Cloud Computer screens. Every page works without a script: forms post, confirmations
 * open in place, and a page still being set up asks the browser to load it again.
 */

export const cloudComputerPortalPath = "/cloud-computer";
export const cloudComputerCheckoutPortalPath = "/cloud-computer/checkout";
export const cloudComputerBillingPortalPath = "/cloud-computer/billing";
export const cloudComputerActionPortalPath = (action: "suspend" | "resume" | "delete") =>
  `/cloud-computer/${action}`;

type Plan = CloudComputerListResponse["plan"];
type Computer = Exclude<CloudComputerView, { status: "deleted" }>;

/** Something the Account said no to, and what the person can do next. */
export interface CloudComputerRefusal {
  readonly sentence: string;
  readonly next: string;
}

/** A work Home an organization assigned this person, as its own card on the page. */
export interface WorkHomeCard {
  readonly assignment: NonNullable<WorkHomeResponse>["assignment"];
  readonly policy: NonNullable<WorkHomeResponse>["policy"];
  /** The Account's own view of its computer, when it is still listed for this person. */
  readonly computer: CloudComputerView | null;
  /** Where to open it, found by its pinned deployment; null until there is one. */
  readonly openHref: string | null;
}

export type CloudComputerLanding =
  | { readonly kind: "signed-out"; readonly plan: Plan; readonly signInHref: string }
  | {
      readonly kind: "offer";
      readonly plan: Plan;
      readonly deleted: boolean;
      readonly deletion?: CloudComputerDeletion;
      readonly work: readonly WorkHomeCard[];
    }
  | {
      readonly kind: "computer";
      readonly plan: Plan;
      readonly computer: Computer;
      readonly openHref: string | null;
      readonly work: readonly WorkHomeCard[];
    };

/**
 * Whether an organization pays for and manages this Cloud Computer, so the person may not
 * bill, suspend, resume or delete it here: its view's work marker when the Account sends
 * one, its "work-managed" reason code, or its id among the person's work Homes.
 */
export function cloudComputerManagedByOrganization(
  computer: CloudComputerView,
  workComputerIds: ReadonlySet<string>,
): boolean {
  return (
    computer.work !== undefined ||
    workComputerIds.has(computer.id) ||
    ("reasonCode" in computer && computer.reasonCode === "cloud-computer-work-managed")
  );
}

/** The Account's reason in the app's own words where it has them, else as the Account gave it. */
export function cloudComputerReason(computer: {
  readonly reason: string;
  readonly reasonCode?: CloudComputerReasonCode | undefined;
}): string {
  return cloudComputerReasonSentence(computer.reasonCode) ?? computer.reason;
}

const points: readonly (readonly [BrowserPageIcon, CloudComputerCopyId, CloudComputerCopyId])[] = [
  ["clock", "cloud.point.awake.title", "cloud.point.awake.detail"],
  ["link", "cloud.point.ip.title", "cloud.point.ip.detail"],
  ["shield", "cloud.point.backup.title", "cloud.point.backup.detail"],
  ["laptop", "cloud.point.mac.title", "cloud.point.mac.detail"],
];

function card(head: string, content: string): string {
  return `<main class="card cloud-computer"><div class="card__head">${head}</div>${content}</main>`;
}

function head(subtitle = cloudWords("cloud.lead")): string {
  return `<span class="device device--large">${icon("server")}</span><h1 class="title">${escapeHtml(cloudWords("cloud.title"))}</h1><p class="lead">${escapeHtml(subtitle)}</p>`;
}

function row(input: {
  readonly icon: BrowserPageIcon;
  readonly title: string;
  readonly detail?: string | null;
  readonly tone?: "ok" | "busy" | "warn" | "muted";
  readonly mono?: boolean;
}): string {
  const dot = input.tone ? `<span class="dot dot--${input.tone}"></span>` : "";
  const detail = input.detail
    ? `<span class="place__note${input.tone === "warn" ? " place__note--warn" : ""}${input.mono ? " mono" : ""}">${escapeHtml(input.detail)}</span>`
    : "";
  return `<li class="place place--still"><span class="device">${icon(input.icon)}${dot}</span><span class="place__body"><span class="place__name">${escapeHtml(input.title)}</span>${detail}</span></li>`;
}

function whatItIs(): string {
  return `<ul class="places">${points
    .map(([mark, title, detail]) =>
      row({ icon: mark, title: cloudWords(title), detail: cloudWords(detail) }),
    )
    .join("")}</ul>`;
}

function price(plan: Plan): string {
  return `<p class="lead cloud-computer__price"><strong>${escapeHtml(cloudComputerPriceLine(plan, "en-US").line)}</strong><br>${escapeHtml(cloudWords("cloud.priceDetail"))}</p>`;
}

function changes(): string {
  return `<h2 class="section-title">${escapeHtml(cloudWords("cloud.changes.title"))}</h2><p class="lead">${escapeHtml(cloudWords("cloud.changes.detail"))}</p>`;
}

function alert(refusal: CloudComputerRefusal | null): string {
  return refusal
    ? `<div class="alert" role="alert"><p class="alert__title">${escapeHtml(refusal.sentence)}</p><p class="lead">${escapeHtml(refusal.next)}</p></div>`
    : "";
}

function note(text: string | null): string {
  return text ? `<p class="lead" role="status">${escapeHtml(text)}</p>` : "";
}

/** `{portal}/cloud-computer`: what it is and its price, or where the person's one stands. */
export function cloudComputerLandingBody(input: {
  readonly state: CloudComputerLanding;
  readonly refusal: CloudComputerRefusal | null;
  readonly notice: string | null;
}): string {
  const { state } = input;
  if (state.kind === "signed-out")
    return card(
      head(),
      `${whatItIs()}${price(state.plan)}${changes()}<a class="btn btn--primary btn--block" href="${escapeHtml(state.signInHref)}">${escapeHtml(cloudWords("cloud.web.signIn"))}</a>`,
    );
  if (state.kind === "offer")
    return card(
      head(),
      `${alert(input.refusal)}${note(input.notice)}${workCards(state.work)}${state.work.length ? `<h2 class="section-title">${escapeHtml(cloudWords("cloud.web.personal"))}</h2>` : ""}${state.deleted ? note(cloudWords("cloud.web.deleted.detail")) : ""}${deletionNotes(state.deletion)}${whatItIs()}${price(state.plan)}${changes()}<a class="btn btn--primary btn--block" href="${cloudComputerCheckoutPortalPath}">${escapeHtml(cloudWords("cloud.checkout"))}</a>`,
    );
  const { computer } = state;
  if (computer.status === "preparing")
    return card(
      head(cloudWords("cloud.preparing.title")),
      `${alert(input.refusal)}${preparingSteps(computer)}
      <p class="lead">${escapeHtml(cloudWords("cloud.step.machineDetail"))} ${escapeHtml(cloudWords("cloud.preparing.footer"))}</p>
      <p class="fine">${escapeHtml(cloudWords("cloud.web.preparing.refresh"))}</p>${changes()}${workCards(state.work)}`,
    );
  const managed = cloudComputerManagedByOrganization(
    computer,
    new Set(state.work.map(({ assignment }) => assignment.computerId)),
  );
  const deleting =
    computer.status === "needs_attention" &&
    computer.reasonCode === "cloud-computer-deletion-pending";
  const status =
    computer.status === "ready"
      ? row({ icon: "server", title: cloudWords("cloud.status.running"), tone: "ok" })
      : computer.status === "suspended"
        ? row({
            icon: "server",
            title: cloudWords("cloud.status.suspended"),
            detail: cloudComputerReason(computer),
            tone: "muted",
          })
        : row({
            icon: "server",
            title: cloudWords("cloud.status.attention"),
            detail: cloudComputerReason(computer),
            tone: "warn",
          });
  const address =
    computer.status === "ready"
      ? row({
          icon: "link",
          title: cloudWords("cloud.address"),
          detail: computer.address,
          mono: true,
        })
      : "";
  const egress =
    computer.egress === "assigned"
      ? row({
          icon: "shield",
          title: `${cloudWords("cloud.ip.title")} · ${cloudWords("cloud.ip.assigned")}`,
          detail: cloudWords("cloud.ip.assignedDetail"),
          tone: "ok",
        })
      : computer.egress === "pending"
        ? row({
            icon: "shield",
            title: `${cloudWords("cloud.ip.title")} · ${cloudWords("cloud.ip.pending")}`,
            detail: cloudWords("cloud.ip.pendingDetail"),
            tone: "busy",
          })
        : row({
            icon: "shield",
            title: `${cloudWords("cloud.ip.title")} · ${cloudWords("cloud.ip.paused")}`,
            detail: cloudWords("cloud.ip.pausedDetail"),
            tone: "warn",
          });
  const ready =
    computer.status === "ready"
      ? `<p class="lead cloud-computer__ready">${icon("check")} ${escapeHtml(cloudWords("cloud.ready.title"))}. ${escapeHtml(cloudWords("cloud.web.useIt"))}</p>`
      : "";
  const hidden = `<input type="hidden" name="id" value="${escapeHtml(computer.id)}">`;
  const power = deleting
    ? ""
    : managed
      ? note(cloudWords("cloud.web.managed"))
      : `${
          computer.status === "suspended"
            ? `<form method="post" action="${cloudComputerActionPortalPath("resume")}">${hidden}<button class="btn btn--primary btn--block" type="submit">${escapeHtml(cloudWords("cloud.resume"))}</button></form>`
            : `<details class="cloud-computer__confirm"><summary class="btn btn--block">${escapeHtml(cloudWords("cloud.suspend"))}</summary>
        <p class="lead"><strong>${escapeHtml(cloudWords("cloud.suspend.title"))}</strong> ${escapeHtml(cloudWords("cloud.suspend.body"))}</p>
        <form method="post" action="${cloudComputerActionPortalPath("suspend")}">${hidden}<button class="btn btn--block" type="submit">${escapeHtml(cloudWords("cloud.suspend"))}</button></form></details>`
        }
      <details class="cloud-computer__confirm"${input.refusal?.sentence === cloudWords("cloud.web.typeWord") ? " open" : ""}><summary class="btn btn--block cloud-computer__danger">${escapeHtml(cloudWords("cloud.delete"))}</summary>
        <p class="lead"><strong>${escapeHtml(cloudWords("cloud.delete.title"))}</strong> ${escapeHtml(cloudWords("cloud.delete.body"))}</p>
        <form class="form" method="post" action="${cloudComputerActionPortalPath("delete")}">${hidden}
          <label class="field"><input name="confirm" autocomplete="off" aria-label="${escapeHtml(cloudWords("cloud.delete.typeToConfirm"))}" placeholder="${escapeHtml(cloudWords("cloud.delete.typeToConfirm"))}" required></label>
          <button class="btn btn--danger btn--block" type="submit">${escapeHtml(cloudWords("cloud.delete.confirm"))}</button>
        </form></details>`;
  return card(
    head(),
    `${alert(input.refusal)}${note(input.notice)}${ready}${state.openHref ? `<a class="btn btn--primary btn--block" href="${escapeHtml(state.openHref)}">${escapeHtml(cloudWords("cloud.ready.open"))}</a>` : ""}<ul class="places">${status}${address}${egress}${details(computer)}</ul>
    ${deletionNotes(computer.deletion)}
    <h2 class="section-title">${escapeHtml(cloudWords("cloud.plan.title"))}</h2>
    <p class="lead">${escapeHtml(cloudComputerPriceLine(state.plan, "en-US").line)}${computer.renewsAt ? `<br>${escapeHtml(cloudWords("cloud.renews", { date: day(computer.renewsAt) }))}` : ""}</p>
    ${managed ? "" : `<a class="btn btn--block" href="${cloudComputerBillingPortalPath}">${escapeHtml(cloudWords("cloud.web.manageBilling"))}</a>`}
    <div class="cloud-computer__power">${power}</div>${workCards(state.work)}`,
  );
}

const dayFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
function day(iso: string): string {
  return dayFormat.format(new Date(iso));
}

export function cloudComputerDeletionLines(deletion?: CloudComputerDeletion): string[] {
  if (!deletion) return [];
  return (
    [
      ["cloud.deletion.computer", deletion.computerDestroyedAt],
      ["cloud.deletion.backups", deletion.backupsUnreadableAt],
      ["cloud.deletion.storage", deletion.storedBackupDataRemovedAt],
    ] as const
  ).map(([id, done]) =>
    cloudWords(done ? "cloud.deletion.done" : "cloud.deletion.pending", {
      fact: cloudWords(id),
      date: day(done ?? deletion.requestedAt),
    }),
  );
}

function deletionNotes(deletion?: CloudComputerDeletion): string {
  return cloudComputerDeletionLines(deletion).map(note).join("");
}

function details(computer: CloudComputerView): string {
  const backup = computer.lastBackupAt;
  return `${
    backup
      ? row({
          icon: "clock",
          title: cloudWords("cloud.backup.reported"),
          detail:
            new Intl.DateTimeFormat("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "UTC",
            }).format(new Date(backup)) + " UTC",
        })
      : ""
  }${
    computer.region
      ? row({ icon: "clock", title: cloudWords("cloud.region"), detail: computer.region.label })
      : ""
  }${
    computer.egressAddress
      ? row({
          icon: "shield",
          title: cloudWords("cloud.ip.address"),
          detail: computer.egressAddress,
          mono: true,
        })
      : ""
  }`;
}

const stepStates = {
  done: "done",
  current: "active",
  pending: "pending",
  failed: "failed",
} as const;

/** The Account's preparation steps, or the one honest step when it reports none. */
export function preparingSteps(
  computer: Extract<CloudComputerView, { status: "preparing" }>,
): string {
  if (!computer.steps?.length)
    return `<ol class="steps"><li class="step" data-state="active">${escapeHtml(cloudWords("cloud.step.machine"))}</li><li class="step">${escapeHtml(cloudWords("cloud.step.ready"))}</li></ol>`;
  return `<ol class="steps">${computer.steps
    .map(
      (step) =>
        `<li class="step" data-state="${stepStates[step.state]}">${escapeHtml(cloudComputerStepLabel(step.id))}${step.state === "failed" ? ` · ${escapeHtml(cloudWords("cloud.step.failed"))}` : ""}</li>`,
    )
    .join("")}</ol>`;
}

/** Each work Home as its own card: what the organization decides, and no controls. */
function workCards(work: readonly WorkHomeCard[]): string {
  return work
    .map(({ assignment, policy, computer, openHref }) => {
      const organization = assignment.organizationName;
      const tone =
        assignment.deleted || assignment.signInCut
          ? "muted"
          : assignment.homeStatus === "ready"
            ? "ok"
            : assignment.homeStatus === "needs_attention"
              ? "warn"
              : assignment.homeStatus === "preparing"
                ? "busy"
                : "muted";
      const policyRows = workPolicyLines(policy)
        .map((line) =>
          row({ icon: "shield", title: `${line.title}: ${line.value}`, detail: line.detail }),
        )
        .join("");
      const sees = [
        orgWords("org.work.see.status"),
        orgWords("org.work.see.policy"),
        ...workAuditRecordKinds.map(({ words }) => words),
      ];
      const never = [...workAuditExcluded, orgWords("org.work.see.personal")];
      return `<section class="cloud-computer__work" aria-label="${escapeHtml(orgWords("org.work.title", { organization }))}">
      <h2 class="cloud-computer__work-title"><span class="cloud-computer__badge">${escapeHtml(orgWords("org.work.badge", { organization }))}</span>${escapeHtml(orgWords("org.work.title", { organization }))}</h2>
      <p class="lead">${escapeHtml(orgWords("org.work.managed", { organization }))}</p>
      ${openHref ? `<a class="btn btn--primary btn--block" href="${escapeHtml(openHref)}">${escapeHtml(cloudWords("cloud.ready.open"))}</a>` : ""}
      <ul class="places">${row({
        icon: "server",
        title: workHomeStatusLabel(assignment),
        detail: assignment.reason,
        tone,
      })}${
        assignment.address
          ? row({
              icon: "link",
              title: cloudWords("cloud.address"),
              detail: assignment.address,
              mono: true,
            })
          : ""
      }${computer ? details(computer) : ""}</ul>
      <h3 class="section-title">${escapeHtml(orgWords("org.work.policy", { organization }))}</h3>
      <ul class="places">${policyRows}</ul>
      <details class="cloud-computer__confirm"><summary class="btn btn--block">${escapeHtml(orgWords("org.work.see.title", { organization }))}</summary>
        <p class="lead">${escapeHtml(orgWords("org.work.see.lead", { organization }))}</p>
        <p class="cloud-computer__list-title">${escapeHtml(orgWords("org.work.see.sees", { organization }))}</p>
        <ul class="cloud-computer__list cloud-computer__list--sees">${sees.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        <p class="cloud-computer__list-title">${escapeHtml(orgWords("org.work.see.never", { organization }))}</p>
        <ul class="cloud-computer__list cloud-computer__list--never">${never.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </details>
    </section>`;
    })
    .join("");
}

/** `{portal}/cloud-computer/checkout`: the price once more and one button that buys it. */
export function cloudComputerCheckoutBody(input: {
  readonly plan: Plan;
  readonly requestId: string;
  readonly refusal: CloudComputerRefusal | null;
}): string {
  return card(
    `<span class="device device--large">${icon("server")}</span><h1 class="title">${escapeHtml(cloudWords("cloud.web.checkout.title"))}</h1><p class="lead">${escapeHtml(cloudWords("cloud.web.checkout.detail"))}</p>`,
    `${alert(input.refusal)}${price(input.plan)}${changes()}
    <form method="post" action="${cloudComputerCheckoutPortalPath}"><input type="hidden" name="requestId" value="${escapeHtml(input.requestId)}">
      <div class="actions"><a class="btn" href="${cloudComputerPortalPath}">${escapeHtml(cloudWords("cloud.web.checkout.back"))}</a><button class="btn btn--primary" type="submit">${escapeHtml(cloudWords("cloud.checkout"))}</button></div>
    </form>`,
  );
}

export function cloudComputerUnavailableBody(): string {
  return statusPageBody({
    action: { href: "/", label: "Back" },
    detail: cloudWords("cloud.web.unavailable.detail"),
    mark: "server",
    title: cloudWords("cloud.web.unavailable.title"),
    tone: "warn",
  });
}

/**
 * What to do next after a refusal: from the Account's reason code where it has one, else
 * from the store's error code and sentence.
 */
export function cloudComputerRefusal(
  code: string,
  message: string,
  reason?: string,
): CloudComputerRefusal {
  const known = reason?.startsWith("cloud-computer-")
    ? (reason as CloudComputerReasonCode)
    : undefined;
  const sentence = cloudComputerReasonSentence(known) ?? message;
  const fromReason = cloudComputerReasonNext(known);
  if (fromReason) return { sentence, next: fromReason };
  const next: CloudComputerCopyId =
    code === "unavailable"
      ? "cloud.web.next.unavailable"
      : /checkout in progress/iu.test(message)
        ? "cloud.web.next.inProgress"
        : /already (?:has|have) a Cloud Computer/iu.test(message)
          ? "cloud.web.next.subscribed"
          : /expired/iu.test(message)
            ? "cloud.web.next.expired"
            : "cloud.web.next.other";
  return { sentence, next: cloudWords(next) };
}
