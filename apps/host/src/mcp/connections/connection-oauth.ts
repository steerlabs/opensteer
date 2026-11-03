import {
  OpensteerError,
  type UserId,
  type AuthSessionId,
  type DeploymentId,
} from "@opensteer/core";
import type { AgentConnectionStore } from "@opensteer/database";
import type { HostApiCommand } from "@opensteer/protocol";
import { randomBytes, sign, verify, timingSafeEqual, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  credentialHash,
  connectionCredentialPrefix,
  ConnectionAuthenticator,
} from "./connection-authenticator.js";

export const mcpResourcePath = "/internal/v1/mcp";
export const mcpIssuerPath = "/oauth/mcp";
export const mcpResourceMetadataPath = "/.well-known/oauth-protected-resource/internal/v1/mcp";
export const mcpServerMetadataPath = "/.well-known/oauth-authorization-server/oauth/mcp";
const consentTtl = 10 * 60_000;
const codeTtl = 60_000;
const connectionTtl = 30 * 24 * 60 * 60_000;
const maximumPending = 1_000;
const opaqueId = () => randomBytes(32).toString("base64url");
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;
const RedirectSchema = z.string().min(1).max(2048).refine(validRedirect);
const ClientSchema = z.object({
  v: z.literal(1),
  issuer: z.string(),
  name: z.string().min(1).max(100),
  redirects: z.array(RedirectSchema).min(1).max(5),
});
type Client = z.infer<typeof ClientSchema>;
const RegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(100).default("MCP client"),
  redirect_uris: z.array(RedirectSchema).min(1).max(5),
});
const AuthorizationSchema = z.object({
  client_id: z.string().max(16_384),
  redirect_uri: RedirectSchema,
  response_type: z.literal("code"),
  code_challenge: z.string().regex(challengePattern),
  code_challenge_method: z.literal("S256"),
  resource: z.string().max(2048),
  state: z.string().max(2048).optional(),
  scope: z.literal("opensteer").optional(),
});
const TokenSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().regex(challengePattern),
  client_id: z.string().max(16_384),
  redirect_uri: RedirectSchema,
  code_verifier: z.string().regex(verifierPattern),
  resource: z.string().max(2048),
});
type Authorization = z.infer<typeof AuthorizationSchema>;
interface Consent {
  readonly authorization: Authorization;
  readonly client: Client;
  readonly origin: string;
  readonly expiresAt: number;
  decision?: {
    userId: UserId;
    sessionId: AuthSessionId;
    fingerprint: string;
    connectionId: string | null;
  };
  approving?: boolean;
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
  }
  close() {
    this.#consents.clear();
    this.#codes.clear();
  }

  register(origin: string, input: unknown) {
    const parsed = RegistrationSchema.safeParse(input);
    if (!parsed.success) throw new ConnectionOAuthError("invalid_client_metadata");
    const client: Client = {
      v: 1,
      issuer: origin + mcpIssuerPath,
      name: parsed.data.client_name,
      redirects: parsed.data.redirect_uris,
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
      return client;
    } catch {
      throw new ConnectionOAuthError("invalid_client");
    }
  }
  authorize(origin: string, input: unknown): string {
    const boundary = AuthorizationSchema.pick({
      client_id: true,
      redirect_uri: true,
      state: true,
    }).safeParse(input);
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
          : response.scope !== undefined && response.scope !== "opensteer"
            ? "invalid_scope"
            : "invalid_request",
      );
    }
    const authorization = parsed.data;
    if (authorization.resource !== origin + mcpResourcePath) throw refusal("invalid_target");
    this.#sweep();
    if (this.#consents.size >= maximumPending)
      throw new ConnectionOAuthError("temporarily_unavailable", 503);
    const id = opaqueId();
    this.#consents.set(credentialHash(id), {
      authorization,
      client,
      origin,
      expiresAt: this.#now() + consentTtl,
    });
    return `/mcp-authorization?request=${id}&deploymentId=${this.#options.deploymentId}`;
  }
  #consent(requestId: string, origin?: string): Consent {
    const pending = this.#consents.get(credentialHash(requestId));
    if (
      !pending ||
      pending.expiresAt <= this.#now() ||
      (origin !== undefined && pending.origin !== origin)
    )
      throw new OpensteerError({
        code: "not_found",
        message: "This agent connection request expired. Start again from the agent.",
      });
    return pending;
  }
  async consent(requestId: string, userId: UserId) {
    const pending = this.#consent(requestId);
    return {
      requestId,
      clientName: pending.client.name,
      redirectUri: pending.authorization.redirect_uri,
      resource: pending.authorization.resource,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      workspaces: await this.store.workspaces(userId),
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
        const connection =
          command.decision.kind === "deny"
            ? null
            : await this.store.create({
                userId,
                label: command.decision.label,
                clientName: pending.client.name,
                accessMode: command.decision.accessMode,
                reach: command.decision.reach,
                resource: pending.authorization.resource,
                expiresAt: new Date(this.#now() + connectionTtl),
              });
        pending.decision = { userId, sessionId, fingerprint, connectionId: connection?.id ?? null };
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
      token.resource !== origin + mcpResourcePath ||
      pending.authorization.resource !== token.resource ||
      token.client_id !== pending.authorization.client_id ||
      token.redirect_uri !== pending.authorization.redirect_uri ||
      !equalChallenge(token.code_verifier, pending.authorization.code_challenge)
    )
      throw new ConnectionOAuthError("invalid_grant");
    const credential = connectionCredentialPrefix + opaqueId();
    if (!(await this.store.activate(pending.connectionId, credentialHash(credential))))
      throw new ConnectionOAuthError("invalid_grant");
    const connection = await this.store.authenticate(credentialHash(credential), token.resource);
    if (!connection) throw new ConnectionOAuthError("invalid_grant");
    return {
      access_token: credential,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((Date.parse(connection.expiresAt) - this.#now()) / 1000)),
      scope: "opensteer",
    };
  }
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
