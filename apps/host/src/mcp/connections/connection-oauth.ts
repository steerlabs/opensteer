import {
  OpensteerError,
  type UserId,
  type AuthSessionId,
  type DeploymentId,
} from "@opensteer/core";
import type { AgentConnectionStore } from "@opensteer/database";
import type {
  AgentConnectionIdentityAtConsent,
  AgentDirectoryDocument,
} from "@opensteer/control-plane-protocol";
import { isIdentityStillVerified } from "@opensteer/database/agent-directory-verification";
import {
  agentConnectionConsentRefusals,
  agentConnectionVerificationChangedMessage,
  agentConnectionMcpPath,
  type HostApiCommand,
} from "@opensteer/protocol";
import { randomBytes, sign, verify, timingSafeEqual, type KeyObject } from "node:crypto";
import { z } from "zod";
import { outsideName } from "@opensteer/shared/outsideName";
import {
  credentialHash,
  connectionCredentialPrefix,
  ConnectionAuthenticator,
} from "./connection-authenticator.js";
import {
  describeIdentity,
  resolveConsentIdentity,
  unverifiedConsentIdentity,
} from "./embedder-assertion.js";

export const mcpResourcePath = agentConnectionMcpPath;
export const mcpIssuerPath = "/oauth/mcp";
export const mcpResourceMetadataPath = `/.well-known/oauth-protected-resource${agentConnectionMcpPath}`;
export const mcpServerMetadataPath = "/.well-known/oauth-authorization-server/oauth/mcp";
const consentTtl = 10 * 60_000;
const codeTtl = 60_000;
const connectionTtl = 30 * 24 * 60 * 60_000;
const maximumPending = 1_000;
const opaqueId = () => randomBytes(32).toString("base64url");
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;
const RedirectValueSchema = z.string().min(1).max(2048);
const RedirectSchema = RedirectValueSchema.refine(validRedirect);
const ClientSchema = z.object({
  v: z.literal(1),
  issuer: z.string(),
  name: z.string().min(1).max(100),
  redirects: z.array(RedirectSchema).min(1).max(5),
});
type Client = z.infer<typeof ClientSchema>;
const defaultClientName = "MCP client";
/** A client's own name enters the Home clean, as every name from outside does. */
function sanitizeClientName(name: string): string {
  return outsideName(name, 100);
}
const RegistrationSchema = z.object({
  client_name: z
    .string()
    .transform(sanitizeClientName)
    .pipe(z.string().min(1).max(100))
    .default(defaultClientName),
  redirect_uris: z.array(z.string()).min(1).max(5),
});
const ScopeSchema = z
  .string()
  .max(2048)
  .regex(/^(?:[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*)?$/u)
  .optional();
const AuthorizationSchema = z.object({
  client_id: z.string().max(16_384),
  redirect_uri: RedirectSchema,
  response_type: z.literal("code"),
  code_challenge: z.string().regex(challengePattern),
  code_challenge_method: z.literal("S256"),
  resource: z.unknown().optional(),
  state: z.string().max(2048).optional(),
  scope: ScopeSchema,
  /** A per-request proof, signed by the product that embeds this platform, that it asked. */
  opensteer_embedder_assertion: z.unknown().optional(),
});
const TokenSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().regex(challengePattern),
  client_id: z.string().max(16_384),
  redirect_uri: RedirectSchema,
  code_verifier: z.string().regex(verifierPattern),
  resource: z.unknown().optional(),
});
type Authorization = Omit<z.infer<typeof AuthorizationSchema>, "resource"> & { resource: string };
interface Consent {
  readonly authorization: Authorization;
  readonly client: Client;
  readonly origin: string;
  readonly expiresAt: number;
  readonly identityAtConsent: AgentConnectionIdentityAtConsent;
  decision?: {
    userId: UserId;
    sessionId: AuthSessionId;
    fingerprint: string;
    connectionId: string | null;
  };
  approving?: boolean;
  verificationChanged?: boolean;
}
interface Code {
  readonly authorization: Authorization;
  readonly connectionId: string;
  readonly origin: string;
  readonly expiresAt: number;
}
export class ConnectionOAuthError extends Error {
  readonly error: string;
  readonly status: number;
  constructor(error: string, status = 400) {
    super(error);
    this.error = error;
    this.status = status;
  }
}

interface ConnectionOAuthOptions {
  readonly deploymentId: DeploymentId;
  readonly store: AgentConnectionStore;
  readonly signingKey: KeyObject;
  readonly verificationKey: KeyObject;
  readonly now?: () => number;
  readonly onMaintenanceChanged?: () => void;
  /**
   * The Account-signed directory of known agents, from the Home's own Account origin. Absent when
   * the Home has none: every client is then shown as the name it gave itself.
   */
  readonly directory?: {
    issuer?: string;
    get(): Promise<AgentDirectoryDocument | null>;
    current(): AgentDirectoryDocument | null;
  };
}

