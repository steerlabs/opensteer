import { isIP } from "node:net";
import {
  AccountHostSessionGrantSchema,
  type AccountHostSessionClientSurface,
} from "@opensteer/control-plane-protocol";
import { OpensteerError, type PersonalRemoteSessionDelivery } from "@opensteer/core";
import {
  SessionExchangeCredentialSchema,
  SessionExchangeRequestSchema,
  SessionExchangeResponseSchema,
  sessionExchangePath,
  type SessionExchangeCredential,
  type SessionExchangeCredentialKind,
} from "@opensteer/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { copyResponseHeaders } from "../identity/identity-routes.js";
import type {
  PersonalRemoteAccessService,
  PersonalRemoteSessionExchange,
} from "./personal-remote-access-service.js";

/** Bounds the one exchange body: the largest arm carries a signed grant and a
 * signed route envelope, nothing that grows with deployment size. */
const maximumSessionExchangeBodyBytes = 24 * 1_024;

interface SessionExchangeContext {
  readonly clientAddress: string;
  readonly delivery: PersonalRemoteSessionDelivery;
  /** Origin header: the portal for a form POST, absent for a native client. */
  readonly requestOrigin: string | undefined;
  /** The access route this request actually arrived on. */
  readonly routeOrigin: string | undefined;
  readonly surface: AccountHostSessionClientSurface;
  /** Names the device in the session list; it grants nothing. */
  readonly userAgent: string | null;
}

/**
 * The portal's form post carries only the grant: a browser has no verified
 * route envelope to pin, and the Host binds the grant to its own live route.
 * Native clients must pin the envelope, so the wire schema keeps it required.
 */
type BrowserAccountConnectGrantCredential = Omit<
  Extract<SessionExchangeCredential, { readonly kind: "account-connect-grant" }>,
  "expectedRoute"
>;

type SessionExchangeArm = (
  credential: SessionExchangeCredential | BrowserAccountConnectGrantCredential,
  context: SessionExchangeContext,
) => Promise<PersonalRemoteSessionExchange>;

export interface SessionExchangeDependencies {
  readonly personalRemoteAccess?:
    | Pick<
        PersonalRemoteAccessService,
        "accountSessionExchangeEnabled" | "exchangeAccountSessionGrant" | "exchangePairingCode"
      >
    | undefined;
}

/**
 * Every credential arm this Deployment can actually honour.
 *
 * Availability is derived from the services that exist, never from a flag a
 * caller can influence. A Personal Deployment has two arms, and a self-hosted
 * Deployment that signs its own users in has neither.
 */
export function availableSessionExchangeArms(
  dependencies: SessionExchangeDependencies,
): ReadonlyMap<SessionExchangeCredentialKind, SessionExchangeArm> {
  const arms = new Map<SessionExchangeCredentialKind, SessionExchangeArm>();
  const personal = dependencies.personalRemoteAccess;
  if (personal) {
    // The Connect arm needs the Account grant verifier, which only exists once
    // the Personal Deployment is linked to an Account issuer — an unlinked
    // Deployment must not advertise an arm it cannot honour.
    if (personal.accountSessionExchangeEnabled()) {
      arms.set("account-connect-grant", async (credential, context) => {
        if (credential.kind !== "account-connect-grant") throw armMismatch();
        return personal.exchangeAccountSessionGrant({
          clientAddress: context.clientAddress,
          expectedRoute: "expectedRoute" in credential ? credential.expectedRoute : undefined,
          grant: credential.grant,
          portalOrigin: context.surface === "browser" ? context.requestOrigin : undefined,
          routeOrigin: context.routeOrigin,
          surface: context.surface,
          userAgent: context.userAgent,
        });
      });
    }
    arms.set("personal-pairing-code", async (credential, context) => {
      if (credential.kind !== "personal-pairing-code") throw armMismatch();
      return personal.exchangePairingCode(credential, {
        delivery: context.delivery,
        routeOrigin: context.routeOrigin,
        userAgent: context.userAgent,
      });
    });
  }
  return arms;
}

/**
 * Registers the single session-exchange contract, and only where at least one
 * arm exists. A Deployment with no exchangeable trust root does not answer on
 * this path at all, so "this Deployment cannot be entered with a credential"
 * is a routing fact rather than a per-handler check.
 *
 * Deliberately public: every arm's authority is the one-use, short-lived proof
 * in the body, which is exactly why no session can precede the call.
 */
