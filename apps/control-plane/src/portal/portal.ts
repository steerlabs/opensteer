import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AccountDeploymentSchema,
  CloudDeploymentOperationIdSchema,
  CreateCloudDeploymentRequestSchema,
  DeleteCloudDeploymentRequestSchema,
  ControlPlaneAccountIdSchema,
  IssueAccountHostSessionGrantResponseSchema,
  type AccountDeploymentDirectoryEntry,
  type CloudDeploymentOperation,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DeploymentIdSchema } from "@opensteer/core";
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
  parseForm,
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
  liveBrowserPageContentSecurityPolicy,
  liveRegionId,
  renderBrowserPage,
} from "./page-shell.js";
import {
  portalSessionLifetimeMilliseconds,
  type PortalSession,
  type PortalSessionStore,
} from "./portal-sessions.js";
import type { ControlPlaneStore } from "../database/store.js";
import type { CloudDeploymentLifecycle } from "../cloud/lifecycle.js";

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
/**
 * Presence hint. It carries no credential and is readable by scripts on
 * purpose: it exists only so the portal can tell "probably signed in" from
 * "certainly signed out" without a redirect, and so a signed-out visitor gets
 * an immediate page instead of a bounce through the Account host.
 */
export const portalHintCookieName = "opensteer.hint";

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
const CloudOperationParamsSchema = z.strictObject({
  operationId: CloudDeploymentOperationIdSchema,
});

type PortalFlow = z.infer<typeof FlowSchema>;

interface PortalDependencies {
  readonly auth: ControlPlaneAuth;
  readonly cloudDeployments?: CloudDeploymentLifecycle;
  /** Where "Get the Desktop app" points; without it the row is absent. */
  readonly desktopDownloadUrl?: string;
  readonly managedDeploymentDomain: string;
  readonly portalSessions: PortalSessionStore;
  readonly personalRemoteAccount?: PersonalRemoteAccountService;
  readonly publicOrigin: URL;
  readonly store: ControlPlaneStore;
}

export interface PortalRouter {
  /** Canonical origin of the portal vhost, and the only allowed form origin. */
  readonly origin: URL;
  /** True when this request arrived on the apex hostname. */
  ownsRequest(request: FastifyRequest): boolean;
  /** Registers the portal-only routes; `GET /` is dispatched by the server. */
  register(app: FastifyInstance): void;
  home(request: FastifyRequest, reply: FastifyReply): Promise<string | FastifyReply>;
}

