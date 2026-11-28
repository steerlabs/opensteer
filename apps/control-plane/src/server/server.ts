import { registerAgentDirectoryRoutes } from "../agent-directory/routes.js";
import type { AgentDirectoryReader } from "../agent-directory/store.js";
import {
  registerCloudComputerRoutes,
  type CloudComputerRouteOptions,
} from "../cloud-computers/routes.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import Fastify, { type FastifyInstance } from "fastify";
import { decodeJwt } from "jose";
import { decodeBasicCredentials } from "@better-auth/core/oauth2";
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
import type { AccountProfiles } from "../account/account-profiles.js";
import {
  hostedOAuthLaunchReturnTo,
  registerHostedOAuthBrokerRoutes,
} from "../auth/hosted-oauth-broker-routes.js";
import type { HostedOAuthBrokerService } from "../auth/hosted-oauth-broker-service.js";

const maxHttpBodyBytes = 1 * 1_024 * 1_024;
const IssuedIdTokenSchema = z.object({ id_token: z.string().min(1) });
const OAuthClientBodySchema = z.object({ client_id: z.string() });
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
const AppReviewFormSchema = UiFormSchema.safeExtend({
  email: z.string().max(320),
  password: z.string().max(4_096),
});
const ConsentFormSchema = z.strictObject({
  decision: z.enum(["accept", "deny"]),
  oauth_query: z.string().min(1).max(maximumOAuthQueryLength),
});

