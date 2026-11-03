import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  IssuePersonalHostAccountLinkChallengeRequestSchema,
  CompletePersonalHostAccountLinkRequestSchema,
  AccountDeploymentSchema,
  ControlPlaneAccountIdSchema,
  IssueAccountHostSessionGrantResponseSchema,
  type AccountDeploymentDirectoryEntry,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DeploymentIdSchema, opensteerMobileClient } from "@opensteer/core";
import { sessionExchangePath } from "@opensteer/protocol";
import {
  deploymentKindLabel,
  deploymentStatusFromAccountDirectory,
  deploymentStatusFromPersonalConnect,
  deploymentStatusLabel,
  deploymentStatusSelectable,
  deploymentStatusTone,
  type DeploymentStatusInfo,
} from "@opensteer/protocol/deployment-status";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { controlPlaneAuthPath, type ControlPlaneAuth } from "../auth/auth.js";
import {
  appendSetCookie,
  escapeHtml,
  expiredCookie,
  readCookie,
  requireExactOrigin,
  serializeCookie,
} from "./browser-http.js";
import { ControlPlaneError } from "../server/errors.js";
import type { PersonalRemoteAccountService } from "../account/personal-remote-account.js";
import {
  brandLockup,
  brandMark,
  browserPageContentSecurityPolicy,
  renderBrowserPage,
} from "./page-shell.js";
import { type PortalSession, type PortalSessionStore } from "./portal-sessions.js";
import type { ControlPlaneStore } from "../database/store.js";

/** First-party public client the portal uses against the Account host. */
export const portalOAuthClientId = "opensteer-portal";
/** Exactly what the portal reads and writes on the Account's behalf. */
export const portalOAuthScopes = ["openid", "deployments:read", "deployments:write"] as const;
export const portalSignInPath = "/auth/sign-in";
export const portalCallbackPath = "/auth/callback";
export const portalSignOutPath = "/auth/sign-out";
export const portalPersonalConnectPath = (deploymentId: string) =>
  `/deployments/${encodeURIComponent(deploymentId)}/connect`;
export const portalRemoveDeploymentPath = (deploymentId: string) =>
  `/deployments/${encodeURIComponent(deploymentId)}/remove`;

const portalFlowLifetimeMilliseconds = 10 * 60 * 1_000;
const maximumReturnPathLength = 512;
const silentSignInErrors = new Set([
  "login_required",
  "consent_required",
  "interaction_required",
  "account_selection_required",
]);

const SignInQuerySchema = z.strictObject({
  silent: z.literal("1").optional(),
  return: z.string().max(maximumReturnPathLength).optional(),
});
const CallbackQuerySchema = z.object({
  code: z.string().min(1).max(2_048).optional(),
  error: z.string().max(256).optional(),
  iss: z.string().max(2_048).optional(),
  state: z.string().max(2_048).optional(),
});
const FlowSchema = z.strictObject({
  expiresAt: z.number().int().positive(),
  returnPath: z.string().max(maximumReturnPathLength).optional(),
  state: z.string().min(16).max(256),
  verifier: z.string().min(43).max(128),
});
const TokenResponseSchema = z.object({ id_token: z.string().min(1) }).passthrough();
const PersonalConnectParamsSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
});

type PortalFlow = z.infer<typeof FlowSchema>;

interface PortalDependencies {
  readonly auth: ControlPlaneAuth;
  /** Where "Get the Desktop app" points; without it the row is absent. */
  readonly desktopDownloadUrl?: string;
  readonly iosAppUrl?: string;
  readonly androidAppUrl?: string;
  readonly portalOrigin: URL;
  readonly portalSessions: PortalSessionStore;
  readonly personalRemoteAccount?: PersonalRemoteAccountService;
  readonly publicOrigin: URL;
  readonly store: ControlPlaneStore;
}