/**
 * The apex web portal. It is a browser client of the Account authorization
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
  const apex = normalizedApexDomain(dependencies.managedDeploymentDomain);
  const { auth, portalSessions, publicOrigin, store } = dependencies;
  const secure = publicOrigin.protocol === "https:";
  const origin = portalOrigin(publicOrigin, apex);
  const sessionCookieName = secure ? "__Host-opensteer.portal" : "opensteer.portal";
  const flowCookieName = secure ? "__Host-opensteer.portal-flow" : "opensteer.portal-flow";
  const hintDomain = portalHintCookieDomain(publicOrigin, apex);
  const callbackUri = portalCallbackUri(publicOrigin, apex);

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
    const cloud = (await dependencies.cloudDeployments?.list(accountId)) ?? [];
    const operationByDeployment = new Map(
      cloud.map((operation) => [operation.deploymentId, operation]),
    );
    const visibleDeployments = deployments.filter((deployment) => {
      const operation = operationByDeployment.get(deployment.id);
      return operation === undefined || operation.status === "ready";
    });
    const presence = await Promise.all(
      visibleDeployments.map((deployment) =>
        store.isDeploymentPresentForAccount(accountId, deployment.id),
      ),
    );
    const listedDeploymentIds = new Set(deployments.map(({ id }) => id));
    const pendingCloud = cloud.filter(
      ({ status, deploymentId }) => status !== "ready" || !listedDeploymentIds.has(deploymentId),
    );
    const empty = deployments.length === 0 && cloud.length === 0;
    const rows = [
      ...visibleDeployments.map((deployment, index) =>
        deploymentCard(
          deployment,
          presence[index] === true,
          operationByDeployment.get(deployment.id)?.operationId,
        ),
      ),
      ...(dependencies.desktopDownloadUrl ? [desktopAppRow(dependencies.desktopDownloadUrl)] : []),
    ];
    return sendPortalPage(reply, {
      account: session.email,
      content: `${empty ? `<p class="lead">Create your first Opensteer, or open one you already have.</p>` : ""}
        ${dependencies.cloudDeployments?.available ? `<a class="btn btn--primary" href="/cloud/new">Create cloud deployment</a>` : ""}
        ${pendingCloud.length > 0 ? `<section class="section"><h2>Cloud operations</h2><ul class="deployments">${pendingCloud.map(cloudOperationRow).join("")}</ul></section>` : ""}
        ${rows.length > 0 ? `<nav aria-label="Your Opensteers"><ul class="deployments">${rows.join("")}</ul></nav>` : ""}`,
      eyebrow: "Your Opensteers",
      heading: empty ? "Set up Opensteer" : "Choose an Opensteer",
      // The same rows the operation page shows, so they settle the same way:
      // in place, while an operation is still moving.
      ...(pendingCloud.some(cloudOperationPending) ? { live: true } : {}),
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
        <p class="fine">Every Opensteer keeps its own data.</p>`,
      eyebrow: "Opensteer Cloud",
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
    if (hintDomain) appendSetCookie(reply, portalHintCookie(hintDomain, secure));
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
      return requestHostname(request) === apex;
    },

    async home(request, reply) {
      void reply.header("cache-control", "no-store");
      const session = await readSession(request, reply);
      if (session) return renderPortal(reply, session);
      // A hint without a portal session means the Account host may still hold a
      // live session: ask it silently. Its answer either signs the portal in or
      // clears the hint, so this can run at most once per visit.
      if (readCookie(request, portalHintCookieName)) {
        return reply.redirect(`${portalSignInPath}?silent=1`, 302);
      }
      return renderSignedOut(reply);
    },

    register(app: FastifyInstance): void {
      const guard = (request: FastifyRequest) => {
        if (requestHostname(request) !== apex) {
          throw new ControlPlaneError("not_found", "Route was not found");
        }
      };

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
          // The silent attempt answered "not signed in". Drop the hint so the
          // next visit renders immediately instead of asking again.
          if (silentSignInErrors.has(query.error)) {
            if (hintDomain) appendSetCookie(reply, clearPortalHintCookie(hintDomain, secure));
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
        if (hintDomain) appendSetCookie(reply, clearPortalHintCookie(hintDomain, secure));
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

      app.get("/deployments/:deploymentId/open", async (request, reply) => {
        guard(request);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        const { deploymentId } = PersonalConnectParamsSchema.parse(request.params);
        const operation = await cloudOperationForDeployment(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          deploymentId,
        );
        if (!operation || operation.status !== "ready") {
          throw new ControlPlaneError("not_found", "Cloud deployment was not found");
        }
        return reply.redirect(operation.canonicalOrigin, 303);
      });

      app.get("/cloud/new", async (request, reply) => {
        guard(request);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        requireCloudLifecycle();
        return sendPortalPage(reply, {
          account: session.email,
          content: `<form class="stack" method="post" action="/cloud">
            <input type="hidden" name="operationId" value="${randomUUID()}">
            <label class="stack">Deployment name<input name="name" required maxlength="120" autocomplete="off"></label>
            <button class="btn btn--primary" type="submit">Create cloud deployment</button>
          </form>`,
          eyebrow: "Opensteer Cloud",
          heading: "Create a cloud deployment",
          title: "Create cloud deployment",
        });
      });

      app.post("/cloud", async (request, reply) => {
        guard(request);
        requireExactOrigin(request, origin.origin);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        const input = CreateCloudDeploymentRequestSchema.parse(parseForm(request.body));
        const operation = await requireCloudLifecycle().create(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          input,
        );
        return reply.redirect(cloudOperationPath(operation.operationId), 303);
      });

      app.get("/cloud/:operationId", async (request, reply) => {
        guard(request);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        const { operationId } = CloudOperationParamsSchema.parse(request.params);
        const operation = await requireCloudOperation(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          operationId,
        );
        return cloudOperationPage(
          reply,
          session,
          operation,
          dependencies.cloudDeployments?.available ?? false,
        );
      });

      app.post("/cloud/:operationId/retry", async (request, reply) => {
        guard(request);
        requireExactOrigin(request, origin.origin);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        const { operationId } = CloudOperationParamsSchema.parse(request.params);
        await requireCloudLifecycle().retry(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          operationId,
        );
        return reply.redirect(cloudOperationPath(operationId), 303);
      });

      app.get("/cloud/:operationId/delete", async (request, reply) => {
        guard(request);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        const { operationId } = CloudOperationParamsSchema.parse(request.params);
        const operation = await requireCloudOperation(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          operationId,
        );
        return sendPortalPage(reply, {
          account: session.email,
          content: `<p class="lead">Enter <strong>${escapeHtml(operation.name)}</strong> to permanently delete this cloud deployment.</p>
            <form class="stack" method="post" action="${cloudDeletePath(operationId)}">
              <label class="stack">Deployment name<input name="name" required maxlength="120" autocomplete="off"></label>
              <button class="btn" type="submit">Delete cloud deployment</button>
            </form>`,
          eyebrow: "Opensteer Cloud",
          heading: `Delete ${operation.name}`,
          title: `Delete ${operation.name}`,
        });
      });

      app.post("/cloud/:operationId/delete", async (request, reply) => {
        guard(request);
        requireExactOrigin(request, origin.origin);
        const session = await readSession(request, reply);
        if (!session) return reply.redirect(portalSignInPath, 303);
        const { operationId } = CloudOperationParamsSchema.parse(request.params);
        const { name } = DeleteCloudDeploymentRequestSchema.parse(parseForm(request.body));
        await requireCloudLifecycle().delete(
          ControlPlaneAccountIdSchema.parse(session.accountId),
          operationId,
          name,
        );
        return reply.redirect(cloudOperationPath(operationId), 303);
      });
    },
  };

  function requireCloudLifecycle(): CloudDeploymentLifecycle {
    if (!dependencies.cloudDeployments?.available) {
      throw new ControlPlaneError("unavailable", "Cloud deployment creation is not available");
    }
    return dependencies.cloudDeployments;
  }

  async function requireCloudOperation(
    accountId: ReturnType<typeof ControlPlaneAccountIdSchema.parse>,
    operationId: string,
  ) {
    if (!dependencies.cloudDeployments)
      throw new ControlPlaneError("not_found", "Cloud deployment was not found");
    return dependencies.cloudDeployments.get(accountId, operationId);
  }

  async function cloudOperationForDeployment(
    accountId: ReturnType<typeof ControlPlaneAccountIdSchema.parse>,
    deploymentId: string,
  ) {
    return (await requireCloudLifecycle().list(accountId)).find(
      (operation) => operation.deploymentId === deploymentId,
    );
  }
}

export const cloudOperationPath = (operationId: string) =>
  `/cloud/${encodeURIComponent(operationId)}`;
export const cloudDeletePath = (operationId: string) => `${cloudOperationPath(operationId)}/delete`;

function cloudOperationRow(operation: CloudDeploymentOperation): string {
  return `<li class="deployment"><span class="deployment-copy"><a class="deployment-name" href="${cloudOperationPath(operation.operationId)}">${escapeHtml(operation.name)}</a><span class="deployment-kind">${escapeHtml(cloudStatusLabel(operation.status))}</span>${cloudOperationNote(operation) ? `<span class="deployment-note">${escapeHtml(cloudOperationNote(operation))}</span>` : ""}</span></li>`;
}

/** An operation the server is still working on, and so a page that keeps moving. */
function cloudOperationPending(operation: CloudDeploymentOperation): boolean {
  return operation.status === "creating" || operation.status === "deleting";
}

