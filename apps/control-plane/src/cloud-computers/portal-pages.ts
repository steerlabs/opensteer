import {
  cloudComputerPriceLine,
  cloudWords,
  type CloudComputerCopyId,
  type CloudComputerListResponse,
  type CloudComputerView,
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

export type CloudComputerLanding =
  | { readonly kind: "signed-out"; readonly plan: Plan; readonly signInHref: string }
  | { readonly kind: "offer"; readonly plan: Plan; readonly deleted: boolean }
  | { readonly kind: "computer"; readonly plan: Plan; readonly computer: Computer };

/**
 * Whether an organization pays for and manages this Cloud Computer, so its assignee may
 * not suspend, resume or delete it here. The Account's view does not say yet; until it
 * does this is false and the store's own refusal ("managed by its organization") is what
 * the person sees if they try.
 */
export function cloudComputerManagedByOrganization(_computer: Computer): boolean {
  return false;
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
      `${alert(input.refusal)}${note(input.notice)}${state.deleted ? note(cloudWords("cloud.web.deleted.detail")) : ""}${whatItIs()}${price(state.plan)}${changes()}<a class="btn btn--primary btn--block" href="${cloudComputerCheckoutPortalPath}">${escapeHtml(cloudWords("cloud.checkout"))}</a>`,
    );
  const { computer } = state;
  if (computer.status === "preparing")
    return card(
      head(cloudWords("cloud.preparing.title")),
      `${alert(input.refusal)}<ol class="steps"><li class="step" data-state="active">${escapeHtml(cloudWords("cloud.step.machine"))}</li><li class="step">${escapeHtml(cloudWords("cloud.step.ready"))}</li></ol>
      <p class="lead">${escapeHtml(cloudWords("cloud.step.machineDetail"))} ${escapeHtml(cloudWords("cloud.preparing.footer"))}</p>
      <p class="fine">${escapeHtml(cloudWords("cloud.web.preparing.refresh"))}</p>${changes()}`,
    );
  const managed = cloudComputerManagedByOrganization(computer);
  const status =
    computer.status === "ready"
      ? row({ icon: "server", title: cloudWords("cloud.status.running"), tone: "ok" })
      : computer.status === "suspended"
        ? row({
            icon: "server",
            title: cloudWords("cloud.status.suspended"),
            detail: computer.reason,
            tone: "muted",
          })
        : row({
            icon: "server",
            title: cloudWords("cloud.status.attention"),
            detail: computer.reason,
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
  const power = managed
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
    `${alert(input.refusal)}${note(input.notice)}${ready}<ul class="places">${status}${address}${egress}</ul>
    <h2 class="section-title">${escapeHtml(cloudWords("cloud.plan.title"))}</h2>
    <p class="lead">${escapeHtml(cloudComputerPriceLine(state.plan, "en-US").line)}</p>
    ${managed ? "" : `<a class="btn btn--block" href="${cloudComputerBillingPortalPath}">${escapeHtml(cloudWords("cloud.plan.manage"))}</a>`}
    <div class="cloud-computer__power">${power}</div>`,
  );
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

/** What to do next after a refusal, from the store's code and, where known, its sentence. */
export function cloudComputerRefusal(code: string, message: string): CloudComputerRefusal {
  const next: CloudComputerCopyId =
    code === "unavailable"
      ? "cloud.web.next.unavailable"
      : /checkout in progress/iu.test(message)
        ? "cloud.web.next.inProgress"
        : /already has a Cloud Computer/iu.test(message)
          ? "cloud.web.next.subscribed"
          : /expired/iu.test(message)
            ? "cloud.web.next.expired"
            : "cloud.web.next.other";
  return { sentence: message, next: cloudWords(next) };
}