export async function createControlPlaneServer(
  dependencies: {
    readonly appleSignIn?: AppleSignInConfig;
    readonly appReviewSignIn?: boolean;
    readonly auth: ControlPlaneAuth;
    readonly authenticator: ControlPlaneAuthenticator;
    readonly connectLifecycle: ConnectLifecycleService;
    readonly hostedOAuthBroker?: HostedOAuthBrokerService;
    readonly cloudComputers?: CloudComputerRouteOptions;
    readonly agentDirectory?: AgentDirectoryReader;
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
    readonly accountProfiles?: AccountProfiles;
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
        : { href: "/", label: "Go to your Opensteer account" },
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
    ...(dependencies.cloudComputers?.kickBilling
      ? { afterDelete: dependencies.cloudComputers.kickBilling }
      : {}),
    ...(dependencies.appleSignIn ? { appleSignIn: dependencies.appleSignIn } : {}),
    auth: dependencies.auth,
    connectLifecycle: dependencies.connectLifecycle,
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
        ...(dependencies.cloudComputers
          ? { cloudComputers: dependencies.cloudComputers.store }
          : {}),
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
  if (dependencies.agentDirectory) {
    registerAgentDirectoryRoutes(app, {
      agentDirectory: dependencies.agentDirectory,
      auth: dependencies.auth,
      publicOrigin: dependencies.publicOrigin,
    });
  }
  if (dependencies.cloudComputers) {
    registerCloudComputerRoutes(app, {
      ...dependencies.cloudComputers,
      authenticator: dependencies.authenticator,
      authenticateHostCredential: (authorization) =>
        dependencies.store.authenticateHostCredential(authorization),
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
    const url = new URL(request.url, dependencies.publicOrigin);
    const authorize = url.pathname === `${controlPlaneAuthPath}/oauth2/authorize`;
    const token = url.pathname === `${controlPlaneAuthPath}/oauth2/token`;
    const issue = () =>
      dependencies.auth.handler(toFetchRequest(request, dependencies.publicOrigin));
    const formClient =
      (authorize || token) && request.method === "POST"
        ? OAuthClientBodySchema.safeParse(
            Buffer.isBuffer(request.body) || typeof request.body === "string"
              ? parseForm(request.body)
              : request.body,
          ).data?.client_id
        : undefined;
    const basicClient = token ? basicClientId(request.headers.authorization) : undefined;
    const candidates = [
      basicClient,
      formClient,
      authorize ? url.searchParams.get("client_id") : undefined,
    ];
    const clientId = candidates.find((client) => client?.startsWith("occ_"));
    if (clientId && candidates.some((candidate) => candidate && candidate !== clientId))
      throw new ControlPlaneError("bad_request", "Conflicting OAuth client identities");
    const computers = dependencies.cloudComputers?.store;
    const replacement =
      token && request.method === "POST" && clientId
        ? await computers?.pendingReplacementOwnerAccess(clientId)
        : undefined;
    const response = await issue();
    if (computers && clientId && replacement?.accountId && response.ok) {
      const result = IssuedIdTokenSchema.safeParse(await response.clone().json());
      if (result.success) {
        const claims = decodeJwt(result.data.id_token);
        if (
          claims.iss === dependencies.publicOrigin.origin &&
          claims.aud === clientId &&
          claims.sub === replacement.accountId
        ) {
          await computers.recordReplacementOwnerAccess(clientId, replacement);
        }
      }
    }
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
    readonly appReviewSignIn?: boolean;
    readonly auth: ControlPlaneAuth;
    readonly fonts: BrowserPageFonts;
    readonly hostedOAuthBroker?: HostedOAuthBrokerService;
    readonly publicOrigin: URL;
    readonly store: ControlPlaneStore;
  },
  portal: PortalRouter | undefined,
): void {
  const { auth, fonts, publicOrigin, store } = dependencies;
  const appReviewSignIn = dependencies.appReviewSignIn === true;
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
    return sendAccountPage(reply, "Opensteer account", accountFrontDoorBody());
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
    return sendSignInPage(reply, { returnTo, oauthQuery });
  });
  const sendSignInPage = (
    reply: FastifyReply,
    input: { returnTo: URL | null; oauthQuery: string; appReviewFailure?: string },
  ) => {
    const reauthorization = new Set(
      (new URLSearchParams(input.oauthQuery).get("prompt") ?? "").split(/\s+/u).filter(Boolean),
    ).has("login");
    return sendAccountPage(
      reply,
      reauthorization ? "Confirm it’s you · Opensteer" : "Sign in · Opensteer",
      signInBody({
        hiddenFields: input.returnTo
          ? `<input type="hidden" name="return_to" value="${escapeHtml(input.returnTo.toString())}">`
          : `<input type="hidden" name="oauth_query" value="${escapeHtml(input.oauthQuery)}">`,
        reauthorization,
        appReviewSignIn,
        ...(input.appReviewFailure ? { appReviewFailure: input.appReviewFailure } : {}),
        ...(dependencies.appleSignIn ? { appleSignIn: true } : {}),
        ...(input.returnTo ? { hostedOAuth: true } : {}),
      }),
    );
  };

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
    (provider: "apple" | "google" | "app-review") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireAccountHost(request);
      void reply.header("cache-control", "no-store");
      requireExactOrigin(request, publicOrigin.origin);
      const credentials =
        provider === "app-review" ? AppReviewFormSchema.parse(parseForm(request.body)) : undefined;
      const form = credentials ?? UiFormSchema.parse(parseForm(request.body));
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
        ...(credentials
          ? { email: credentials.email, password: credentials.password }
          : { provider }),
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
        credentials ? "/sign-in/app-review" : "/sign-in/social",
        body,
        Boolean(form.switch_account),
      );
      copySetCookies(reply, response);
      // A sign-in page left open past its signed query's expiry, or one whose
      // query does not verify, starts the authorization again from the
      // request it carried, for every provider; it never ends on the JSON.
      if (form.oauth_query && (await signedQueryRefused(response))) {
        const request = new URLSearchParams(form.oauth_query);
        for (const name of signedQueryParameters) request.delete(name);
        return request.get("client_id")
          ? reply.redirect(`${controlPlaneAuthPath}/oauth2/authorize?${request.toString()}`, 303)
          : sendAuthorizationRestartPage(reply);
      }
      if (credentials && (response.status === 401 || response.status === 429)) {
        return sendSignInPage(reply.code(response.status), {
          returnTo,
          oauthQuery: form.oauth_query ?? "",
          appReviewFailure:
            response.status === 429
              ? "Too many attempts. Try again in a minute."
              : "Email or password is incorrect.",
        });
      }
      if (credentials && !response.ok) return sendWebResponse(reply, response);
      const payload = (
        credentials ? ConsentRedirectResponseSchema : AuthRedirectResponseSchema
      ).parse(await response.json());
      if (!response.ok || !payload.url) {
        throw new ControlPlaneError("unauthorized", "Sign-in could not be started");
      }
      return reply.redirect(payload.url);
    };
  app.post("/sign-in/google", signInWith("google"));
  if (dependencies.appleSignIn) app.post("/sign-in/apple", signInWith("apple"));
  if (appReviewSignIn) app.post("/sign-in/app-review", signInWith("app-review"));

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

function basicClientId(authorization: string | undefined): string | undefined {
  if (!authorization) return;
  try {
    return decodeBasicCredentials(authorization).clientId;
  } catch {
    return undefined;
  }
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
 * What the OAuth provider adds to an authorization request when it signs it for
 * the sign-in page. Without them it is the request the client made, which
 * authorize checks again in full: client, redirect, scope, state and PKCE.
 */
const signedQueryParameters = ["sig", "exp", "ba_iat", "ba_pl", "ba_param"] as const;

/** The OAuth provider refused a sign-in's signed query: expired, or not its own. */
async function signedQueryRefused(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    body.error === "invalid_signature"
  );
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