/**
 * One line under the status: why it failed, or what it is waiting on right now.
 * A step still under way is left open with an ellipsis — "Starting Browser,
 * Messaging…" reads as work in progress, where the bare phrase reads as a
 * verdict on a list that only ever shrinks.
 */
function cloudOperationNote(operation: CloudDeploymentOperation): string {
  if (operation.error) return operation.error;
  const progress = operation.progress ?? "";
  if (!progress || !cloudOperationPending(operation)) return progress;
  return /[.…]$/u.test(progress) ? progress : `${progress}…`;
}

function cloudStatusLabel(status: CloudDeploymentOperation["status"]): string {
  if (status === "creating") return "Creating";
  if (status === "deleting") return "Deleting";
  if (status === "failed") return "Needs attention";
  if (status === "deleted") return "Deleted";
  return "Created";
}

function cloudOperationPage(
  reply: FastifyReply,
  session: PortalSession,
  operation: CloudDeploymentOperation,
  available: boolean,
): string {
  const path = cloudOperationPath(operation.operationId);
  const pending = cloudOperationPending(operation);
  const action =
    operation.status === "ready"
      ? `<a class="btn btn--primary" href="/deployments/${encodeURIComponent(operation.deploymentId)}/open">Open deployment</a>`
      : operation.status === "failed" && available
        ? `<form method="post" action="${path}/retry"><button class="btn btn--primary" type="submit">Retry</button></form>`
        : "";
  return sendPortalPage(reply, {
    account: session.email,
    content: `<section class="section"><p class="lead">${escapeHtml(cloudStatusLabel(operation.status))}</p>
      ${cloudOperationNote(operation) ? `<p class="deployment-note">${escapeHtml(cloudOperationNote(operation))}</p>` : ""}
      <div class="actions">${action}<a class="btn" href="/">Your deployments</a></div>
      ${available && operation.status !== "deleting" && operation.status !== "deleted" ? `<a class="deployment-secondary" href="${cloudDeletePath(operation.operationId)}">Delete cloud deployment…</a>` : ""}
    </section>`,
    eyebrow: "Opensteer Cloud",
    heading: operation.name,
    ...(pending ? { live: true } : {}),
    title: operation.name,
  });
}

