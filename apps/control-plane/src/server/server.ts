import type { FastifyReply, FastifyRequest } from "fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  ControlPlaneErrorReason,
  NotificationDevicePlatform,
} from "@opensteer/control-plane-protocol";
import { accountConsentPresentation, maximumOAuthQueryLength } from "../account/account-oauth.js";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import {
  controlPlaneAuthPath,
  type ControlPlaneAuth,
  type ControlPlaneAuthenticator,
} from "../auth/auth.js";
import {
  currentSetCookies,
  escapeHtml,
  parseForm,
  requireExactOrigin,
} from "../portal/browser-http.js";
import { ControlPlaneError } from "./errors.js";
import {
  brandMark,
  browserPageContentSecurityPolicy,
  renderBrowserPage,
} from "../portal/page-shell.js";
import { registerControlPlaneRoutes, toWebHeaders } from "../portal/routes.js";
import { registerNotificationRoutes } from "../notifications/notification-routes.js";
import type { ControlPlaneNotificationStore } from "../notifications/notification-store.js";
import type { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import {
  clearPortalHintCookie,
  createPortalRouter,
  portalHintCookie,
  portalHintCookieDomain,
  type PortalRouter,
} from "../portal/portal.js";
import type { PortalSessionStore } from "../portal/portal-sessions.js";
import type { ControlPlaneStore } from "../database/store.js";
import type { PersonalRemoteAccountService } from "../account/personal-remote-account.js";
import {
  hostedOAuthLaunchReturnTo,
  registerHostedOAuthBrokerRoutes,
} from "../auth/hosted-oauth-broker-routes.js";
import { registerCloudDeploymentRoutes } from "../cloud/routes.js";
import type { CloudDeploymentLifecycle } from "../cloud/lifecycle.js";
import type { HostedOAuthBrokerService } from "../auth/hosted-oauth-broker-service.js";

const maxHttpBodyBytes = 1 * 1_024 * 1_024;
/** Every response from both vhosts, so no Opensteer hostname is ever downgraded. */
const strictTransportSecurity = "max-age=31536000; includeSubDomains";
const UiFormSchema = z
  .strictObject({
    oauth_query: z.string().max(maximumOAuthQueryLength).optional(),
    return_to: z.string().min(1).max(262_656).optional(),
  })
  .refine((value) => !(value.oauth_query && value.return_to), {
    message: "Account sign-in has conflicting return targets",
  });
const ConsentFormSchema = z.strictObject({
  decision: z.enum(["accept", "deny"]),
  oauth_query: z.string().min(1).max(maximumOAuthQueryLength),
});

export async function createControlPlaneServer(
  dependencies: {
    readonly auth: ControlPlaneAuth;
    readonly authenticator: ControlPlaneAuthenticator;
    readonly connectLifecycle: ConnectLifecycleService;
    readonly cloudDeployments?: CloudDeploymentLifecycle;
    readonly hostedOAuthBroker?: HostedOAuthBrokerService;
    readonly desktopDownloadUrl?: string;
    readonly managedDeploymentDomain: string;
    readonly notifications?: ControlPlaneNotificationStore;
    readonly notificationPlatforms?: readonly NotificationDevicePlatform[];
    readonly publicOrigin: URL;
    readonly personalRemoteAccount?: PersonalRemoteAccountService;
    readonly portalSessions?: PortalSessionStore;
    readonly store: ControlPlaneStore;
  },
  options: { readonly logger?: boolean | Record<string, unknown> } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: maxHttpBodyBytes,
    // OAuth callbacks carry one-use codes and opaque state in the URL. Request-line logging is
    // disabled for the whole narrow Account process so no logger configuration can capture them.
    disableRequestLogging: true,
    logger: options.logger ?? false,
    requestIdHeader: false,
  });
  app.addContentTypeParser(
    ["application/octet-stream", "application/x-www-form-urlencoded", "text/plain"],
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeHttpError(error);
    if (normalized.status >= 500) request.log.error({ err: error }, "request failed");
    void reply.status(normalized.status).send({
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.reason ? { reason: normalized.reason } : {}),
      },
    });
  });

  // This process serves two hostnames. The Account host is the authorization
  // server and nothing else; the managed-Deployment apex is the web portal.
  // Which one answered a request is decided by its Host header, before any
  // request is rewritten onto the Account public origin. The machine API under
  // /v1 and /healthz belongs to neither browser vhost and stays host-agnostic.
  const portal = dependencies.portalSessions
    ? createPortalRouter({
        auth: dependencies.auth,
        ...(dependencies.cloudDeployments
          ? { cloudDeployments: dependencies.cloudDeployments }
          : {}),
        ...(dependencies.desktopDownloadUrl
          ? { desktopDownloadUrl: dependencies.desktopDownloadUrl }
          : {}),
        managedDeploymentDomain: dependencies.managedDeploymentDomain,
        portalSessions: dependencies.portalSessions,
        ...(dependencies.personalRemoteAccount
          ? { personalRemoteAccount: dependencies.personalRemoteAccount }
          : {}),
        publicOrigin: dependencies.publicOrigin,
        store: dependencies.store,
      })
    : undefined;
  // Better Auth owns the wire name of its session cookie, prefixes included,
  // so the hint follows whatever it actually writes rather than a guess.
  const accountSessionCookie = (await dependencies.auth.$context).authCookies.sessionToken.name;
  registerTransportSecurity(app, dependencies, portal, accountSessionCookie);

  app.get("/healthz", async () => ({ ok: true }));
  registerControlPlaneRoutes(app, dependencies);
  registerCloudDeploymentRoutes(app, dependencies);
  registerNotificationRoutes(app, dependencies);
  if (dependencies.hostedOAuthBroker) {
    registerHostedOAuthBrokerRoutes(app, {
      authenticator: dependencies.authenticator,
      broker: dependencies.hostedOAuthBroker,
      store: dependencies.store,
    });
  }
  registerAccountPages(app, dependencies, portal);
  portal?.register(app);

  const requireAccountHost = accountHostGuard(portal);
  const authorizationMetadata = oauthProviderAuthServerMetadata(dependencies.auth);
  const oidcMetadata = oauthProviderOpenIdConfigMetadata(dependencies.auth);
  app.get("/.well-known/oauth-authorization-server", async (request, reply) => {
    requireAccountHost(request);
    return sendWebResponse(
      reply,
      await authorizationMetadata(toFetchRequest(request, dependencies.publicOrigin)),
    );
  });
  app.get("/.well-known/openid-configuration", async (request, reply) => {
    requireAccountHost(request);
    return sendWebResponse(
      reply,
      await oidcMetadata(toFetchRequest(request, dependencies.publicOrigin)),
    );
  });

  const authHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    requireAccountHost(request);
    assertAuthorizeRequestSecurity(request, dependencies.publicOrigin);
    const response = await dependencies.auth.handler(
      toFetchRequest(request, dependencies.publicOrigin),
    );
    void reply.header("cache-control", "no-store");
    return sendWebResponse(reply, response);
  };
  app.all(controlPlaneAuthPath, authHandler);
  app.all(`${controlPlaneAuthPath}/*`, authHandler);
  await app.ready();
  return app;
}

