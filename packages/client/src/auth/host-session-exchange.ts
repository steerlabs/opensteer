import { readBoundedJson } from "@opensteer/shared/boundedJson";
import {
  IssueAccountHostSessionGrantResponseSchema,
  PersonalHostAccessAuthoritySchema,
  type AccountHostSessionClientSurface,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema, type NativeOAuthApplication } from "@opensteer/core";
import {
  PersonalPairingCodeSchema,
  SessionExchangeRequestSchema,
  SessionExchangeResponseSchema,
  sessionExchangeDeliveryForClientSurface,
  sessionExchangePath,
  type SessionExchangeCredential,
  type SessionExchangeResponse,
} from "@opensteer/protocol";
import {
  AccountRequestError,
  type AccountDeploymentDirectoryService,
  type AccountHostSessionGrant,
} from "../connections/account-deployment-directory.js";
import type { HostBootstrapMethod } from "@opensteer/deployment-authority";
import type { DesktopAccess, ResolvedConnection } from "../connections/connection-resolver.js";
import { ClientOperationError, unrefTimer } from "../connections/operation-error.js";
import { HostTransportError } from "../connections/host-transport-error.js";

const defaultRequestTimeoutMs = 15_000;
const unauthenticatedCooldownMs = 5_000;
const maximumSessionResponseBytes = 64 * 1_024;

const blockedDetail = "This Opensteer no longer admits your Account. Ask its administrator.";
const pairingDetail = "Enter a new pairing code from the computer that hosts this Opensteer.";

/**
 * Why a credential could not be turned into a Host session.
 * `account-required` belongs to Account authorization, `pairing-required` to a
 * proof only the operator can carry, `blocked` to Host admission, and transport
 * failures remain `unavailable` rather than being misreported as either.
 */
export type HostSessionExchangeFailure =
  "account-required" | "blocked" | "pairing-required" | "unavailable";

export class HostSessionExchangeError extends ClientOperationError {
  readonly outcome: HostSessionExchangeFailure;

  constructor(outcome: HostSessionExchangeFailure, message: string) {
    super(message, outcome === "unavailable" ? "transient" : "blocked");
    this.name = "HostSessionExchangeError";
    this.outcome = outcome;
  }
}

export type SessionExchangeAccount = Pick<
  AccountDeploymentDirectoryService,
  "issuePersonalHostSessionGrant"
>;

export type SessionExchangeFetch = (
  deploymentId: string,
  input: URL | RequestInfo,
  init: RequestInit,
) => Promise<Response>;

/**
 * Which client surface this build asks the Account to sign its grants for, and
 * with it the credential delivery the Host will use. It follows from the
 * application's own OAuth identity rather than being chosen per call, so the
 * phone cannot request the desktop's cookie delivery or the reverse.
 */
const clientSurfaces = {
  desktop: "desktop",
  mobile: "native",
} as const satisfies Record<
  NativeOAuthApplication,
  Exclude<AccountHostSessionClientSurface, "browser">
>;

/**
 * Which arm of the one session-exchange contract this attachment can present.
 * `null` means the attachment does not exchange a credential at all: a
 * self-hosted Host signs the person in itself, and a Personal Host running on
 * this machine already owns its owner session. Pure and total — the access
 * arm was decided by the resolver, never again here.
 */
export function credentialKindFor(
  access: DesktopAccess,
  bootstrapMethods: readonly HostBootstrapMethod[],
): SessionExchangeCredential["kind"] | null {
  for (const method of bootstrapMethods) {
    if (method === "connect-grant" && access === "connect") return "account-connect-grant";
    if (method === "pairing-code" && access === "private") return "personal-pairing-code";
  }
  return null;
}

/**
 * Opens a Host session for this Deployment through the one
 * `/v1/auth/session-exchange` contract, whichever application is asking: the
 * desktop's Electron partition, or a phone that keeps the session itself.
 *
 * The arm follows from the verified attachment, never from a caller-chosen
 * mode: a Personal Connect route presents the Account grant bound to that signed route,
 * and a Personal Private route presents the one-use pairing code the operator
 * carried off the host computer. Nothing is persisted here: under cookie
 * delivery the HttpOnly partition cookie the Host sets is the only durable
 * credential, and under header delivery the established session is handed back
 * for the application that owns a credential store to keep.
 */
export class HostSessionExchange {
  readonly #account: SessionExchangeAccount;
  readonly #clientSurface: Exclude<AccountHostSessionClientSurface, "browser">;
  readonly #fetch: SessionExchangeFetch;
  readonly #now: () => Date;
  readonly #probes = new Map<string, Promise<"authenticated" | "blocked" | "unauthenticated">>();
  readonly #requestTimeoutMs: number;
  readonly #unauthenticatedUntil = new Map<string, number>();