export class ConnectionOAuthRedirectError extends ConnectionOAuthError {
  readonly redirect: string;
  constructor(error: string, redirectUri: string, issuer: string, state: string | undefined) {
    super(error);
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("iss", issuer);
    if (state !== undefined) url.searchParams.set("state", state);
    this.redirect = url.toString();
  }
}

export class ConnectionOAuth {
  readonly authenticator: ConnectionAuthenticator;
  readonly #consents = new Map<string, Consent>();
  /** Requests answered and sent back to the agent, so a late read says so instead of "expired". */
  readonly #answered = new Map<string, number>();
  readonly #codes = new Map<string, Code>();
  readonly #options: ConnectionOAuthOptions;
  constructor(options: ConnectionOAuthOptions) {
    this.#options = options;
    this.authenticator = new ConnectionAuthenticator(options.store);
  }
  get store() {
    return this.#options.store;
  }
  #now() {
    return this.#options.now?.() ?? Date.now();
  }
  #sweep() {
    const now = this.#now();
    for (const [key, value] of this.#consents)
      if (value.expiresAt <= now && !value.approving) this.#consents.delete(key);
    for (const [key, value] of this.#codes) if (value.expiresAt <= now) this.#codes.delete(key);
    for (const [key, until] of this.#answered) if (until <= now) this.#answered.delete(key);
  }
  close() {
    this.#consents.clear();
    this.#answered.clear();
    this.#codes.clear();
  }

  register(origin: string, input: unknown) {
    const parsed = RegistrationSchema.safeParse(input);
    if (!parsed.success) throw new ConnectionOAuthError("invalid_client_metadata");
    const redirects = parsed.data.redirect_uris.filter(
      (uri) => RedirectSchema.safeParse(uri).success,
    );
    if (!redirects.length) throw new ConnectionOAuthError("invalid_client_metadata");
    const client: Client = {
      v: 1,
      issuer: origin + mcpIssuerPath,
      name: parsed.data.client_name,
      redirects,
    };
    const body = Buffer.from(JSON.stringify(client)).toString("base64url");
    const signature = sign(
      null,
      Buffer.from(`opensteer-mcp-client-v1.${body}`),
      this.#options.signingKey,
    ).toString("base64url");
    return {
      client_id: `${body}.${signature}`,
      client_name: client.name,
      redirect_uris: client.redirects,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };
  }
  #client(clientId: string, origin: string): Client {
    const [body, signature, extra] = clientId.split(".");
    if (
      !body ||
      !signature ||
      extra ||
      clientId.length > 16_384 ||
      !/^[A-Za-z0-9_-]+$/.test(signature) ||
      !verify(
        null,
        Buffer.from(`opensteer-mcp-client-v1.${body}`),
        this.#options.verificationKey,
        Buffer.from(signature, "base64url"),
      )
    )
      throw new ConnectionOAuthError("invalid_client");
    try {
      const client = ClientSchema.parse(
        JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
      );
      if (client.issuer !== origin + mcpIssuerPath) throw new Error();
      return { ...client, name: sanitizeClientName(client.name) || defaultClientName };
    } catch {
      throw new ConnectionOAuthError("invalid_client");
    }
  }
  async authorize(origin: string, input: unknown): Promise<string> {
    const boundary = AuthorizationSchema.pick({ client_id: true, state: true })
      .extend({ redirect_uri: RedirectValueSchema })
      .safeParse(input);
    if (!boundary.success) throw new ConnectionOAuthError("invalid_request");
    const client = this.#client(boundary.data.client_id, origin);
    if (!client.redirects.some((uri) => redirectMatches(uri, boundary.data.redirect_uri)))
      throw new ConnectionOAuthError("invalid_redirect_uri");
    const refusal = (error: string) =>
      new ConnectionOAuthRedirectError(
        error,
        boundary.data.redirect_uri,
        origin + mcpIssuerPath,
        boundary.data.state,
      );
    const parsed = AuthorizationSchema.safeParse(input);
    if (!parsed.success) {
      const response = z
        .object({ response_type: z.unknown(), scope: z.unknown().optional() })
        .parse(input);
      throw refusal(
        response.response_type !== "code"
          ? "unsupported_response_type"
          : !ScopeSchema.safeParse(response.scope).success
            ? "invalid_scope"
            : "invalid_request",
      );
    }
    const resource = origin + mcpResourcePath;
    if (!matchesResource(parsed.data.resource, resource)) throw refusal("invalid_target");
    const authorization = { ...parsed.data, resource };
    const identity = await resolveConsentIdentity({
      directory: (await this.#options.directory?.get()) ?? null,
      clientName: client.name,
      assertion: authorization.opensteer_embedder_assertion,
      request: {
        clientId: authorization.client_id,
        issuer: origin + mcpIssuerPath,
        redirectUri: authorization.redirect_uri,
        codeChallenge: authorization.code_challenge,
        state: authorization.state,
      },
      now: () => this.#now(),
      claim: async (issuer, id, expiresAt) => {
        const accepted = await this.store.claimEmbedderAssertion(issuer, id, expiresAt);
        this.#options.onMaintenanceChanged?.();
        return accepted;
      },
    });
    this.#sweep();
    if (this.#consents.size >= maximumPending)
      throw new ConnectionOAuthError("temporarily_unavailable", 503);
    const id = opaqueId();
    this.#consents.set(credentialHash(id), {
      authorization,
      client,
      origin,
      expiresAt: this.#now() + consentTtl,
      identityAtConsent: identity,
    });
    return `/mcp-authorization?request=${id}&deploymentId=${this.#options.deploymentId}`;
  }
  #consent(requestId: string, origin?: string): Consent {
    const key = credentialHash(requestId);
    const pending = this.#consents.get(key);
    if (
      !pending ||
      pending.expiresAt <= this.#now() ||
      (origin !== undefined && pending.origin !== origin)
    ) {
      const answered = (this.#answered.get(key) ?? 0) > this.#now();
      throw new OpensteerError({
        code: "not_found",
        reason: answered
          ? agentConnectionConsentRefusals.answered
          : agentConnectionConsentRefusals.expired,
        message: answered
          ? "This agent connection request was already answered."
          : "This agent connection request expired. Start again from the agent.",
      });
    }
    return pending;
  }
  async #currentConsentIdentity(pending: Consent): Promise<AgentConnectionIdentityAtConsent> {
    const evidence = pending.identityAtConsent;
    if (evidence.kind === "unverified") return evidence;
    const directory = this.#options.directory?.current() ?? null;
    if (await isIdentityStillVerified(evidence, directory)) return evidence;
    pending.verificationChanged = true;
    return unverifiedConsentIdentity(
      pending.authorization.redirect_uri,
      pending.client.name,
      directory,
      evidence.recordedAt,
    );
  }

  async consent(requestId: string, _userId: UserId) {
    const pending = this.#consent(requestId);
    const identity = await this.#currentConsentIdentity(pending);
    return {
      requestId,
      clientName: pending.client.name,
      redirectUri: pending.authorization.redirect_uri,
      resource: pending.authorization.resource,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      identityAtConsent: identity,
      identity: presentIdentity(identity),
      verificationSnapshot: verificationSnapshot(requestId, identity),
    };
  }
  async decide(
    command: Extract<HostApiCommand, { type: "connection.authorize" }>,
    userId: UserId,
    sessionId: AuthSessionId,
  ) {
    const pending = this.#consent(command.requestId);
    const fingerprint = JSON.stringify(command.decision);
    if (pending.approving)
      throw new OpensteerError({
        code: "conflict",
        message: "This request is already being approved.",
      });
    if (pending.decision) {
      if (
        pending.decision.userId !== userId ||
        pending.decision.sessionId !== sessionId ||
        pending.decision.fingerprint !== fingerprint
      )
        throw new OpensteerError({
          code: "conflict",
          message: "This connection request has already been answered.",
        });
    } else {
      pending.approving = true;
      try {
        const decision = command.decision;
        let connectionId: string | null = null;
        if (decision.kind === "approve") {
          const identity = await this.#currentConsentIdentity(pending);
          const expected = verificationSnapshot(command.requestId, identity);
          if (
            decision.verificationSnapshot !== undefined
              ? decision.verificationSnapshot !== expected
              : pending.verificationChanged
          ) {
            throw new OpensteerError({
              code: "conflict",
              reason: agentConnectionConsentRefusals.verificationChanged,
              message: agentConnectionVerificationChangedMessage,
            });
          }
          const connection = await this.store.create({
            userId,
            label: decision.label,
            clientName: pending.client.name,
            accessMode: decision.accessMode,
            resource: pending.authorization.resource,
            expiresAt: new Date(this.#now() + connectionTtl),
            clientFingerprint: credentialHash(pending.authorization.client_id),
            redirectUri: pending.authorization.redirect_uri,
            identityAtConsent: identity,
            ...(this.#options.directory?.issuer
              ? { directoryIssuer: this.#options.directory.issuer }
              : {}),
            ...(decision.grant ? { grant: decision.grant } : {}),
          });
          connectionId = connection.id;
          this.#options.onMaintenanceChanged?.();
        }
        pending.decision = { userId, sessionId, fingerprint, connectionId };
      } finally {
        pending.approving = false;
      }
    }
    return {
      type: "connection.authorize" as const,
      completionPath: `/oauth/mcp/complete?request=${command.requestId}`,
    };
  }
  complete(requestId: string, origin: string): string {
    const pending = this.#consent(requestId, origin);
    if (!pending.decision)
      throw new OpensteerError({
        code: "forbidden",
        message: "Approve this agent in Opensteer first.",
      });
    this.#sweep();
    if (this.#codes.size >= maximumPending)
      throw new ConnectionOAuthError("temporarily_unavailable", 503);
    this.#consents.delete(credentialHash(requestId));
    if (this.#answered.size < maximumPending)
      this.#answered.set(credentialHash(requestId), this.#now() + consentTtl);
    const redirect = new URL(pending.authorization.redirect_uri);
    redirect.searchParams.set("iss", origin + mcpIssuerPath);
    if (pending.authorization.state !== undefined)
      redirect.searchParams.set("state", pending.authorization.state);
    if (pending.decision.connectionId === null) redirect.searchParams.set("error", "access_denied");
    else {
      const code = opaqueId();
      this.#codes.set(credentialHash(code), {
        authorization: pending.authorization,
        connectionId: pending.decision.connectionId,
        origin,
        expiresAt: this.#now() + codeTtl,
      });
      redirect.searchParams.set("code", code);
    }
    return redirect.toString();
  }
  async exchange(origin: string, input: unknown) {
    // Spend a presented code before checking its binding, even on a failed exchange.
    const rawCode = z.object({ code: z.string().max(256) }).safeParse(input);
    const key = rawCode.success ? credentialHash(rawCode.data.code) : "";
    const pending = this.#codes.get(key);
    this.#codes.delete(key);
    const grant = z.object({ grant_type: z.string() }).safeParse(input);
    if (grant.success && grant.data.grant_type !== "authorization_code")
      throw new ConnectionOAuthError("unsupported_grant_type");
    const parsed = TokenSchema.safeParse(input);
    if (!parsed.success) throw new ConnectionOAuthError("invalid_grant");
    const token = parsed.data;
    this.#client(token.client_id, origin);
    if (
      !pending ||
      pending.expiresAt <= this.#now() ||
      pending.origin !== origin ||
      token.client_id !== pending.authorization.client_id ||
      token.redirect_uri !== pending.authorization.redirect_uri ||
      !equalChallenge(token.code_verifier, pending.authorization.code_challenge)
    )
      throw new ConnectionOAuthError("invalid_grant");
    const resource = pending.authorization.resource;
    if (!matchesResource(token.resource, resource))
      throw new ConnectionOAuthError("invalid_target");
    const credential = connectionCredentialPrefix + opaqueId();
    if (!(await this.store.activate(pending.connectionId, credentialHash(credential))))
      throw new ConnectionOAuthError("invalid_grant");
    const connection = await this.store.authenticate(credentialHash(credential), resource);
    if (!connection?.expiresAt) throw new ConnectionOAuthError("invalid_grant");
    return {
      access_token: credential,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((Date.parse(connection.expiresAt) - this.#now()) / 1000)),
      scope: "opensteer",
    };
  }
}
function verificationSnapshot(
  requestId: string,
  identity: AgentConnectionIdentityAtConsent,
): string {
  return credentialHash(`${requestId}:${identity.kind}`);
}

/** The consent wording for a recorded identity, as the Host API carries it. */
export function presentIdentity(identity: AgentConnectionIdentityAtConsent) {
  const presentation = describeIdentity(identity);
  return { ...presentation, origins: [...presentation.origins] };
}
function matchesResource(requested: unknown, canonical: string): boolean {
  return requested === undefined || requested === canonical || requested === `${canonical}/`;
}
function equalChallenge(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(credentialHashBase64(verifier));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function credentialHashBase64(value: string) {
  return Buffer.from(credentialHash(value), "hex").toString("base64url");
}
function validRedirect(value: string): boolean {
  if (value.includes("#")) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function redirectMatches(registered: string, presented: string): boolean {
  if (!validRedirect(registered) || !validRedirect(presented)) return false;
  const left = new URL(registered),
    right = new URL(presented);
  if (left.protocol === "https:" || right.protocol === "https:") return registered === presented;
  return (
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.pathname === right.pathname &&
    left.search === right.search
  );
}