/** Canonical portal origin: the managed-Deployment apex on the public scheme. */
export function portalOrigin(publicOrigin: URL, managedDeploymentDomain: string): URL {
  const apex = normalizedApexDomain(managedDeploymentDomain);
  return new URL(
    `${publicOrigin.protocol}//${apex}${publicOrigin.port ? `:${publicOrigin.port}` : ""}`,
  );
}

/**
 * The single registered redirect URI of the portal client. It carries no path
 * beyond the callback and no query at all, so the registration stays exact.
 */
export function portalCallbackUri(publicOrigin: URL, managedDeploymentDomain: string): string {
  return new URL(
    portalCallbackPath,
    portalOrigin(publicOrigin, managedDeploymentDomain),
  ).toString();
}

/**
 * The Account host may set the hint for the apex only when it is the apex or
 * one of its subdomains; a browser rejects any other `Domain`. A deployment
 * whose Account host lives elsewhere simply has no hint, and the portal renders
 * its signed-out page until the visitor signs in explicitly.
 */
export function portalHintCookieDomain(
  publicOrigin: URL,
  managedDeploymentDomain: string,
): string | undefined {
  const apex = normalizedApexDomain(managedDeploymentDomain);
  const host = publicOrigin.hostname.toLowerCase();
  return host === apex || host.endsWith(`.${apex}`) ? apex : undefined;
}