export interface PortalRouter {
  /** Canonical origin of the portal vhost, and the only allowed form origin. */
  readonly origin: URL;
  /** True when this request arrived on the configured portal host. */
  ownsRequest(request: FastifyRequest): boolean;
  /** Registers the portal-only routes; `GET /` is dispatched by the server. */
  register(app: FastifyInstance): void;
  home(request: FastifyRequest, reply: FastifyReply): Promise<string | FastifyReply>;
}

/**
 * The web portal. It is a browser client of the Account authorization
 * server rather than a second authority: the authorization dance proves which
 * Account is at the keyboard, the resulting tokens are discarded inside the
 * callback, and every later read goes straight to the control-plane database
 * with the Account identity that callback established.
 *
 * The signed-in shape is deliberately flat. `GET /` renders the Account's
 * Deployments and never redirects into one of them, however few there are:
 * a predictable front door beats a clever one.
 */
export function createPortalRouter(dependencies: PortalDependencies): PortalRouter {
  const origin = dependencies.portalOrigin;
  const { auth, portalSessions, publicOrigin, store } = dependencies;
  const secure = origin.protocol === "https:";
  const sessionCookieName = secure ? "__Host-opensteer.portal" : "opensteer.portal";
  const flowCookieName = secure ? "__Host-opensteer.portal-flow" : "opensteer.portal-flow";
  const callbackUri = portalCallbackUri(origin);

  const sessionCookie = (token: string, expiresAt: Date) =>
    serializeCookie(sessionCookieName, token, {
      maxAgeSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000)),
      secure,
    });
  const clearSessionCookie = () => expiredCookie(sessionCookieName, { secure });
  const flowCookie = (flow: PortalFlow) =>
    serializeCookie(flowCookieName, Buffer.from(JSON.stringify(flow)).toString("base64url"), {
      maxAgeSeconds: Math.floor(portalFlowLifetimeMilliseconds / 1_000),
      secure,
    });
  const clearFlowCookie = () => expiredCookie(flowCookieName, { secure });

  async function readSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<PortalSession | undefined> {
    const token = readCookie(request, sessionCookieName);
    if (!token) return undefined;
    const session = await portalSessions.read(token);
    if (!session) {
      appendSetCookie(reply, clearSessionCookie());
      return undefined;
    }
    appendSetCookie(reply, sessionCookie(token, session.expiresAt));
    return session;
  }

  async function renderPortal(
    reply: FastifyReply,
    session: PortalSession,
  ): Promise<string | FastifyReply> {
    const accountId = ControlPlaneAccountIdSchema.parse(session.accountId);
    const deployments = await store.listDeployments(accountId);
    const presence = await Promise.all(
      deployments.map((deployment) =>
        store.isDeploymentPresentForAccount(accountId, deployment.id),
      ),
    );
    const empty = deployments.length === 0;
    const rows = deployments.map((deployment, index) =>
      deploymentCard(deployment, presence[index] === true),
    );
    if (dependencies.desktopDownloadUrl) rows.push(desktopAppRow(dependencies.desktopDownloadUrl));
    return sendPortalPage(reply, {
      account: session.email,
      content: `${empty ? `<p class="lead">Create your first Opensteer, or open one you already have.</p>` : ""}
        ${rows.length > 0 ? `<nav aria-label="Your Opensteers"><ul class="deployments">${rows.join("")}</ul></nav>` : ""}`,
      eyebrow: "Your Opensteers",
      heading: empty ? "Set up Opensteer" : "Choose an Opensteer",
      title: "Your Opensteers",
    });
  }

  /**
   * The front door, and also where a silent entry attempt lands when the
   * Account host answers "nobody is signed in". Both are ordinary moments, so
   * both get the same calm page and the same single action; only the sentence
   * changes, because "you are signed out" is true in one case and not the other.
   */
  function renderSignedOut(
    reply: FastifyReply,
    options: { readonly ended?: boolean } = {},
  ): string {
    const lead = options.ended
      ? "You’re signed out. Sign in again to reach your Opensteers."
      : "Your Opensteer Account keeps your identity and Deployments connected.";
    return sendPortalPage(reply, {
      content: `<p class="lead">${lead}</p>
        <a class="btn btn--primary btn--wide" href="${escapeHtml(portalSignInPath)}">Sign in</a>
        <p class="fine">Every Opensteer keeps its own data.</p>
        ${dependencies.desktopDownloadUrl ? `<ul class="deployments">${desktopAppRow(dependencies.desktopDownloadUrl)}</ul>` : ""}`,
      eyebrow: "Opensteer Account",
      heading: "Opensteer",
      layout: "centered",
      preconnect: publicOrigin.origin,
      title: "Opensteer",
    });
  }

  function renderRestart(reply: FastifyReply): string {
    return sendPortalPage(reply.code(400), {
      content: `<p class="lead">That sign-in didn’t finish. The request was missing, expired, or meant for a different browser.</p>
        <a class="btn btn--primary btn--wide" href="${escapeHtml(portalSignInPath)}">Start again</a>`,
      heading: "Start sign-in again",
      layout: "centered",
      title: "Start sign-in again",
    });
  }

  async function establishSession(
    reply: FastifyReply,
    flow: PortalFlow,
    code: string,
  ): Promise<FastifyReply | string> {
    const identity = await proveAccountIdentity(code, flow.verifier);
    const created = await portalSessions.create({
      accountId: identity.accountId,
      accountSessionId: identity.accountSessionId,
    });
    appendSetCookie(reply, sessionCookie(created.token, created.expiresAt));
    return reply.redirect(flow.returnPath ?? "/", 303);
  }

  /**
   * Exchanges the authorization code inside this process. The verifier never
   * leaves the server, the tokens never reach the browser, and nothing but the
   * proven Account identity outlives this call.
   */
  async function proveAccountIdentity(code: string, verifier: string) {
    const response = await auth.handler(
      new Request(new URL(`${controlPlaneAuthPath}/oauth2/token`, publicOrigin), {
        body: new URLSearchParams({
          client_id: portalOAuthClientId,
          code,
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: callbackUri,
        }).toString(),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: publicOrigin.origin,
        },
        method: "POST",
      }),
    );
    if (!response.ok) {
      throw new ControlPlaneError("unauthorized", "Portal authorization could not be completed");
    }
    const { id_token: idToken } = TokenResponseSchema.parse(await response.json());
    const verified = await jwtVerify(idToken, createLocalJWKSet(await auth.api.getJwks()), {
      algorithms: ["EdDSA"],
      audience: portalOAuthClientId,
      issuer: publicOrigin.origin,
    });
    return {
      accountId: ControlPlaneAccountIdSchema.parse(verified.payload.sub),
      accountSessionId: z.string().min(1).max(255).parse(verified.payload.sid),
    };
  }

  return {
    origin,

    ownsRequest(request: FastifyRequest): boolean {
      return requestHostname(request) === origin.host;
    },

    async home(request, reply) {
      void reply.header("cache-control", "no-store");
      const session = await readSession(request, reply);
      if (session) return renderPortal(reply, session);
      return renderSignedOut(reply);
    },

    register(app: FastifyInstance): void {
      const guard = (request: FastifyRequest) => {
        if (requestHostname(request) !== origin.host) {
          throw new ControlPlaneError("not_found", "Route was not found");
        }
      };

      app.get("/mac", async (request, reply) => {
        guard(request);
        return reply.redirect(dependencies.desktopDownloadUrl ?? "/", 302);
      });

      app.get("/open", async (request, reply) => {
        guard(request);
        const nonce = randomBytes(18).toString("base64url");
        const stores = [
          dependencies.iosAppUrl &&
            `<a href="${escapeHtml(dependencies.iosAppUrl)}">Get it for iPhone</a>`,
          dependencies.androidAppUrl &&
            `<a href="${escapeHtml(dependencies.androidAppUrl)}">Get it for Android</a>`,
        ]
          .filter(Boolean)
          .join(" · ");
        void reply
          .header("cache-control", "no-store")
          .header(
            "content-security-policy",
            `${browserPageContentSecurityPolicy}; script-src 'nonce-${nonce}'`,
          )
          .type("text/html; charset=utf-8");
        return portalPage({
          layout: "centered",
          title: "Open Opensteer on this phone",
          heading: "Open Opensteer on this phone",
          content: `<a id="open-app" class="btn btn--primary btn--wide" hidden>Open in Opensteer</a>
            <p id="incomplete" hidden>This link is incomplete. Scan the code on your computer again.</p>
            ${stores ? `<p class="fine">${stores}</p>` : ""}
            <p class="fine">Already installed? Scan the code again after installing.</p>
            <script nonce="${nonce}">
              const match = /^#d=(dep_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(location.hash);
              if (match) {
                const destination = ${JSON.stringify(opensteerMobileClient.applicationId + ":/open?d=")} + match[1];
                const button = document.getElementById("open-app");
                button.href = destination;
                button.hidden = false;
                location.href = destination;
              } else {
                document.getElementById("incomplete").hidden = false;
              }
            </script>`,
        });
      });

      app.get("/personal-host-link", async (request, reply) => {
        guard(request);
        const query = z
          .strictObject({ origin: z.url(), nonce: z.string().uuid() })
          .parse(request.query);
        const parent = new URL(query.origin);
        if (parent.origin !== query.origin || !["http:", "https:"].includes(parent.protocol))
          throw new ControlPlaneError("bad_request", "Invalid return origin");
        const session = await readSession(request, reply);
        if (!session)
          return reply.redirect(
            `${portalSignInPath}?return=${encodeURIComponent(request.url)}`,
            302,
          );
        const nonce = randomBytes(18).toString("base64url");
        const parameters = JSON.stringify(query).replace(/</gu, "\\u003c");
        return reply
          .type("text/html; charset=utf-8")
          .header("cache-control", "no-store")
          .header("referrer-policy", "no-referrer")
          .header(
            "content-security-policy",
            `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
          )
          .send(`<!doctype html><html><head><title>Link Opensteer Account</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Link Opensteer Account</h1><p>Signed in as ${escapeHtml(session.email)}</p><p id="computer">Waiting for your computer…</p><button id="allow" disabled>Link to my Account</button><p id="status"></p></main><script nonce="${nonce}">
          const parameters = ${parameters};
          const parent = window.opener;
          let challenge = null;
          let accepted = false;
          let issuedChallengeId = null;
          let completed = false;
          const tell = (kind, result, error) => parent.postMessage({ kind, result, error, nonce: parameters.nonce }, parameters.origin);
          const post = async (path, input) => {
            const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), redirect: 'error' });
            if (!response.ok) throw new Error('Account linking did not finish.');
            return response.json();
          };
          window.addEventListener('message', async (event) => {
            if (event.source !== parent || event.origin !== parameters.origin || event.data?.nonce !== parameters.nonce) return;
            if (event.data.kind === 'challenge' && !accepted && !challenge) {
              challenge = event.data.input;
              document.getElementById('computer').textContent = 'Link ' + challenge.name + ' from ' + parameters.origin + '?';
              document.getElementById('allow').disabled = false;
            } else if (event.data.kind === 'complete' && accepted && issuedChallengeId && event.data.input?.proof?.document?.challenge?.id === issuedChallengeId) {
              try { const result = await post('/personal-host-link/complete', event.data.input); completed = true; tell('complete', result); document.getElementById('status').textContent = 'Account linked. You can close this window.'; }
              catch { tell('complete', null, true); }
            }
          });
          document.getElementById('allow').onclick = async () => {
            if (!challenge || accepted) return;
            accepted = true;
            document.getElementById('allow').disabled = true;
            try { const result = await post('/personal-host-link/challenge', challenge); issuedChallengeId = result.challengeId; tell('challenge', result); document.getElementById('status').textContent = 'Linking…'; }
            catch { tell('challenge', null, true); }
          };
          window.addEventListener('pagehide', () => { if (parent && !completed) tell('cancelled'); });
          if (parent) tell('ready');
        </script></body></html>`);
      });
      app.post("/personal-host-link/challenge", async (request, reply) => {
        guard(request);
        requireExactOrigin(request, origin.origin);
        const session = await readSession(request, reply);
        if (!session || !dependencies.personalRemoteAccount)
          throw new ControlPlaneError("unauthorized", "Sign in to your Account first");
        const result = await dependencies.personalRemoteAccount.issueLinkChallenge(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          IssuePersonalHostAccountLinkChallengeRequestSchema.parse(request.body),
        );
        return reply.header("cache-control", "no-store").send(result);
      });
      app.post("/personal-host-link/complete", async (request, reply) => {
        guard(request);
        requireExactOrigin(request, origin.origin);
        const session = await readSession(request, reply);
        if (!session || !dependencies.personalRemoteAccount)
          throw new ControlPlaneError("unauthorized", "Sign in to your Account first");
        const result = await dependencies.personalRemoteAccount.completeLink(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          CompletePersonalHostAccountLinkRequestSchema.parse(request.body),
        );
        return reply.header("cache-control", "no-store").send(result);
      });

      app.get(portalSignInPath, async (request, reply) => {
        guard(request);
        void reply.header("cache-control", "no-store");
        const query = SignInQuerySchema.parse(request.query);
        const verifier = randomBytes(32).toString("base64url");
        const returnPath = safeReturnPath(query.return);
        const flow: PortalFlow = {
          expiresAt: Date.now() + portalFlowLifetimeMilliseconds,
          state: randomBytes(32).toString("base64url"),
          verifier,
          ...(returnPath ? { returnPath } : {}),
        };
        const authorize = new URL(`${controlPlaneAuthPath}/oauth2/authorize`, publicOrigin);
        // The registered redirect URI is exact and path-free. Deep-link intent
        // rides in the opaque state instead, where the callback can validate it
        // as a same-origin relative path before trusting it.
        authorize.search = new URLSearchParams({
          client_id: portalOAuthClientId,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          redirect_uri: callbackUri,
          response_type: "code",
          scope: portalOAuthScopes.join(" "),
          state: flow.state,
          ...(query.silent === "1" ? { prompt: "none" } : {}),
        }).toString();
        appendSetCookie(reply, flowCookie(flow));
        return reply.redirect(authorize.toString(), 302);
      });

      app.get(portalCallbackPath, async (request, reply) => {
        guard(request);
        void reply.header("cache-control", "no-store");
        const query = CallbackQuerySchema.parse(request.query);
        const flow = readFlow(readCookie(request, flowCookieName));
        appendSetCookie(reply, clearFlowCookie());
        // State binds the answer to this browser's request; `iss` binds it to
        // the one authorization server the portal ever asks.
        if (!flow || !query.state || !matchesState(flow.state, query.state)) {
          return renderRestart(reply);
        }
        if (query.iss !== undefined && query.iss !== publicOrigin.origin) {
          return renderRestart(reply);
        }
        if (query.error) {
          // A silent refusal returns to the ordinary signed-out page.
          if (silentSignInErrors.has(query.error)) {
            return renderSignedOut(reply, { ended: true });
          }
          return renderRestart(reply);
        }
        if (!query.code) return renderRestart(reply);
        try {
          return await establishSession(reply, flow, query.code);
        } catch (error) {
          if (error instanceof ControlPlaneError && error.status < 500) {
            return renderRestart(reply);
          }
          throw error;
        }
      });

      app.post(portalSignOutPath, async (request, reply) => {
        guard(request);
        void reply.header("cache-control", "no-store");
        requireExactOrigin(request, origin.origin);
        const token = readCookie(request, sessionCookieName);
        const revoked = token ? await portalSessions.delete(token) : undefined;
        // One sign-out is authoritative: the Account session that proved this
        // portal session goes with it, and its cascade removes any other portal
        // session that shares it.
        if (revoked) await store.revokeAccountSession(revoked.accountId, revoked.accountSessionId);
        appendSetCookie(reply, clearSessionCookie());
        return reply.redirect("/", 303);
      });

      app.post("/deployments/:deploymentId/connect", async (request, reply) => {
        guard(request);
        void reply.header("cache-control", "no-store");
        requireExactOrigin(request, origin.origin);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        const service = dependencies.personalRemoteAccount;
        if (!service) {
          throw new ControlPlaneError("unavailable", "Personal Host handoff is unavailable");
        }
        const { deploymentId } = PersonalConnectParamsSchema.parse(request.params);
        const accountId = ControlPlaneAccountIdSchema.parse(session.accountId);
        const deployment = await store.deploymentForAccount(accountId, deploymentId);
        if (
          !deployment ||
          deployment.lifecycle !== "active" ||
          deployment.reachability !== "routed" ||
          !deployment.connectRoute ||
          personalConnectStatus(deployment).status !== "ready"
        ) {
          throw new ControlPlaneError("conflict", "Personal Host is not ready for remote access");
        }
        const issued = IssueAccountHostSessionGrantResponseSchema.parse(
          await service.issueSessionGrant(accountId, deployment.id, {
            clientSurface: "browser",
            expectedAuthority: deployment.authorityEnvelope.document,
            expectedRoute: deployment.connectRoute,
            portalOrigin: origin.origin,
            targetKind: "personal-connect",
          }),
        );
        return sendPersonalConnectHandoff(reply, {
          deploymentName: deployment.name,
          grant: issued.grant,
          routeOrigin: deployment.connectRoute.document.route.origin,
        });
      });

      app.post("/deployments/:deploymentId/remove", async (request, reply) => {
        guard(request);
        void reply.header("cache-control", "no-store");
        requireExactOrigin(request, origin.origin);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        const { deploymentId } = PersonalConnectParamsSchema.parse(request.params);
        await store.removeDeploymentFromDirectory(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          deploymentId,
        );
        return reply.redirect("/", 303);
      });
    },
  };
}

export function portalCallbackUri(origin: URL): string {
  return new URL(portalCallbackPath, origin).toString();
}

function readFlow(value: string | undefined): PortalFlow | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const flow = FlowSchema.safeParse(parsed);
  if (!flow.success || flow.data.expiresAt <= Date.now()) return undefined;
  return flow.data;
}

function matchesState(expected: string, received: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Deep-link intent is only ever a same-origin path on the portal itself. */
function safeReturnPath(value: string | undefined): string | undefined {
  if (!value || value.length > maximumReturnPathLength) return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return undefined;
  const unsafe = [...value].some(
    (character) =>
      character === "\\" || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  );
  if (unsafe) return undefined;
  return value;
}

function requestHostname(request: FastifyRequest): string {
  const host = request.headers.host ?? "";
  return normalizedApexDomain(host || ".");
}

function normalizedApexDomain(value: string): string {
  const lowered = value.trim().toLowerCase();
  return lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
}

/**
 * The portal renders the same Directory row as the Desktop app: the place's
 * letter mark, its name, what it is, the honest explanation when it cannot be
 * opened, and a status chip only when the directory has evidence for one.
 * The link covers the row so the whole tile is clickable, while the accessible
 * name stays the Deployment's own name rather than a pile of status text read
 * out on every tab stop.
 */
export function deploymentCard(
  deployment: AccountDeploymentDirectoryEntry,
  present: boolean,
): string {
  const current = currentAccountDeployment(deployment);
  const statusInfo = accountDeploymentStatus(deployment, present, current !== null);
  const name = escapeHtml(deployment.name);
  const selectable =
    current !== null &&
    (statusInfo === null || deploymentStatusSelectable(statusInfo.status)) &&
    deployment.lifecycle === "active";
  const control =
    selectable && deployment.reachability === "routed"
      ? statusInfo?.status === "ready"
        ? `<form method="post" action="${escapeHtml(portalPersonalConnectPath(deployment.id))}"><button class="deployment-name" type="submit">${name}</button></form>`
        : `<span class="deployment-name">${name}</span>`
      : selectable
        ? `<a class="deployment-name" href="${escapeHtml(deploymentOrigin(deployment.authority.canonicalOrigin))}">${name}</a>`
        : `<span class="deployment-name">${name}</span>`;
  const kind = deploymentKindLabel(
    deployment.reachability === "routed" ? "personal" : "self-hosted",
  );
  return directoryRow({
    control,
    explanation: statusInfo?.reason ?? null,
    kind,
    mark: letterMark(deployment.name),
    secondaryControl: `${deployment.access === "member" ? `<form class="deployment-remove" method="post" action="${escapeHtml(portalRemoveDeploymentPath(deployment.id))}"><button type="submit">Remove from Account list</button></form>` : ""}`,
    selectable,
    status: statusInfo?.status ?? null,
  });
}

function currentAccountDeployment(deployment: AccountDeploymentDirectoryEntry) {
  const { authority: _authority, ...current } = deployment;
  return AccountDeploymentSchema.safeParse(current).data ?? null;
}

/** Where an AccountDeployment currently *is*, in the one status vocabulary. */
function accountDeploymentStatus(
  deployment: AccountDeploymentDirectoryEntry,
  present: boolean,
  compatible: boolean,
): DeploymentStatusInfo | null {
  return deploymentStatusFromAccountDirectory({
    compatible,
    present: deployment.access === "owner" || present,
    reachability: deployment.reachability,
    ...(deployment.reachability === "routed"
      ? {
          hasConnectRoute: deployment.connectRoute !== null,
          livenessExpiresAt: deployment.lastSeenAt?.expiresAt ?? null,
        }
      : {}),
  });
}

/**
 * The portal reads a linked Personal Host exactly as the Desktop directory
 * does: a signed Connect route, and a liveness observation that has not
 * expired. One rule, one answer, wherever the place is listed.
 */
function personalConnectStatus(deployment: {
  readonly connectRoute: unknown;
  readonly lastSeenAt: { readonly expiresAt: string } | null;
}): DeploymentStatusInfo {
  return deploymentStatusFromPersonalConnect({
    hasConnectRoute: deployment.connectRoute !== null,
    livenessExpiresAt: deployment.lastSeenAt?.expiresAt ?? null,
  });
}

function desktopAppRow(downloadUrl: string): string {
  return directoryRow({
    action: true,
    control: `<a class="deployment-name" href="${escapeHtml(downloadUrl)}">Get the Desktop app</a>`,
    explanation: null,
    kind: "Create a private Opensteer on your own computer.",
    mark: "↓",
    secondaryControl: null,
    selectable: true,
    status: null,
  });
}

function directoryRow(row: {
  readonly action?: boolean;
  readonly control: string;
  readonly explanation: string | null;
  readonly kind: string;
  readonly mark: string;
  readonly secondaryControl: string | null;
  readonly selectable: boolean;
  readonly status: DeploymentStatusInfo["status"] | null;
}): string {
  const chip = row.status
    ? `<span class="chip chip--${deploymentStatusTone(row.status)}"><span class="chip-dot" aria-hidden="true"></span>${escapeHtml(deploymentStatusLabel(row.status))}</span>`
    : "";
  return `<li class="deployment${row.action ? " deployment--action" : ""}${row.selectable ? "" : " deployment--still"}">
    <span class="deployment-mark${row.action ? " deployment-mark--action" : ""}" aria-hidden="true">${escapeHtml(row.mark)}</span>
    <span class="deployment-copy">
      ${row.control}
      <span class="deployment-kind">${escapeHtml(row.kind)}</span>
      ${row.explanation ? `<span class="deployment-note">${escapeHtml(row.explanation)}</span>` : ""}
      ${row.secondaryControl ?? ""}
    </span>
    ${chip}
    ${row.selectable ? `<span class="deployment-go" aria-hidden="true"></span>` : ""}
  </li>`;
}

function letterMark(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "O";
}

function sendPersonalConnectHandoff(
  reply: FastifyReply,
  input: { readonly deploymentName: string; readonly grant: string; readonly routeOrigin: string },
): string {
  const nonce = randomBytes(18).toString("base64url");
  const action = new URL(sessionExchangePath, input.routeOrigin).toString();
  void reply
    .header("cache-control", "no-store")
    .header(
      "content-security-policy",
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action ${input.routeOrigin}; base-uri 'none'; frame-ancestors 'none'`,
    )
    .header("referrer-policy", "no-referrer")
    .type("text/html; charset=utf-8");
  return renderBrowserPage({
    body: `${brandMark({ large: true })}<main><p class="eyebrow">${escapeHtml(deploymentKindLabel("personal"))}</p><h1>Opening ${escapeHtml(input.deploymentName)}…</h1>
      <p class="lead">Signing you in at this Opensteer.</p>
      <form id="personal-connect-handoff" method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="grant" value="${escapeHtml(input.grant)}">
        <button class="btn btn--primary btn--wide" type="submit">Continue</button>
      </form></main><script nonce="${nonce}">document.getElementById("personal-connect-handoff").submit()</script>`,
    layout: "centered",
    title: `Opening ${input.deploymentName}`,
  });
}

