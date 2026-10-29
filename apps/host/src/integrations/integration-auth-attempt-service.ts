import { createHash, randomBytes } from "node:crypto";
import { isErasedIntegrationAuthAttemptPayload } from "@opensteer/database";
import {
  integrationProviderIdentityAlreadyConnectedFailureCode,
  IntegrationOAuthAttemptIdSchema,
  type IntegrationOAuthAttemptId,
  type IntegrationConnectionId,
} from "@opensteer/integration-core";
import {
  type IntegrationAuthAttemptFailureReason,
  type IntegrationAuthAttemptFlow,
  type IntegrationAuthAttemptId,
  type IntegrationAuthAttemptStore,
  type IntegrationAuthAttemptSurface,
} from "@opensteer/integration-core/ports";
import type { UserId } from "@opensteer/core";

export const integrationAuthAttemptLifetimeMilliseconds = 10 * 60 * 1_000;

interface AuthAttemptVault {
  open(
    envelope: Buffer,
    context: AuthAttemptSecretContext,
  ): Promise<Readonly<Record<string, string>>>;
  seal(
    value: Readonly<Record<string, string>>,
    context: AuthAttemptSecretContext,
  ): Promise<{ readonly envelope: Buffer; readonly keyVersion: number }>;
}

interface AuthAttemptSecretContext {
  readonly binding: IntegrationAuthAttemptFlow;
  readonly purpose: "integration-auth-attempt";
  readonly recordId: IntegrationAuthAttemptId;
  readonly scope: `user:${string}`;
}

interface AuthorizationPayload {
  readonly authorizationUrl: string;
  readonly payload: Readonly<Record<string, string>>;
}

export type IntegrationAuthorizationPublicStatus =
  "pending" | "launched" | "completed" | "denied" | "failed" | "cancelled" | "expired";

export interface IntegrationAuthAttemptLifecycle {
  begin(input: {
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
    readonly payload: (state: string) => Promise<AuthorizationPayload>;
    readonly surface: IntegrationAuthAttemptSurface;
  }): Promise<{
    readonly attemptId: IntegrationAuthAttemptId;
    readonly expiresAt: Date;
    readonly launchTicket: string;
    readonly state: string;
  }>;
  cancel(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<boolean>;
  claimHosted?(input: {
    readonly id: IntegrationOAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly id: IntegrationOAuthAttemptId;
    readonly ownerUserId: UserId;
    readonly payload: Readonly<Record<string, string>>;
    readonly surface: IntegrationAuthAttemptSurface;
  } | null>;
  claim(input: {
    readonly browserBinding: string;
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly state: string;
  }): Promise<{
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
    readonly payload: Readonly<Record<string, string>>;
    readonly surface: IntegrationAuthAttemptSurface;
  } | null>;
  fail(
    id: IntegrationAuthAttemptId,
    reason: Exclude<IntegrationAuthAttemptFailureReason, "cancelled">,
  ): Promise<void>;
  identifyCallback(input: {
    readonly flow: IntegrationAuthAttemptFlow;
    readonly state: string;
  }): Promise<IntegrationAuthAttemptId | null>;
  inspect?(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<Readonly<Record<string, string>> | null>;
  launch(input: { readonly id: IntegrationAuthAttemptId; readonly launchTicket: string }): Promise<{
    readonly authorizationUrl: string;
    readonly browserBinding: string;
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly surface: IntegrationAuthAttemptSurface;
  } | null>;
  status(input: { readonly id: IntegrationAuthAttemptId; readonly ownerUserId: UserId }): Promise<{
    readonly connectionId: IntegrationConnectionId | null;
    readonly expiresAt: Date;
    readonly failureCode: string | null;
    readonly status: IntegrationAuthorizationPublicStatus;
  } | null>;
}

export class DefaultIntegrationAuthAttemptLifecycle implements IntegrationAuthAttemptLifecycle {
  readonly #now: () => Date;
  readonly #store: IntegrationAuthAttemptStore;
  readonly #vault: AuthAttemptVault;

  constructor(options: {
    readonly now?: () => Date;
    readonly store: IntegrationAuthAttemptStore;
    readonly vault: AuthAttemptVault;
  }) {
    this.#now = options.now ?? (() => new Date());
    this.#store = options.store;
    this.#vault = options.vault;
  }

  async begin(input: {
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
    readonly payload: (state: string) => Promise<AuthorizationPayload>;
    readonly surface: IntegrationAuthAttemptSurface;
  }): Promise<{
    readonly attemptId: IntegrationAuthAttemptId;
    readonly expiresAt: Date;
    readonly launchTicket: string;
    readonly state: string;
  }> {
    const state = randomSecret();
    const launchTicket = randomSecret();
    const now = this.#now();
    await this.#store.deleteExpiredAuthAttempts(now);
    const built = await input.payload(state);
    const authorizationUrl = requireAuthorizationUrl(built.authorizationUrl);
    const sealed = await this.#vault.seal(
      {
        authorizationUrl,
        payload: JSON.stringify(built.payload),
      },
      attemptSecretContext(input),
    );
    const expiresAt = new Date(now.getTime() + integrationAuthAttemptLifetimeMilliseconds);
    await this.#store.createAuthAttempt({
      encryptedPayload: sealed.envelope,
      encryptionKeyVersion: sealed.keyVersion,
      expiresAt,
      flow: input.flow,
      id: input.id,
      launchTicketHash: digestAttemptSecret(launchTicket),
      ownerUserId: input.ownerUserId,
      stateHash: digestAttemptSecret(state),
      surface: input.surface,
    });
    return { attemptId: input.id, expiresAt, launchTicket, state };
  }

