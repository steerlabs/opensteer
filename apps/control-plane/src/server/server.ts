import type { FastifyReply, FastifyRequest } from "fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { HostedOAuthAttemptIdSchema } from "@opensteer/control-plane-protocol";
import type {
  ConnectOperationCompletion,
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
import { escapeHtml, type BrowserPageFonts } from "@opensteer/shared/browserPage";
import { parseForm, requireExactOrigin } from "../portal/browser-http.js";
import { ControlPlaneError } from "./errors.js";
import { loadPageFonts } from "../portal/page-fonts.js";
import {
  accountFrontDoorBody,
  authorizationRestartBody,
  consentBody,
  errorPageBody,
  sendBrowserPage,
  signInBody,
} from "../portal/pages.js";
import { registerControlPlaneRoutes, toWebHeaders } from "../portal/routes.js";
import { registerNotificationRoutes } from "../notifications/notification-routes.js";
import type { ControlPlaneNotificationStore } from "../notifications/notification-store.js";
import { AccountDeletionService } from "../account/account-deletion.js";
import type { ConnectLifecycleService } from "../account/connect-lifecycle.js";
import type { AppleSignInConfig } from "../auth/apple-sign-in.js";
import { createPortalRouter, type PortalRouter } from "../portal/portal.js";
import type { PortalSessionStore } from "../portal/portal-sessions.js";
import type { ControlPlaneStore } from "../database/store.js";
import type { PersonalRemoteAccountService } from "../account/personal-remote-account.js";
import type { TeamIdentityGrantService } from "../account/team-identity-grants.js";
import {
  hostedOAuthLaunchReturnTo,
  registerHostedOAuthBrokerRoutes,
} from "../auth/hosted-oauth-broker-routes.js";
import type { HostedOAuthBrokerService } from "../auth/hosted-oauth-broker-service.js";
import type { HostedTeamStore } from "../hosted-teams/hosted-team-store.js";
import { registerHostedTeamProvisionerRoutes } from "../hosted-teams/provisioner-routes.js";
import { registerHostedTeamAccountRoutes } from "../hosted-teams/account-routes.js";

const maxHttpBodyBytes = 1 * 1_024 * 1_024;
/** Every response from both vhosts, so no Opensteer hostname is ever downgraded. */
const strictTransportSecurity = "max-age=31536000; includeSubDomains";
const UiFormSchema = z
  .strictObject({
    oauth_query: z.string().max(maximumOAuthQueryLength).optional(),
    switch_account: z.literal("1").optional(),
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
    readonly appleSignIn?: AppleSignInConfig;
    readonly auth: ControlPlaneAuth;
    readonly authenticator: ControlPlaneAuthenticator;
    readonly connectLifecycle: ConnectLifecycleService;
    readonly hostedOAuthBroker?: HostedOAuthBrokerService;
    /** Teams Opensteer hosts, and the check that admits only their provisioner. */
    readonly hostedTeams?: {
      readonly store: HostedTeamStore;
      readonly verifyProvisioner: (authorization: string | undefined) => Promise<void>;
      /** Wakes Account's setup of teams whose Host just started. */
      readonly kickBootstrap?: () => void;
    };
    readonly desktopDownloadUrl?: string;
    readonly iosAppUrl?: string;
    readonly androidAppUrl?: string;
    readonly portalOrigin: URL;
    readonly notifications?: ControlPlaneNotificationStore;
    readonly notificationPlatforms?: readonly NotificationDevicePlatform[];
    readonly publicOrigin: URL;
    readonly personalRemoteAccount?: PersonalRemoteAccountService;
    readonly portalSessions?: PortalSessionStore;
    readonly store: ControlPlaneStore;
    readonly teamIdentityGrants?: TeamIdentityGrantService;
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

  const pageFonts = loadPageFonts();
  const fonts = pageFonts.hrefs;

  const sendErrorPage = (
    request: FastifyRequest,
    reply: FastifyReply,
    failure: { readonly message: string; readonly status: number },
  ) => {
    const page = errorPageBody({
      // Every failure has a way on: the portal when this process runs one,
      // otherwise the Account's own front door.
      back: portal
        ? {
            href: portal.ownsRequest(request) ? "/" : `${portal.origin.origin}/`,
            label: "Go to your Opensteers",
          }
        : { href: "/", label: "Go to Opensteer Account" },
      ...failure,
    });
    void reply
      .status(failure.status)
      .send(sendBrowserPage(reply, { body: page.body, fonts, layout: "plain", title: page.title }));
  };

  app.setNotFoundHandler((request, reply) => {
    if (isPageNavigation(request)) {
      sendErrorPage(request, reply, { message: "Route was not found", status: 404 });
      return;
    }
    // Fastify's own answer, unchanged for API callers.
    void reply.status(404).send({
      error: "Not Found",
      message: `Route ${request.method}:${request.url} not found`,
      statusCode: 404,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeHttpError(error);
    if (normalized.status >= 500) request.log.error({ err: error }, "request failed");
    if (isPageNavigation(request)) {
      sendErrorPage(request, reply, normalized);
      return;
    }
    void reply.status(normalized.status).send({
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.reason ? { reason: normalized.reason } : {}),
        ...(normalized.completedOperation
          ? { completedOperation: normalized.completedOperation }
          : {}),
      },
    });
  });

  // This process serves two hostnames. The Account host is the authorization
  // server and nothing else; the explicit portal origin is the web portal.
  // Which one answered a request is decided by its Host header, before any
  // request is rewritten onto the Account public origin. The machine API under
  // /v1 and /healthz belongs to neither browser vhost and stays host-agnostic.
  const accountDeletion = new AccountDeletionService({
    ...(dependencies.appleSignIn ? { appleSignIn: dependencies.appleSignIn } : {}),
    auth: dependencies.auth,
    connectLifecycle: dependencies.connectLifecycle,
    ...(dependencies.hostedTeams ? { hostedTeams: dependencies.hostedTeams.store } : {}),
    store: dependencies.store,
  });
  const portal = dependencies.portalSessions
    ? createPortalRouter({
        accountDeletion,
        auth: dependencies.auth,
        ...(dependencies.iosAppUrl ? { iosAppUrl: dependencies.iosAppUrl } : {}),
        ...(dependencies.androidAppUrl ? { androidAppUrl: dependencies.androidAppUrl } : {}),
        ...(dependencies.desktopDownloadUrl
          ? { desktopDownloadUrl: dependencies.desktopDownloadUrl }
          : {}),
        fonts,
        ...(dependencies.hostedTeams ? { hostedTeams: dependencies.hostedTeams.store } : {}),
        portalOrigin: dependencies.portalOrigin,
        portalSessions: dependencies.portalSessions,
        ...(dependencies.personalRemoteAccount
          ? { personalRemoteAccount: dependencies.personalRemoteAccount }
          : {}),
        publicOrigin: dependencies.publicOrigin,
        store: dependencies.store,
      })
    : undefined;
  registerTransportSecurity(app);

  app.get("/healthz", async () => ({ ok: true }));
  pageFonts.register(app);
  registerControlPlaneRoutes(app, { ...dependencies, accountDeletion });
  registerNotificationRoutes(app, dependencies);
  if (dependencies.hostedTeams) {
    registerHostedTeamProvisionerRoutes(app, {
      hostedTeams: dependencies.hostedTeams.store,
      verifyProvisioner: dependencies.hostedTeams.verifyProvisioner,
      ...(dependencies.hostedTeams.kickBootstrap
        ? { kickBootstrap: dependencies.hostedTeams.kickBootstrap }
        : {}),
    });
    registerHostedTeamAccountRoutes(app, {
      authenticator: dependencies.authenticator,
      hostedTeams: dependencies.hostedTeams.store,
    });
  }
  if (dependencies.hostedOAuthBroker) {
    registerHostedOAuthBrokerRoutes(app, {
      ...(dependencies.appleSignIn ? { appleSignIn: true } : {}),
      authenticator: dependencies.authenticator,
      auth: dependencies.auth,
      broker: dependencies.hostedOAuthBroker,
      fonts,
      store: dependencies.store,
    });
  }
  registerAccountPages(app, { ...dependencies, fonts }, portal);
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
    readonly appleSignIn?: AppleSignInConfig;
    readonly auth: ControlPlaneAuth;
    readonly fonts: BrowserPageFonts;
    readonly hostedOAuthBroker?: HostedOAuthBrokerService;
    readonly publicOrigin: URL;
    readonly store: ControlPlaneStore;
  },
  portal: PortalRouter | undefined,
): void {
  const { auth, fonts, publicOrigin, store } = dependencies;
  const sendAccountPage = (reply: FastifyReply, title: string, body: string) =>
    sendBrowserPage(reply, { body, fonts, layout: "card", title });
  const sendAuthorizationRestartPage = (reply: FastifyReply) =>
    sendBrowserPage(reply.code(400), {
      body: authorizationRestartBody(),
      fonts,
      layout: "plain",
      title: "Start authorization again",
    });
  const requireAccountHost = accountHostGuard(portal);
  app.get("/", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    if (portal?.ownsRequest(request)) return portal.home(request, reply);
    if (portal) return reply.redirect(`${portal.origin.origin}/`, 302);
    return sendAccountPage(reply, "Opensteer Account", accountFrontDoorBody());
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
      reauthorization ? "Confirm it’s you · Opensteer" : "Sign in · Opensteer",
      signInBody({
        hiddenFields: returnTo
          ? `<input type="hidden" name="return_to" value="${escapeHtml(returnTo.toString())}">`
          : `<input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">`,
        reauthorization,
        ...(dependencies.appleSignIn ? { appleSignIn: true } : {}),
        ...(returnTo ? { hostedOAuth: true } : {}),
      }),
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

  const signInWith =
    (provider: "apple" | "google") => async (request: FastifyRequest, reply: FastifyReply) => {
      requireAccountHost(request);
      void reply.header("cache-control", "no-store");
      requireExactOrigin(request, publicOrigin.origin);
      const form = UiFormSchema.parse(parseForm(request.body));
      const returnTo = hostedOAuthLaunchReturnTo(form.return_to, publicOrigin);
      if (form.switch_account) {
        if (!returnTo || !dependencies.hostedOAuthBroker)
          throw new ControlPlaneError("bad_request", "Hosted OAuth sign-in return is invalid");
        const attemptId = HostedOAuthAttemptIdSchema.parse(returnTo.pathname.split("/").at(-1));
        const inspection = await dependencies.hostedOAuthBroker.inspectLaunch(
          attemptId,
          returnTo.searchParams.get("ticket")!,
        );
        if (inspection.status !== "ready" || inspection.finish === "app")
          throw new ControlPlaneError("bad_request", "Hosted OAuth sign-in return is invalid");
        const signedOut = await callAuth(auth, request, publicOrigin, "/sign-out", {});
        copySetCookies(reply, signedOut);
        if (!signedOut.ok) throw new ControlPlaneError("unauthorized", "Sign out failed");
      }
      const body = {
        provider,
        ...(form.switch_account && provider === "google"
          ? { additionalParams: { prompt: "select_account" } }
          : {}),
        callbackURL: returnTo?.toString() ?? publicOrigin.origin,
        ...(form.oauth_query ? { oauth_query: form.oauth_query } : {}),
      };
      const response = await callAuth(
        auth,
        request,
        publicOrigin,
        "/sign-in/social",
        body,
        Boolean(form.switch_account),
      );
      copySetCookies(reply, response);
      const payload = AuthRedirectResponseSchema.parse(await response.json());
      if (!response.ok || !payload.url) {
        throw new ControlPlaneError("unauthorized", "Sign-in could not be started");
      }
      return reply.redirect(payload.url);
    };
  app.post("/sign-in/google", signInWith("google"));
  if (dependencies.appleSignIn) app.post("/sign-in/apple", signInWith("apple"));

  app.get("/consent", async (request, reply) => {
    requireAccountHost(request);
    const oauthQuery = rawQuery(request.url);
    const presentation = accountConsentPresentation(oauthQuery);
    if (!presentation) return sendAuthorizationRestartPage(reply);
    const [session, client] = await Promise.all([
      auth.api.getSession({ headers: toWebHeaders(request.headers) }).catch(() => null),
      store.oauthClientPresentation(presentation.clientId),
    ]);
    return sendAccountPage(
      reply,
      "Allow access · Opensteer",
      consentBody({
        account: session
          ? { displayName: session.user.name.trim() || null, email: session.user.email }
          : null,
        client,
        grants: presentation.grants,
        oauthQuery,
      }),
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
  omitCookies = false,
): Promise<Response> {
  const headers = toWebHeaders(request.headers);
  if (omitCookies) headers.delete("cookie");
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
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
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

function registerTransportSecurity(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    void reply.header("strict-transport-security", strictTransportSecurity);
    return payload;
  });
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

/**
 * A person's browser opening a page, as opposed to a script or an API client
 * asking for data: it gets a page back when something fails.
 */
function isPageNavigation(request: FastifyRequest): boolean {
  const mode = request.headers["sec-fetch-mode"];
  if (mode !== undefined) return mode === "navigate";
  return (request.headers.accept ?? "").startsWith("text/html");
}

function normalizeHttpError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly reason?: ControlPlaneErrorReason;
  readonly completedOperation?: ConnectOperationCompletion;
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
      ...(error.completedOperation ? { completedOperation: error.completedOperation } : {}),
      status: error.status,
    };
  }
  return { code: "internal", message: "Internal server error", status: 500 };
}

function rawQuery(url: string): string {
  const marker = url.indexOf("?");
  return marker === -1 ? "" : url.slice(marker + 1);
}