export function registerSessionExchangeRoute(
  app: FastifyInstance,
  dependencies: SessionExchangeDependencies,
): void {
  const arms = availableSessionExchangeArms(dependencies);
  if (arms.size === 0) return;
  app.post(
    sessionExchangePath,
    { bodyLimit: maximumSessionExchangeBodyBytes },
    async (request, reply) => {
      const media = mediaType(request.headers["content-type"]);
      const requestOrigin =
        typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      const clientAddress = sessionExchangeClientAddress(request);
      // The route this request actually arrived on, read from the ingress the
      // Host already trusts rather than from anything the client states. A
      // native client sends no Origin at all, and a client-supplied one would
      // be the caller naming its own fence.
      const routeOrigin = exchangeRouteOrigin(request);
      const userAgent =
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
      if (media === "application/x-www-form-urlencoded") {
        const credential: BrowserAccountConnectGrantCredential = {
          grant: AccountHostSessionGrantSchema.parse(parseSessionExchangeForm(request.body).grant),
          kind: "account-connect-grant",
        };
        const arm = arms.get("account-connect-grant");
        if (!arm) throw unavailableArm("account-connect-grant");
        const result = await arm(credential, {
          clientAddress,
          delivery: "cookie",
          requestOrigin,
          routeOrigin,
          surface: "browser",
          userAgent,
        });
        copyResponseHeaders(reply, result.headers);
        return reply.header("cache-control", "no-store").redirect("/", 303);
      }
      if (media !== "application/json") throw badContentType();
      const body = SessionExchangeRequestSchema.parse(request.body);
      const credential = SessionExchangeCredentialSchema.parse(body.credential);
      const arm = arms.get(credential.kind);
      if (!arm) throw unavailableArm(credential.kind);
      const result = await arm(credential, {
        clientAddress,
        delivery: body.credentialDelivery,
        requestOrigin,
        routeOrigin,
        // The client declares the delivery it can hold, never the surface it
        // is. Naming the surface the declaration implies is what makes a
        // signed desktop grant asking for a header credential — or a phone's
        // grant asking for a cookie — fail the grant's own surface check.
        surface: jsonExchangeSurfaces[body.credentialDelivery],
        userAgent,
      });
      copyResponseHeaders(reply, result.headers);
      return reply.header("cache-control", "no-store").send(
        SessionExchangeResponseSchema.parse(
          result.issued.delivery === "header"
            ? {
                credential: result.issued.credential,
                credentialDelivery: "header",
                schemaVersion: 2,
                session: result.issued.session,
              }
            : {
                credentialDelivery: "cookie",
                schemaVersion: 2,
                session: result.issued.session,
              },
        ),
      );
    },
  );
}

/**
 * The signed client surface a JSON exchange is claiming, the inverse of the one
 * delivery rule. A `Record` of the delivery union means a new delivery cannot
 * be added without naming the surface that may ask for it, and
 * `session-exchange-routes.test.ts` pins the two directions to each other.
 */
export const jsonExchangeSurfaces = {
  cookie: "desktop",
  header: "native",
} as const satisfies Record<
  PersonalRemoteSessionDelivery,
  Exclude<AccountHostSessionClientSurface, "browser">
>;

function unavailableArm(kind: SessionExchangeCredentialKind): OpensteerError {
  return new OpensteerError({
    code: "not_found",
    message: `This Opensteer does not accept the ${kind} credential`,
  });
}

function armMismatch(): Error {
  return new Error("A session-exchange arm received a credential of another kind");
}

/** The rate-limit subject for an unauthenticated exchange, shared with the
 * browser form flow so both surfaces spend the same per-address budget. */
function sessionExchangeClientAddress(request: FastifyRequest): string {
  const cloudflareAddress = request.headers["cf-connecting-ip"];
  if (typeof cloudflareAddress === "string" && isIP(cloudflareAddress) !== 0) {
    return cloudflareAddress;
  }
  return isIP(request.ip) === 0 ? "unknown" : request.ip;
}

function mediaType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function badContentType(): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: "Session exchange requires JSON or an application/x-www-form-urlencoded form",
  });
}

function parseSessionExchangeForm(body: unknown): { readonly grant: string } {
  if (!Buffer.isBuffer(body) || body.byteLength > maximumSessionExchangeBodyBytes) {
    throw invalidSessionExchangeForm();
  }
  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    throw new OpensteerError({
      cause: error,
      code: "bad_request",
      message: "Session exchange form is invalid",
    });
  }
  const form = new URLSearchParams(serialized);
  if ([...form.keys()].some((key) => key !== "grant") || form.getAll("grant").length !== 1) {
    throw invalidSessionExchangeForm();
  }
  return { grant: form.get("grant") ?? "" };
}

function invalidSessionExchangeForm(): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: "Session exchange form is invalid",
  });
}

/**
 * The access route this request states it arrived on, from the request
 * authority and the forwarded protocol. Shared by both media types.
 *
 * **This is not peer authentication, and must not be read as any.** `Host` and
 * `X-Forwarded-Proto` are request headers: anything that can reach the
 * loopback listener at all can write them, so a caller already holding a valid
 * grant or pairing code can redeem it without having traversed the HTTPS route.
 * Enforcing otherwise needs an authenticated ingress the Host does not have.
 *
 * What the comparison does buy, and why every arm keeps it: the exchange is
 * pinned to one signed route origin and generation, so the session it mints
 * carries that fence into `personalRemoteSessions` and dies with the next
 * rotation. The proofs themselves — the Account's signature over the grant, the
 * one-use `jti` tombstone, the pairing code's single consumption, the envelope
 * hash and the generation equality — are what authorise the exchange, and none
 * of them depends on these headers.
 */
export function exchangeRouteOrigin(request: FastifyRequest): string {
  const host = request.headers.host;
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  if (
    typeof host !== "string" ||
    host.length > 253 ||
    host.includes(",") ||
    (forwardedProtocol !== undefined && forwardedProtocol !== "https")
  ) {
    throw new OpensteerError({ code: "forbidden", message: "Connect route is invalid" });
  }
  const protocol = forwardedProtocol === "https" ? "https:" : `${request.protocol}:`;
  try {
    return new URL(`${protocol}//${host}`).origin;
  } catch (error) {
    throw new OpensteerError({
      cause: error,
      code: "forbidden",
      message: "Connect route is invalid",
    });
  }
}