  cancel(input: { readonly id: IntegrationAuthAttemptId; readonly ownerUserId: UserId }) {
    return this.#store.cancelAuthAttempt(input);
  }

  async claimHosted(input: {
    readonly id: IntegrationOAuthAttemptId;
    readonly ownerUserId: UserId;
  }) {
    if (!this.#store.claimHostedAuthAttempt) {
      throw new Error("Hosted OAuth attempt claiming is unavailable");
    }
    const attempt = await this.#store.claimHostedAuthAttempt({ ...input, now: this.#now() });
    if (!attempt || isErasedIntegrationAuthAttemptPayload(attempt.encryptedPayload)) return null;
    const opened = await this.#vault.open(
      attempt.encryptedPayload,
      attemptSecretContext({
        flow: "provider-oauth",
        id: attempt.id,
        ownerUserId: attempt.ownerUserId,
      }),
    );
    return {
      id: IntegrationOAuthAttemptIdSchema.parse(attempt.id),
      ownerUserId: attempt.ownerUserId,
      payload: parsePayload(opened),
      surface: attempt.surface,
    };
  }

  async claim(input: {
    readonly browserBinding: string;
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly state: string;
  }): Promise<{
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
    readonly payload: Readonly<Record<string, string>>;
    readonly surface: IntegrationAuthAttemptSurface;
  } | null> {
    const attempt = await this.#store.claimAuthAttempt({
      browserBindingHash: digestAttemptSecret(input.browserBinding),
      flow: input.flow,
      id: input.id,
      now: this.#now(),
      stateHash: digestAttemptSecret(input.state),
    });
    if (!attempt || isErasedIntegrationAuthAttemptPayload(attempt.encryptedPayload)) return null;
    const opened = await this.#vault.open(
      attempt.encryptedPayload,
      attemptSecretContext({
        flow: input.flow,
        id: attempt.id,
        ownerUserId: attempt.ownerUserId,
      }),
    );
    return {
      id: attempt.id,
      ownerUserId: attempt.ownerUserId,
      payload: parsePayload(opened),
      surface: attempt.surface,
    };
  }

  fail(
    id: IntegrationAuthAttemptId,
    reason: Exclude<IntegrationAuthAttemptFailureReason, "cancelled">,
  ): Promise<void> {
    return this.#store.failAuthAttempt({ id, reason });
  }

  async identifyCallback(input: {
    readonly flow: IntegrationAuthAttemptFlow;
    readonly state: string;
  }): Promise<IntegrationAuthAttemptId | null> {
    return (
      (
        await this.#store.findAuthAttemptForCallback({
          flow: input.flow,
          now: this.#now(),
          stateHash: digestAttemptSecret(input.state),
        })
      )?.id ?? null
    );
  }

  async inspect(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<Readonly<Record<string, string>> | null> {
    if (!this.#store.readAuthAttemptPayload) return null;
    const attempt = await this.#store.readAuthAttemptPayload(input);
    // A terminal attempt has had its temporary context erased; report it as having none.
    if (!attempt || isErasedIntegrationAuthAttemptPayload(attempt.encryptedPayload)) return null;
    const opened = await this.#vault.open(
      attempt.encryptedPayload,
      attemptSecretContext({
        flow: "provider-oauth",
        id: attempt.id,
        ownerUserId: attempt.ownerUserId,
      }),
    );
    return parsePayload(opened);
  }

  async launch(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly launchTicket: string;
  }): Promise<{
    readonly authorizationUrl: string;
    readonly browserBinding: string;
    readonly flow: IntegrationAuthAttemptFlow;
    readonly id: IntegrationAuthAttemptId;
    readonly surface: IntegrationAuthAttemptSurface;
  } | null> {
    const browserBinding = randomSecret();
    const attempt = await this.#store.launchAuthAttempt({
      browserBindingHash: digestAttemptSecret(browserBinding),
      id: input.id,
      launchTicketHash: digestAttemptSecret(input.launchTicket),
      now: this.#now(),
    });
    if (!attempt || isErasedIntegrationAuthAttemptPayload(attempt.encryptedPayload)) return null;
    const opened = await this.#vault.open(attempt.encryptedPayload, attemptSecretContext(attempt));
    return {
      authorizationUrl: requireAuthorizationUrl(opened.authorizationUrl),
      browserBinding,
      flow: attempt.flow,
      id: attempt.id,
      surface: attempt.surface,
    };
  }

  async status(input: {
    readonly id: IntegrationAuthAttemptId;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly connectionId: IntegrationConnectionId | null;
    readonly expiresAt: Date;
    readonly failureCode: string | null;
    readonly status: IntegrationAuthorizationPublicStatus;
  } | null> {
    const attempt = await this.#store.getAuthAttempt(input);
    if (!attempt) return null;
    return {
      connectionId: attempt.resultConnectionId,
      expiresAt: attempt.expiresAt,
      failureCode: publicFailureCode(attempt.failureReason),
      status: publicStatus(attempt, this.#now()),
    };
  }
}

function attemptSecretContext(input: {
  readonly flow: IntegrationAuthAttemptFlow;
  readonly id: IntegrationAuthAttemptId;
  readonly ownerUserId: UserId;
}): AuthAttemptSecretContext {
  return {
    binding: input.flow,
    purpose: "integration-auth-attempt",
    recordId: input.id,
    scope: `user:${input.ownerUserId}`,
  };
}

/**
 * Stored attempt hashes are base64url, unlike the hex `digestSecret` in
 * packages/shared; rows already written pin this format.
 */
function digestAttemptSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function parsePayload(opened: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const raw = opened.payload;
  if (typeof raw !== "string") throw new Error("Integration authorization payload is unavailable");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Integration authorization payload is invalid");
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string") throw new Error("Integration authorization payload is invalid");
  }
  return parsed as Readonly<Record<string, string>>;
}