export function portalHintCookie(domain: string, secure: boolean): string {
  return serializeCookie(portalHintCookieName, "1", {
    domain,
    httpOnly: false,
    maxAgeSeconds: Math.floor(portalSessionLifetimeMilliseconds / 1_000),
    secure,
  });
}

export function clearPortalHintCookie(domain: string, secure: boolean): string {
  return expiredCookie(portalHintCookieName, { domain, httpOnly: false, secure });
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
  const host = (request.headers.host ?? "").split(":", 1)[0] ?? "";
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
  cloudOperationId?: string,
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
        ? `<a class="deployment-name" href="${escapeHtml(cloudOperationId ? `/deployments/${encodeURIComponent(deployment.id)}/open` : deploymentOrigin(deployment.authority.canonicalOrigin))}">${name}</a>`
        : `<span class="deployment-name">${name}</span>`;
  const kind = deploymentKindLabel(
    deployment.reachability === "routed" ? "personal" : "self-hosted",
  );
  return directoryRow({
    control,
    explanation: statusInfo?.reason ?? null,
    kind,
    mark: letterMark(deployment.name),
    // An owner's row is removed by the operation that made it (unlink from the
    // computer, delete the cloud deployment); only a member can hide a listing.
    secondaryControl: `${cloudOperationId ? `<a class="deployment-secondary" href="${cloudOperationPath(cloudOperationId)}">Manage cloud deployment</a>` : ""}${deployment.access === "member" ? `<form class="deployment-remove" method="post" action="${escapeHtml(portalRemoveDeploymentPath(deployment.id))}"><button type="submit">Remove from Account list</button></form>` : ""}`,
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
  /**
   * The page is still moving, so it re-reads itself and swaps `<main>` for the
   * freshly rendered one until the server stops marking it live. Same page,
   * same renderer; only the region changes, so nothing flashes and the scroll
   * position stays put.
   */
  readonly live?: boolean;
  readonly preconnect?: string;
  readonly title: string;
}

function sendPortalPage(reply: FastifyReply, page: PortalPage): string {
  // The nonce belongs to this one response: minted here so the header and the
  // single script tag can never disagree.
  const nonce = page.live ? randomBytes(18).toString("base64url") : undefined;
  void reply
    .header("cache-control", "no-store")
    .header(
      "content-security-policy",
      nonce ? liveBrowserPageContentSecurityPolicy(nonce) : browserPageContentSecurityPolicy,
    )
    .type("text/html; charset=utf-8");
  return portalPage(page, nonce);
}

function portalPage(page: PortalPage, liveScriptNonce?: string): string {
  const centered = page.layout === "centered";
  const header = centered
    ? brandMark({ large: true })
    : `<header class="masthead">${brandLockup()}${accountControls(page.account)}</header>`;
  const eyebrow = page.eyebrow ? `<p class="eyebrow">${escapeHtml(page.eyebrow)}</p>` : "";
  // Every portal page carries the region id, live or not: a page that has just
  // settled is exactly what a polling script fetches last, and it has to find
  // the region there to swap the finished state in without a reload.
  return renderBrowserPage({
    body: `${header}<main id="${liveRegionId}"${page.live ? " data-live" : ""}><div class="page-head">${eyebrow}<h1>${escapeHtml(page.heading)}</h1></div>${page.content}</main>`,
    ...(centered ? { layout: "centered" as const } : {}),
    ...(liveScriptNonce ? { liveScriptNonce } : {}),
    ...(page.preconnect ? { preconnect: page.preconnect } : {}),
    title: page.title,
  });
}

function accountControls(account: string | undefined): string {
  if (!account) return "";
  const escaped = escapeHtml(account);
  return `<div class="session"><span class="session-account" title="${escaped}">${escaped}</span>${signOutForm()}</div>`;
}
