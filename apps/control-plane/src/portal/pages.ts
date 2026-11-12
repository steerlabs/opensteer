import {
  avatar,
  brandLockup,
  brandMark,
  bridge,
  escapeHtml,
  appleMark,
  googleMark,
  icon,
  renderBrowserPage,
  statusPageBody,
  type BrowserPageFonts,
  type BrowserPageLayout,
} from "@opensteer/shared/browserPage";
import type { FastifyReply } from "fastify";
import type { ConsentGrant } from "../account/account-oauth.js";

/**
 * Every page either vhost of this process renders. Routes decide *which* page
 * and with what facts; the words and markup of each moment live here, so the
 * Account host and the portal read as one product.
 *
 * The policy allows the inline stylesheet and this origin's own fonts, and
 * nothing else. A page that needs a script passes its own policy with a nonce.
 */
export const browserPageContentSecurityPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'";

export function browserPagePolicyWithScript(nonce: string, extra: readonly string[] = []): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "font-src 'self'",
    ...extra,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function sendBrowserPage(
  reply: FastifyReply,
  page: {
    readonly body: string;
    readonly fonts: BrowserPageFonts | undefined;
    readonly layout: BrowserPageLayout;
    readonly policy?: string;
    /** An origin the page's one action is about to need. */
    readonly preconnect?: string;
    readonly title: string;
  },
): string {
  void reply
    .header("cache-control", "no-store")
    .header("content-security-policy", page.policy ?? browserPageContentSecurityPolicy)
    .header("x-content-type-options", "nosniff")
    .type("text/html; charset=utf-8");
  return renderBrowserPage({
    body: page.body,
    layout: page.layout,
    title: page.title,
    ...(page.fonts ? { fonts: page.fonts } : {}),
    ...(page.preconnect ? { preconnect: page.preconnect } : {}),
  });
}

/* ---- Account host: authentication moments ---- */

export function accountFrontDoorBody(): string {
  return card({
    head: `${brandMark()}<h1 class="title">Opensteer Account</h1>`,
    content: `<a class="btn btn--primary btn--block" href="/sign-in">Sign in</a>`,
  });
}

export function signInBody(input: {
  readonly hiddenFields: string;
  readonly reauthorization: boolean;
  readonly hostedOAuth?: boolean;
  readonly appleSignIn?: boolean;
}): string {
  const apple = input.appleSignIn
    ? `<form method="post" action="/sign-in/apple">${input.hiddenFields}<button class="btn btn--block btn--apple" type="submit">${appleMark()}Continue with Apple</button></form>`
    : "";
  return card({
    head: `${brandMark()}<h1 class="title">${input.reauthorization ? "Confirm it’s you" : "Sign in to Opensteer"}</h1>`,
    content: `${input.hostedOAuth ? '<p class="lead">Use the Opensteer Account linked to that Opensteer to continue connecting.</p>' : ""}<div class="sign-in-options">${apple}<form method="post" action="/sign-in/google">${input.hiddenFields}<button class="btn btn--block" type="submit">${googleMark()}Continue with Google</button></form></div>`,
  });
}

export function consentBody(input: {
  readonly account: AccountIdentity | null;
  readonly client: { readonly name: string | null; readonly official: boolean };
  readonly grants: readonly ConsentGrant[];
  readonly oauthQuery: string;
}): string {
  const who = input.account
    ? avatar(input.account.displayName ?? input.account.email, "large")
    : `<span class="device device--large">${icon("person")}</span>`;
  const asking = input.client.name ?? "this app";
  // Opensteer's mark vouches for Opensteer's own apps only; anything else
  // asks under its own name beside a plain server.
  const app = input.client.official
    ? `<span class="device device--large device--app">${brandMark("small")}</span>`
    : `<span class="device device--large">${icon("server")}</span>`;
  return card({
    head: `${bridge({
      from: app,
      knot: "chevron",
      to: who,
      ...(input.client.name ? { fromCaption: input.client.name } : {}),
      ...(input.account ? { toCaption: input.account.email } : {}),
    })}<h1 class="title">Allow ${escapeHtml(asking)}?</h1>`,
    content: `<ul class="grants" aria-label="${escapeHtml(asking)} will be able to">${input.grants
      .map(
        (grant) =>
          `<li class="grant${grant.danger ? " grant--danger" : ""}">${icon(grant.icon)}${escapeHtml(grant.text)}</li>`,
      )
      .join("")}</ul>
      <form method="post" action="/consent"><input type="hidden" name="oauth_query" value="${escapeHtml(input.oauthQuery)}">
        <div class="actions"><button class="btn" type="submit" name="decision" value="deny">Deny</button><button class="btn btn--primary" type="submit" name="decision" value="accept">Allow</button></div>
      </form>`,
  });
}