function publicStatus(
  attempt: {
    readonly expiresAt: Date;
    readonly failureReason: IntegrationAuthAttemptFailureReason | null;
    readonly status: "pending" | "launched" | "claimed" | "completed" | "failed";
  },
  now: Date,
): IntegrationAuthorizationPublicStatus {
  if (
    attempt.expiresAt.getTime() <= now.getTime() &&
    attempt.status !== "completed" &&
    attempt.status !== "failed"
  ) {
    return "expired";
  }
  if (attempt.status === "completed") return "completed";
  if (attempt.status === "failed") {
    if (attempt.failureReason === "cancelled") return "cancelled";
    if (attempt.failureReason === "denied") return "denied";
    if (attempt.failureReason === "expired") return "expired";
    return "failed";
  }
  return attempt.status === "pending" ? "pending" : "launched";
}

function publicFailureCode(reason: IntegrationAuthAttemptFailureReason | null): string | null {
  switch (reason) {
    case null:
    case "cancelled":
    case "denied":
    case "exchange-failed":
    case "expired":
      return null;
    case "provider-identity-already-connected":
      return integrationProviderIdentityAlreadyConnectedFailureCode;
    default:
      return reason;
  }
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function requireAuthorizationUrl(value: string | undefined): string {
  if (!value) throw new Error("Integration authorization URL is unavailable");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Integration authorization URL must use HTTP or HTTPS");
  }
  return url.toString();
}