function signOutForm(): string {
  return `<form method="post" action="${escapeHtml(portalSignOutPath)}"><button class="btn btn--quiet" type="submit">Sign out</button></form>`;
}

function deploymentOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlPlaneError("internal", "Deployment origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    throw new ControlPlaneError("internal", "Deployment origin is invalid");
  }
  return url.origin;
}

interface PortalPage {
  /** Shown beside the sign-out control; the app layout only. */
  readonly account?: string;
  readonly content: string;
  readonly eyebrow?: string;
  readonly heading: string;
  /** `centered` is the auth-moment card: brand orb, one sentence, one action. */
  readonly layout?: "app" | "centered";
  readonly preconnect?: string;
  readonly title: string;
}

function sendPortalPage(reply: FastifyReply, page: PortalPage): string {
  void reply
    .header("cache-control", "no-store")
    .header("content-security-policy", browserPageContentSecurityPolicy)
    .type("text/html; charset=utf-8");
  return portalPage(page);
}

function portalPage(page: PortalPage): string {
  const centered = page.layout === "centered";
  const header = centered
    ? brandMark({ large: true })
    : `<header class="masthead">${brandLockup()}${accountControls(page.account)}</header>`;
  const eyebrow = page.eyebrow ? `<p class="eyebrow">${escapeHtml(page.eyebrow)}</p>` : "";
  return renderBrowserPage({
    body: `${header}<main><div class="page-head">${eyebrow}<h1>${escapeHtml(page.heading)}</h1></div>${page.content}</main>`,
    ...(centered ? { layout: "centered" as const } : {}),
    ...(page.preconnect ? { preconnect: page.preconnect } : {}),
    title: page.title,
  });
}

function accountControls(account: string | undefined): string {
  if (!account) return "";
  const escaped = escapeHtml(account);
  return `<div class="session"><span class="session-account" title="${escaped}">${escaped}</span>${signOutForm()}</div>`;
}