export function authorizationRestartBody(): string {
  return statusPageBody({
    detail: "Go back to the Opensteer app you came from and sign in again.",
    mark: "clock",
    title: "That request expired",
    tone: "warn",
  });
}

/* ---- Portal: the signed-out front door and the list of Opensteers ---- */

export interface AccountIdentity {
  readonly displayName: string | null;
  readonly email: string;
}

export function signedOutBody(input: {
  readonly ended: boolean;
  readonly desktopDownloadUrl?: string;
  readonly signInHref: string;
}): string {
  return card({
    head: `${brandMark()}<h1 class="title">${input.ended ? "You’re signed out" : "Opensteer"}</h1>`,
    content: `<a class="btn btn--primary btn--block" href="${escapeHtml(input.signInHref)}">Sign in</a>${input.desktopDownloadUrl ? `<ul class="places"><li class="place place--add"><span class="device">${icon("download")}</span><span class="place__body"><a class="place__name" href="${escapeHtml(input.desktopDownloadUrl)}">Get the desktop app</a></span></li></ul>` : ""}`,
  });
}

export function openPhoneBody(input: {
  readonly nonce: string;
  readonly scheme: string;
  readonly iosAppUrl?: string;
  readonly androidAppUrl?: string;
}): string {
  const stores = [
    input.iosAppUrl && `<a href="${escapeHtml(input.iosAppUrl)}">Get it for iPhone</a>`,
    input.androidAppUrl && `<a href="${escapeHtml(input.androidAppUrl)}">Get it for Android</a>`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${card({
    head: `${brandMark()}<h1 class="title">Open Opensteer on this phone</h1>`,
    content: `<a id="open-app" class="btn btn--primary btn--block" hidden>Open in Opensteer</a><p id="incomplete" class="fine" hidden>This link is incomplete. Scan the code on your computer again.</p>${stores ? `<p class="fine">${stores}</p>` : ""}<p class="fine">Already installed? Scan the code again after installing.</p>`,
  })}<script nonce="${escapeHtml(input.nonce)}">
    const match = /^#d=(dep_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(location.hash);
    if (match) {
      const destination = ${JSON.stringify(input.scheme + ":/open?d=")} + match[1];
      const button = document.getElementById("open-app");
      button.href = destination;
      button.hidden = false;
      location.href = destination;
    } else {
      document.getElementById("incomplete").hidden = false;
    }
  </script>`;
}

export function portalRestartBody(signInHref: string): string {
  return statusPageBody({
    action: { href: signInHref, label: "Start again" },
    detail: "It expired, or it started in another browser.",
    mark: "clock",
    title: "That sign-in didn’t finish",
    tone: "warn",
  });
}

export function deleteAccountBody(input: {
  readonly action: string;
  readonly computers: readonly string[];
  readonly email: string;
  readonly failed: boolean;
  readonly servers: readonly { readonly name: string; readonly otherMembers: number }[];
}): string {
  const list = (items: readonly string[]) =>
    `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const computers = input.computers.length
    ? `<p class="lead">These computers lose remote access and leave your Account. Opensteer keeps running on them, with their files and conversations. Apps connected through Opensteer’s sign-in will need reconnecting.</p>${list(input.computers)}`
    : "";
  const servers = input.servers.length
    ? `<p class="lead">These servers stop accepting Opensteer Account sign-in, for you and anyone else who uses them.</p>${list(
        input.servers.map(({ name, otherMembers }) =>
          otherMembers === 0
            ? name
            : `${name} (${otherMembers} other ${otherMembers === 1 ? "person" : "people"})`,
        ),
      )}`
    : "";
  const failed = input.failed
    ? `<p class="lead" role="alert">Your Account wasn’t deleted. Remote access may already be off on these computers. Try again, or turn it back on from each computer.</p>`
    : "";
  return card({
    head: `${brandMark()}<h1 class="title">Delete your Opensteer Account?</h1>`,
    content: `<p class="lead">This permanently deletes ${escapeHtml(input.email)}. It can’t be undone.</p>${failed}${computers}${servers}
      <form method="post" action="${escapeHtml(input.action)}"><div class="actions"><a class="btn" href="/">Keep Account</a><button class="btn btn--danger" type="submit">Delete Account</button></div></form>`,
  });
}

export function accountDeletedBody(): string {
  return statusPageBody({
    detail: "You can close this window.",
    mark: "check",
    title: "Your Opensteer Account is deleted",
    tone: "ok",
  });
}

export function differentAccountBody(retryHref: string): string {
  return statusPageBody({
    action: { href: retryHref, label: "Try again" },
    detail: "Nothing was deleted. Sign in with the Account you want to delete.",
    mark: "person",
    title: "That’s a different Account",
    tone: "warn",
  });
}

export function portalHomeBody(input: {
  readonly account: AccountIdentity;
  readonly desktopDownloadUrl: string | null;
  readonly deleteAccountHref: string;
  readonly rows: readonly string[];
  readonly signOutAction: string;
}): string {
  const { account } = input;
  const label = account.displayName ?? account.email;
  const masthead = `<header class="masthead">${brandLockup()}
    <button class="account-btn needs-popover" type="button" popovertarget="account-menu" aria-label="Account, ${escapeHtml(account.email)}">${avatar(label)}</button>
    <div class="menu" id="account-menu" popover>
      <div class="menu__who">${avatar(label)}<span>${account.displayName ? `<strong>${escapeHtml(account.displayName)}</strong>` : ""}<small>${escapeHtml(account.email)}</small></span></div>
      <form method="post" action="${escapeHtml(input.signOutAction)}"><button class="menu__item" type="submit">${icon("signOut")}Sign out</button></form>
      <a class="menu__item" href="${escapeHtml(input.deleteAccountHref)}">${icon("trash")}Delete Account</a>
    </div>
  </header>`;
  // Without the popover API the menu cannot open, so sign-out stays reachable
  // as a plain control instead.
  const fallbackSignOut = `<form class="fallback-only" method="post" action="${escapeHtml(input.signOutAction)}"><button class="btn" type="submit">Sign out</button></form>`;
  if (input.rows.length === 0) {
    return `${masthead}<main class="column"><div class="empty">
      <span class="device">${icon("laptop")}</span>
      <h1 class="title title--page">Set up Opensteer</h1>
      <p class="lead">Opensteers you set up or join show up here.</p>
      ${input.desktopDownloadUrl ? `<a class="btn btn--primary" href="${escapeHtml(input.desktopDownloadUrl)}">${icon("download")}Get the desktop app</a>` : ""}
    </div>${fallbackSignOut}</main>`;
  }
  const download = input.desktopDownloadUrl
    ? `<li class="place place--add"><span class="device">${icon("download")}</span><span class="place__body"><a class="place__name" href="${escapeHtml(input.desktopDownloadUrl)}">Get the desktop app</a></span></li>`
    : "";
  return `${masthead}<main class="column">
    <h1 class="title title--page">Your Opensteers</h1>
    <ul class="places">${input.rows.join("")}${download}</ul>
    ${fallbackSignOut}
  </main>`;
}

export type PlaceControl =
  | { readonly kind: "link"; readonly href: string }
  | { readonly kind: "none" }
  | { readonly kind: "post"; readonly action: string };

export interface PlaceStatus {
  readonly label: string;
  readonly reason: string | null;
  readonly tone: "busy" | "muted" | "ok" | "warn";
}

/**
 * One Opensteer: what it runs on, drawn, with a dot for whether it can be
 * opened now. Words appear only when something is wrong and say what to do.
 * The name is the row's one control, and its hit area covers the row, so the
 * accessible name stays the name rather than every word on the row.
 */
export function placeRow(input: {
  readonly control: PlaceControl;
  readonly id: string;
  readonly kind: "personal" | "team";
  readonly kindLabel: string;
  readonly name: string;
  readonly remove: { readonly action: string } | null;
  readonly status: PlaceStatus | null;
}): string {
  const name = escapeHtml(input.name);
  const open = input.control.kind !== "none";
  const control =
    input.control.kind === "post"
      ? `<form method="post" action="${escapeHtml(input.control.action)}"><button class="place__name" type="submit">${name}</button></form>`
      : input.control.kind === "link"
        ? `<a class="place__name" href="${escapeHtml(input.control.href)}">${name}</a>`
        : `<span class="place__name">${name}</span>`;
  const { status } = input;
  const dot = status ? `<span class="dot dot--${status.tone}"></span>` : "";
  const note = status?.reason
    ? `<span class="place__note${status.tone === "warn" ? " place__note--warn" : ""}">${escapeHtml(status.reason)}</span>`
    : "";
  const spoken = `<span class="visually-hidden">${escapeHtml(input.kindLabel)}${status ? `, ${escapeHtml(status.label)}` : ""}</span>`;
  const sheetId = `remove-${input.id.replace(/[^\w-]/gu, "")}`;
  const remove = input.remove
    ? `<span class="place__menu needs-popover"><button class="icon-btn" type="button" popovertarget="${sheetId}" aria-label="Remove ${name} from your list">${icon("more")}</button></span>
      <div class="sheet" id="${sheetId}" popover role="dialog" aria-labelledby="${sheetId}-title">
        <h2 class="title" id="${sheetId}-title">Remove ${name}?</h2>
        <p class="lead">It leaves your list. Your access doesn’t change.</p>
        <form class="actions" method="post" action="${escapeHtml(input.remove.action)}"><button class="btn" type="button" popovertarget="${sheetId}" popovertargetaction="hide">Cancel</button><button class="btn btn--danger" type="submit">Remove</button></form>
      </div>`
    : "";
  return `<li class="place ${open ? "place--open" : "place--still"}">
    <span class="device">${icon(input.kind === "personal" ? "laptop" : "server")}${dot}</span>
    <span class="place__body">${control}${note}${spoken}</span>
    ${remove}${open ? `<span class="place__go" aria-hidden="true">${icon("chevron")}</span>` : ""}
  </li>`;
}

/**
 * The step between choosing a Personal Opensteer and arriving in it: a
 * one-use grant posted to that computer's route. The script posts it at once;
 * without scripts the button does.
 */
export function personalHandoffBody(input: {
  readonly action: string;
  readonly deploymentName: string;
  readonly grant: string;
  readonly nonce: string;
}): string {
  return `${card({
    head: `<span class="device device--large">${icon("laptop")}</span><h1 class="title">Opening ${escapeHtml(input.deploymentName)}</h1><span class="spinner" aria-hidden="true"></span>`,
    content: `<form id="personal-connect-handoff" method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="grant" value="${escapeHtml(input.grant)}"><noscript><button class="btn btn--primary btn--block" type="submit">Continue</button></noscript></form>`,
  })}<script nonce="${escapeHtml(input.nonce)}">document.getElementById("personal-connect-handoff").submit()</script>`;
}

/**
 * The popup a Personal Host opens to join this Account. The computer names
 * itself over `postMessage`; until it does, the page waits. Every later state
 * is drawn by the script toggling `data-state` and the `[data-when]` parts.
 */
export function personalLinkBody(input: {
  readonly account: AccountIdentity;
  readonly computerOrigin: string;
  readonly nonce: string;
  readonly script: string;
}): string {
  const host = new URL(input.computerOrigin).host;
  return `${card({
    attributes: ' id="link" data-state="waiting" aria-live="polite"',
    head: `${bridge({
      from: `<span class="device device--large">${icon("laptop")}</span>`,
      fromCaption: host,
      knot: "link",
      to: avatar(input.account.displayName ?? input.account.email, "large"),
      toCaption: input.account.email,
    })}<h1 class="title" id="title">Link this computer</h1>`,
    content: `<button class="btn btn--primary btn--block" id="allow" type="button" disabled data-when="waiting ready linking"><span class="spinner" aria-hidden="true" data-when="waiting linking"></span>Link</button>
      <p class="fine" data-when="linked" hidden>You can close this window.</p>
      <p class="fine" data-when="failed" hidden>Start again from Opensteer.</p>
      <p class="fine" data-when="orphan" hidden>Open this from Opensteer’s Settings.</p>`,
  })}<script nonce="${escapeHtml(input.nonce)}">${input.script}</script>`;
}

/**
 * What a browser sees when a page request fails, in place of the JSON an API
 * caller gets. The words name what happened from the person's side; a
 * conflict's own message is already written for them.
 */
export function errorPageBody(input: {
  readonly back: { readonly href: string; readonly label: string };
  readonly message: string;
  readonly status: number;
}): { readonly body: string; readonly title: string } {
  const words =
    input.status === 404
      ? { detail: "That page isn’t here.", title: "Nothing here" }
      : input.status === 409
        ? { detail: input.message, title: "Not right now" }
        : input.status === 401
          ? { detail: "Your sign-in ended.", title: "Sign in again" }
          : input.status === 403
            ? { detail: "That came from somewhere this page doesn’t trust.", title: "Not allowed" }
            : input.status === 429
              ? { detail: "Wait a moment, then try again.", title: "Too many tries" }
              : input.status < 500
                ? { detail: "It may be incomplete or out of date.", title: "That link didn’t work" }
                : { detail: "Try again in a moment.", title: "Something went wrong" };
  return {
    body: statusPageBody({
      detail: words.detail,
      mark: "alert",
      title: words.title,
      tone: "warn",
      action: input.back,
    }),
    title: words.title,
  };
}

function card(input: {
  readonly attributes?: string;
  readonly content: string;
  readonly head: string;
}): string {
  return `<main class="card"${input.attributes ?? ""}><div class="card__head">${input.head}</div>${input.content}</main>`;
}
