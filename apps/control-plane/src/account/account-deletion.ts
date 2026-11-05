import { randomUUID } from "node:crypto";
import {
  ConnectOperationIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { decryptOAuthToken } from "better-auth/oauth2";
import type { ControlPlaneAuth } from "../auth/auth.js";
import { appleClientSecret, appleOrigin, type AppleSignInConfig } from "../auth/apple-sign-in.js";
import type { ControlPlaneStore } from "../database/store.js";
import { ControlPlaneError } from "../server/errors.js";
import type { ConnectLifecycleService } from "./connect-lifecycle.js";

type OAuthTokenContext = Parameters<typeof decryptOAuthToken>[1];

/**
 * Deletes an Account from wherever a person asks, including when a computer it
 * owns is lost or off, so nothing here depends on a Host answering. Each attempt
 * is complete on its own: a refusal leaves the Account intact to retry.
 */
export class AccountDeletionService {
  readonly #apple: AppleSignInConfig | undefined;
  readonly #auth: ControlPlaneAuth;
  readonly #connectLifecycle: ConnectLifecycleService;
  readonly #fetch: typeof fetch;
  readonly #store: ControlPlaneStore;

  constructor(dependencies: {
    readonly appleSignIn?: AppleSignInConfig;
    readonly auth: ControlPlaneAuth;
    readonly connectLifecycle: ConnectLifecycleService;
    readonly fetch?: typeof fetch;
    readonly store: ControlPlaneStore;
  }) {
    this.#apple = dependencies.appleSignIn;
    this.#auth = dependencies.auth;
    this.#connectLifecycle = dependencies.connectLifecycle;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#store = dependencies.store;
  }

  async delete(accountId: ControlPlaneAccountId): Promise<void> {
    for (const deployment of await this.#store.ownedDeployments(accountId)) {
      if (deployment.connectState === null || deployment.connectState === "revoked") continue;
      try {
        await this.#connectLifecycle.revoke(accountId, deployment.id, {
          hostInstanceId: deployment.activeHostInstanceId,
          // A fresh identity per attempt: a replayed one that another device's
          // provision superseded would refuse every retry.
          operationId: ConnectOperationIdSchema.parse(`cop_${randomUUID()}`),
        });
      } catch (error) {
        // The Host unlinked itself first, which is what this step wanted.
        if (!isNotFound(error)) throw error;
      }
    }
    // The token row goes with the Account, and Apple must only hear of a deletion
    // that committed.
    const appleRefreshToken = this.#apple
      ? await this.#store.oauthRefreshToken(accountId, "apple")
      : null;
    try {
      await this.#store.deleteAccount(accountId);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (this.#apple && appleRefreshToken) await this.#revokeApple(this.#apple, appleRefreshToken);
  }

  /** Apple documents a manual fallback, so a failure here never undoes a deletion. */
  async #revokeApple(config: AppleSignInConfig, encryptedToken: string): Promise<void> {
    try {
      const context = (await this.#auth.$context) as unknown as OAuthTokenContext;
      const token = await decryptOAuthToken(encryptedToken, context);
      const response = await this.#fetch(`${appleOrigin}/auth/revoke`, {
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: await appleClientSecret(config),
          token,
          token_type_hint: "refresh_token",
        }),
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (!response.ok) console.error(`Sign in with Apple revocation: HTTP ${response.status}`);
    } catch (error) {
      console.error(`Sign in with Apple revocation failed: ${(error as Error).name}`);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof ControlPlaneError && error.code === "not_found";
}