/** Account routes exist on the Account host alone; the apex is the portal's. */
function accountHostGuard(portal: PortalRouter | undefined): (request: FastifyRequest) => void {
  return (request) => {
    if (portal?.ownsRequest(request)) {
      throw new ControlPlaneError("not_found", "Route was not found");
    }
  };
}

/**
 * The Account host serves authentication moments only: the authorization
 * server, its sign-in page, and its consent page. It is no longer a
 * destination, so its root sends the browser to the portal that is.
 */
function registerAccountPages(
  app: FastifyInstance,
  dependencies: {
    readonly auth: ControlPlaneAuth;
    readonly publicOrigin: URL;
    readonly store: ControlPlaneStore;
  },
  portal: PortalRouter | undefined,
): void {
  const { auth, publicOrigin } = dependencies;
  const requireAccountHost = accountHostGuard(portal);
  app.get("/", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    if (portal?.ownsRequest(request)) return portal.home(request, reply);
    if (portal) return reply.redirect(`${portal.origin.origin}/`, 302);
    return sendAccountPage(
      reply,
      "Opensteer Account",
      `<p class="lead">Your Opensteer Account is where sign-in and Deployment discovery happen.</p>
      <a class="btn btn--primary btn--wide" href="/sign-in">Sign in</a>
      <p class="fine">Every Deployment keeps its own data.</p>`,
    );
  });

  app.get("/sign-in", async (request, reply) => {
    requireAccountHost(request);
    const signInUrl = new URL(request.url, publicOrigin);
    if (signInUrl.searchParams.getAll("return_to").length > 1) {
      throw new ControlPlaneError("bad_request", "Hosted OAuth sign-in return is invalid");
    }
    const returnTo = hostedOAuthLaunchReturnTo(
      signInUrl.searchParams.get("return_to"),
      publicOrigin,
    );
    const oauthQuery = returnTo ? "" : rawQuery(request.url);
    const reauthorization = new Set(
      (new URLSearchParams(oauthQuery).get("prompt") ?? "").split(/\s+/u).filter(Boolean),
    ).has("login");
    return sendAccountPage(
      reply,
      reauthorization ? "Verify your Opensteer Account" : "Sign in to Opensteer",
      `<p class="lead">${
        reauthorization
          ? "Confirm it’s you before this app continues."
          : "Continue with the Google account you use for Opensteer."
      }</p>
      <form method="post" action="/sign-in/google">
        ${
          returnTo
            ? `<input type="hidden" name="return_to" value="${escapeHtml(returnTo.toString())}">`
            : `<input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">`
        }
        <button class="btn btn--primary btn--wide" type="submit">${reauthorization ? "Continue with Google to verify" : "Continue with Google"}</button>
      </form>`,
    );
  });

  app.post("/sign-out", async (request, reply) => {
    requireAccountHost(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, publicOrigin.origin);
    const response = await callAuth(auth, request, publicOrigin, "/sign-out", {});
    copySetCookies(reply, response);
    if (!response.ok) throw new ControlPlaneError("unauthorized", "Sign out failed");
    return reply.redirect("/", 303);
  });

  app.post("/sign-in/google", async (request, reply) => {
    requireAccountHost(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, publicOrigin.origin);
    const form = UiFormSchema.parse(parseForm(request.body));
    const returnTo = hostedOAuthLaunchReturnTo(form.return_to, publicOrigin);
    const body = {
      provider: "google",
      callbackURL: returnTo?.toString() ?? publicOrigin.origin,
      ...(form.oauth_query ? { oauth_query: form.oauth_query } : {}),
    };
    const response = await callAuth(auth, request, publicOrigin, "/sign-in/social", body);
    copySetCookies(reply, response);
    const payload = AuthRedirectResponseSchema.parse(await response.json());
    if (!response.ok || !payload.url) {
      throw new ControlPlaneError("unauthorized", "Google sign-in could not be started");
    }
    return reply.redirect(payload.url);
  });

  app.get("/consent", async (request, reply) => {
    requireAccountHost(request);
    const oauthQuery = rawQuery(request.url);
    const presentation = accountConsentPresentation(oauthQuery);
    if (!presentation) return sendAuthorizationRestartPage(reply);
    return sendAccountPage(
      reply,
      "Authorize Opensteer",
      `<p class="lead">An Opensteer app is asking to use your Account.</p>
      <section class="stack" aria-labelledby="requested-access">
        <p class="eyebrow" id="requested-access">Requested access</p>
        <ul class="permissions">${presentation.permissions
          .map((permission) => `<li>${escapeHtml(permission)}</li>`)
          .join("")}</ul>
      </section>
      <form method="post" action="/consent">
        <input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">
        <div class="actions">
          <button class="btn btn--primary" type="submit" name="decision" value="accept">Allow</button>
          <button class="btn" type="submit" name="decision" value="deny">Deny</button>
        </div>
      </form>`,
    );
  });

  app.post("/consent", async (request, reply) => {
    requireAccountHost(request);
    void reply.header("cache-control", "no-store");
    requireExactOrigin(request, publicOrigin.origin);
    const parsedForm = ConsentFormSchema.safeParse(parseForm(request.body));
    if (!parsedForm.success) return sendAuthorizationRestartPage(reply);
    const form = parsedForm.data;
    if (!accountConsentPresentation(form.oauth_query)) {
      return sendAuthorizationRestartPage(reply);
    }
    const response = await callAuth(auth, request, publicOrigin, "/oauth2/consent", {
      accept: form.decision === "accept",
      oauth_query: form.oauth_query,
    });
    copySetCookies(reply, response);
    if (!response.ok) {
      if (response.status >= 500) {
        throw new ControlPlaneError("internal", "Authorization service failed");
      }
      return sendAuthorizationRestartPage(reply);
    }
    const payload = ConsentRedirectResponseSchema.safeParse(await response.json());
    if (!payload.success) {
      throw new ControlPlaneError("internal", "Authorization service response is invalid");
    }
    return reply.redirect(new URL(payload.data.url, publicOrigin).toString());
  });
}

const AuthRedirectResponseSchema = z.object({ url: z.url().optional() }).passthrough();
const ConsentRedirectResponseSchema = z
  .object({ redirect: z.literal(true), url: z.string().min(1) })
  .passthrough();

async function callAuth(
  auth: ControlPlaneAuth,
  request: FastifyRequest,
  publicOrigin: URL,
  path: string,
  body: unknown,
): Promise<Response> {
  const headers = toWebHeaders(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.set("origin", publicOrigin.origin);
  return auth.handler(
    new Request(new URL(`${controlPlaneAuthPath}${path}`, publicOrigin), {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    }),
  );
}

function toFetchRequest(request: FastifyRequest, publicOrigin: URL, requestUrl?: URL): Request {
  const method = request.method.toUpperCase();
  const headers = toWebHeaders(request.headers);
  const body =
    method === "GET" || method === "HEAD" ? undefined : serializeRequestBody(request.body);
  if (body !== undefined && !Buffer.isBuffer(request.body) && typeof request.body !== "string") {
    headers.delete("content-length");
  }
  return new Request(requestUrl ?? new URL(request.raw.url ?? request.url, publicOrigin), {
    ...(body === undefined ? {} : { body }),
    headers,
    method,
  });
}

function serializeRequestBody(body: unknown) {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

async function sendWebResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  for (const [name, value] of response.headers.entries()) {
    const normalized = name.toLowerCase();
    if (normalized !== "set-cookie" && normalized !== "content-length") {
      void reply.header(name, value);
    }
  }
  copySetCookies(reply, response);
  const bytes = Buffer.from(await response.arrayBuffer());
  return reply.status(response.status).send(bytes);
}

function copySetCookies(reply: FastifyReply, response: Response): void {
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) void reply.header("set-cookie", cookies);
}

/**
 * Adds HSTS to every response, and keeps the portal's presence hint in step
 * with the Account session cookie. Whichever route issues or clears that
 * cookie — the authorization server itself, or the sign-out form in front of
 * it — the hint follows in the same response, so signing out of the Account
 * host is enough to make the portal render its signed-out page immediately.
 */
function registerTransportSecurity(
  app: FastifyInstance,
  dependencies: { readonly managedDeploymentDomain: string; readonly publicOrigin: URL },
  portal: PortalRouter | undefined,
  sessionCookieName: string,
): void {
  const secure = dependencies.publicOrigin.protocol === "https:";
  const hintDomain = portalHintCookieDomain(
    dependencies.publicOrigin,
    dependencies.managedDeploymentDomain,
  );
  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("strict-transport-security", strictTransportSecurity);
    if (!hintDomain || portal?.ownsRequest(request)) return payload;
    const cookies = currentSetCookies(reply);
    const change = accountSessionCookieChange(cookies, sessionCookieName);
    if (change === "unchanged") return payload;
    void reply.header("set-cookie", [
      ...cookies,
      change === "issued"
        ? portalHintCookie(hintDomain, secure)
        : clearPortalHintCookie(hintDomain, secure),
    ]);
    return payload;
  });
}

function accountSessionCookieChange(
  cookies: readonly string[],
  name: string,
): "cleared" | "issued" | "unchanged" {
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator === -1 || cookie.slice(0, separator).trim() !== name) continue;
    const value = cookie.slice(separator + 1).split(";", 1)[0] ?? "";
    return value === "" || /;\s*max-age=0\b/iu.test(cookie) ? "cleared" : "issued";
  }
  return "unchanged";
}

function assertAuthorizeRequestSecurity(request: FastifyRequest, publicOrigin: URL): void {
  const url = new URL(request.raw.url ?? request.url, publicOrigin);
  if (request.method !== "GET" || url.pathname !== `${controlPlaneAuthPath}/oauth2/authorize`) {
    return;
  }
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");
  if (!state || state.length < 16 || state.length > 2_048) {
    throw new ControlPlaneError("bad_request", "OAuth state is required");
  }
  if (
    url.searchParams.get("code_challenge_method") !== "S256" ||
    !challenge ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(challenge)
  ) {
    throw new ControlPlaneError("bad_request", "S256 PKCE is required");
  }
}

function normalizeHttpError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly reason?: ControlPlaneErrorReason;
  readonly status: number;
} {
  if (error instanceof z.ZodError) {
    return { code: "bad_request", message: "Request is invalid", status: 400 };
  }
  if (error instanceof ControlPlaneError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.reason ? { reason: error.reason } : {}),
      status: error.status,
    };
  }
  return { code: "internal", message: "Internal server error", status: 500 };
}

function sendAccountPage(reply: FastifyReply, title: string, content: string): string {
  void reply
    .header("cache-control", "no-store")
    .header("content-security-policy", browserPageContentSecurityPolicy)
    .type("text/html; charset=utf-8");
  return accountPage(title, content);
}

function sendAuthorizationRestartPage(reply: FastifyReply): string {
  return sendAccountPage(
    reply.code(400),
    "Start authorization again",
    `<p class="lead">This authorization request is missing, expired, or meant for a different browser.</p>
    <p class="fine">Return to the Opensteer app you started from and sign in again.</p>`,
  );
}

/**
 * Every Account page is one moment in an authorization flow, so they all wear
 * the same centered card: brand orb, the moment's title, and the one or two
 * controls that moment offers.
 */
function accountPage(title: string, content: string): string {
  return renderBrowserPage({
    body: `${brandMark({ large: true })}<main><h1>${escapeHtml(title)}</h1>${content}</main>`,
    layout: "centered",
    title,
  });
}

function rawQuery(url: string): string {
  const marker = url.indexOf("?");
  return marker === -1 ? "" : url.slice(marker + 1);
}