  constructor(options: {
    readonly account: SessionExchangeAccount;
    readonly application: NativeOAuthApplication;
    readonly fetch: SessionExchangeFetch;
    readonly now?: () => Date;
    readonly requestTimeoutMs?: number;
  }) {
    this.#account = options.account;
    this.#clientSurface = clientSurfaces[options.application];
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#requestTimeoutMs = boundedDuration(
      options.requestTimeoutMs ?? defaultRequestTimeoutMs,
      "Session exchange request timeout",
    );
  }

  supports(resolved: ResolvedConnection): boolean {
    return credentialKindFor(resolved.access, resolved.bootstrapMethods) !== null;
  }

  /**
   * Exchanges this attachment's credential, replacing whatever session the
   * partition holds. A Private route needs the operator's pairing code; without
   * one it fails as `pairing-required` rather than inventing a credential.
   */
  async establish(
    resolved: ResolvedConnection,
    options: { readonly pairingCode?: string } = {},
  ): Promise<SessionExchangeResponse> {
    const kind = this.#requireKind(resolved);
    const delivery = sessionExchangeDeliveryForClientSurface(this.#clientSurface);
    if (resolved.route === null) {
      throw new Error("This Opensteer attachment does not use a signed access route.");
    }
    const route = resolved.route;
    const key = resolved.key;
    this.#unauthenticatedUntil.delete(key);
    let credential: SessionExchangeCredential;
    let accountSignal: AbortSignal | undefined;
    if (kind === "personal-pairing-code") {
      if (options.pairingCode === undefined) {
        throw this.#fail(key, new HostSessionExchangeError("pairing-required", pairingDetail));
      }
      credential = {
        code: PersonalPairingCodeSchema.parse(options.pairingCode),
        expectedRoute: route.document,
        kind: "personal-pairing-code",
      };
    } else {
      let leased: AccountHostSessionGrant;
      try {
        leased = await this.#leaseGrant(resolved);
        leased.signal.throwIfAborted();
      } catch (error) {
        throw this.#fail(key, accountFailure(error));
      }
      const grant = IssueAccountHostSessionGrantResponseSchema.parse(leased.response).grant;
      accountSignal = leased.signal;
      credential = { expectedRoute: route, grant, kind: "account-connect-grant" };
    }

    try {
      return await this.#request(
        resolved,
        sessionExchangePath,
        {
          body: JSON.stringify(
            SessionExchangeRequestSchema.parse({
              credential,
              credentialDelivery: delivery,
              schemaVersion: 2,
            }),
          ),
          method: "POST",
        },
        async (response, signal) => {
          if (!response.ok) {
            throw this.#fail(key, exchangeFailure(kind, response.status));
          }
          let payload: unknown;
          try {
            payload = await readBoundedJson(response, { ...boundedJsonOptions, signal });
          } catch {
            if (signal.aborted) throw signal.reason;
            throw this.#fail(
              key,
              new HostSessionExchangeError(
                "unavailable",
                "This Opensteer returned an invalid session response.",
              ),
            );
          }
          const established = SessionExchangeResponseSchema.parse(payload);
          if (established.credentialDelivery !== delivery) {
            throw this.#fail(
              key,
              new HostSessionExchangeError(
                "unavailable",
                "This Opensteer returned a session in the wrong form.",
              ),
            );
          }
          this.#unauthenticatedUntil.delete(key);
          // Under cookie delivery the partition cookie the Host just set is the only
          // credential kept; under header delivery the caller owns the returned one,
          // because only the application knows where a credential may be stored.
          return established;
        },
        accountSignal,
      );
    } catch (error) {
      if (error instanceof HostSessionExchangeError) throw error;
      throw this.#fail(
        key,
        new HostSessionExchangeError(
          "unavailable",
          error instanceof HostTransportError
            ? error.message
            : "This Opensteer could not be reached.",
        ),
      );
    }
  }

  /**
   * Whether the partition already holds a usable session. `blocked` is a real
   * answer rather than an exception so every attachment method reports Host
   * admission the same way.
   */
  async probe(
    resolved: ResolvedConnection,
  ): Promise<"authenticated" | "blocked" | "unauthenticated"> {
    this.#requireKind(resolved);
    const key = resolved.key;
    const until = this.#unauthenticatedUntil.get(key);
    if (until !== undefined && this.#now().getTime() < until) return "unauthenticated";
    const existing = this.#probes.get(key);
    if (existing) return existing;
    const probe = this.#probe(resolved, key);
    this.#probes.set(key, probe);
    try {
      return await probe;
    } finally {
      if (this.#probes.get(key) === probe) this.#probes.delete(key);
    }
  }

  async #probe(
    resolved: ResolvedConnection,
    key: string,
  ): Promise<"authenticated" | "blocked" | "unauthenticated"> {
    return this.#request(resolved, "/v1/auth/session", { method: "GET" }, async (response) => {
      await response.body?.cancel();
      if (response.status === 401) {
        this.#unauthenticatedUntil.set(key, this.#now().getTime() + unauthenticatedCooldownMs);
        return "unauthenticated";
      }
      if (response.status === 403 || response.status === 404) return "blocked";
      if (!response.ok) {
        throw new HostSessionExchangeError("unavailable", "This Opensteer could not be reached.");
      }
      this.#unauthenticatedUntil.delete(key);
      return "authenticated";
    });
  }

  #leaseGrant(resolved: ResolvedConnection): Promise<AccountHostSessionGrant> {
    if (resolved.access !== "connect" || resolved.route === null) {
      throw new Error("An Account grant requires a Connect route.");
    }
    const deploymentId = DeploymentIdSchema.parse(resolved.deploymentId);
    return this.#account.issuePersonalHostSessionGrant(deploymentId, {
      clientSurface: this.#clientSurface,
      expectedAuthority: PersonalHostAccessAuthoritySchema.parse(resolved.route.document.authority),
      expectedRoute: resolved.route,
      targetKind: "personal-connect",
    });
  }

  #requireKind(resolved: ResolvedConnection): SessionExchangeCredential["kind"] {
    const kind = credentialKindFor(resolved.access, resolved.bootstrapMethods);
    if (!kind) {
      throw new Error("This Opensteer attachment does not open a session from a credential.");
    }
    return kind;
  }

  #fail(key: string, error: HostSessionExchangeError): HostSessionExchangeError {
    this.#unauthenticatedUntil.set(key, this.#now().getTime() + unauthenticatedCooldownMs);
    return error;
  }

  async #request<Result>(
    resolved: ResolvedConnection,
    path: string,
    input: { readonly body?: string; readonly method: "GET" | "POST" },
    read: (response: Response, signal: AbortSignal) => Promise<Result>,
    accountSignal?: AbortSignal,
  ): Promise<Result> {
    // The grant audience is this origin, and the cookie the Host sets must land
    // on the origin every later Host request uses. A remote Personal session
    // opens only on its separately signed access route, which is what the
    // resolver already selected.
    const origin: string = resolved.origin;
    const endpoint = new URL(path, origin).toString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new HostTransportError("timed-out")),
      this.#requestTimeoutMs,
    );
    unrefTimer(timeout);
    const relayAccountAbort = () => controller.abort(accountSignal?.reason);
    if (accountSignal?.aborted) relayAccountAbort();
    else accountSignal?.addEventListener("abort", relayAccountAbort, { once: true });
    try {
      controller.signal.throwIfAborted();
      const response = await this.#fetch(resolved.deploymentId, endpoint, {
        ...(input.body === undefined ? {} : { body: input.body }),
        cache: "no-store",
        credentials: "include",
        headers: {
          accept: "application/json",
          origin,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        method: input.method,
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        throw new Error("Opensteer session requests must not redirect.");
      }
      return await read(response, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      controller.abort();
      clearTimeout(timeout);
      accountSignal?.removeEventListener("abort", relayAccountAbort);
    }
  }
}

function accountFailure(error: unknown): HostSessionExchangeError {
  if (error instanceof AccountRequestError) {
    if (error.status === 401) {
      return new HostSessionExchangeError(
        "account-required",
        "Sign in to your Opensteer Account again to reconnect this Opensteer.",
      );
    }
    if (error.status === 403 || error.status === 404) {
      return new HostSessionExchangeError("blocked", blockedDetail);
    }
  }
  return new HostSessionExchangeError(
    "unavailable",
    "Opensteer Cloud could not authorize this Opensteer right now.",
  );
}

function exchangeFailure(
  kind: SessionExchangeCredential["kind"],
  status: number,
): HostSessionExchangeError {
  if (status === 401 || status === 403 || status === 404) {
    return kind === "personal-pairing-code"
      ? new HostSessionExchangeError("pairing-required", pairingDetail)
      : new HostSessionExchangeError("blocked", blockedDetail);
  }
  return new HostSessionExchangeError(
    "unavailable",
    "This Opensteer could not open a session right now.",
  );
}

const boundedJsonOptions = {
  expectedContentType: "application/json",
  maximumBytes: maximumSessionResponseBytes,
  sizeError: () => new Error("This Opensteer session response is too large."),
  unexpectedContentTypeError: () =>
    new Error("This Opensteer returned an unexpected content type."),
} as const;

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}
