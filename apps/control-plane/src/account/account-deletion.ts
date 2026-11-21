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
import type { CloudComputerStore } from "../cloud-computers/store.js";
import type { ConnectLifecycleService } from "./connect-lifecycle.js";

type OAuthTokenContext = Parameters<typeof decryptOAuthToken>[1];

/**
 * What one attempt came to: the Account is gone, or it is being deleted and waits on its
 * Cloud Computers to end (`billingCanceled` says whether every subscription is cancelled yet).
 */
export type AccountDeletionOutcome =
  | { readonly status: "deleted" }
  | { readonly status: "pending"; readonly billingCanceled: boolean };

/**
 * Deletes an Account from wherever a person asks, including when a computer it
 * owns is lost or off, so nothing here depends on a Host answering. Each attempt
 * is complete on its own: a refusal leaves the Account intact to retry.
 *
 * An Account with a paid Cloud Computer goes in an order that cannot charge after the
 * decision and cannot leave a machine behind: the decision is recorded first (no checkout
 * charges it from then on); each Cloud Computer is deleted through its own Delete, which
 * cancels the subscription before it lets the machine go; and the Account's records go only
 * once every machine is gone. Until then the Account is being deleted, and `finishPending`
 * completes it on the account service's own schedule.
 */
export class AccountDeletionService {
  readonly #apple: AppleSignInConfig | undefined;
  readonly #auth: ControlPlaneAuth;
  readonly #connectLifecycle: ConnectLifecycleService;
  readonly #fetch: typeof fetch;
  readonly #store: ControlPlaneStore;
  readonly #resolveOrganizationCheckouts?: (account: ControlPlaneAccountId) => Promise<void>;
  readonly #cloudComputers: Pick<CloudComputerStore, "accountDeletionState" | "mutate"> | undefined;

  constructor(dependencies: {
    readonly appleSignIn?: AppleSignInConfig;
    readonly auth: ControlPlaneAuth;
    /** The person's Cloud Computers, ended through their own Delete before the Account goes. */
    readonly cloudComputers?: Pick<CloudComputerStore, "accountDeletionState" | "mutate">;
    readonly connectLifecycle: ConnectLifecycleService;
    readonly fetch?: typeof fetch;
    readonly store: ControlPlaneStore;
    readonly resolveOrganizationCheckouts?: (account: ControlPlaneAccountId) => Promise<void>;
  }) {
    this.#apple = dependencies.appleSignIn;
    this.#auth = dependencies.auth;
    this.#connectLifecycle = dependencies.connectLifecycle;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#store = dependencies.store;
    this.#cloudComputers = dependencies.cloudComputers;
    if (dependencies.resolveOrganizationCheckouts)
      this.#resolveOrganizationCheckouts = dependencies.resolveOrganizationCheckouts;
  }

  async delete(accountId: ControlPlaneAccountId): Promise<AccountDeletionOutcome> {
    // Before anything is undone: a hosted team the Account holds refuses here, and from here on
    // nothing can give it one. So does a work Home its organization hasn't offboarded.
    let attemptId: string;
    try {
      attemptId = await this.#store.beginAccountDeletion(accountId);
    } catch (error) {
      if (isNotFound(error)) return { status: "deleted" };
      throw error;
    }
    let appleRefreshToken: string | null;
    try {
      await this.#resolveOrganizationCheckouts?.(accountId);
      // The decision, kept: from here no checkout can charge this Account.
      await this.#store.requestAccountDeletion(accountId, attemptId);
      const waiting = await this.#endCloudComputers(accountId, attemptId);
      if (waiting) {
        await this.#store.abandonAccountDeletion(accountId, attemptId).catch(() => undefined);
        return waiting;
      }
      for (const deployment of await this.#store.ownedDeployments(accountId)) {
        if (deployment.connectState === null || deployment.connectState === "revoked") continue;
        // Each step renews the fence, so a slow deletion keeps it and only a dead one lets go.
        await this.#store.renewAccountDeletion(accountId, attemptId);
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
      appleRefreshToken = this.#apple
        ? await this.#store.oauthRefreshToken(accountId, "apple")
        : null;
      await this.#store.renewAccountDeletion(accountId, attemptId);
      await this.#store.deleteAccount(accountId, attemptId);
    } catch (error) {
      await this.#store.abandonAccountDeletion(accountId, attemptId).catch(() => undefined);
      if (isNotFound(error)) return { status: "deleted" };
      throw error;
    }
    if (this.#apple && appleRefreshToken) await this.#revokeApple(this.#apple, appleRefreshToken);
    return { status: "deleted" };
  }

  /**
   * Finishes Accounts their people asked to delete, once their Cloud Computers are gone. One
   * that still waits stays as it is for the next pass; a failure is reported and kept.
   */
  async finishPending(onError: (error: unknown) => void): Promise<void> {
    for (const accountId of await this.#store.accountsAwaitingDeletion()) {
      try {
        await this.delete(accountId);
      } catch (error) {
        onError(error);
      }
    }
  }

  /**
   * Ends the person's own Cloud Computers through the Delete each already has: it records the
   * request, cancels the Stripe subscription, and only once Stripe confirms lets the machine,
   * its disk and its backups go. Null once every machine is gone; otherwise what still waits.
   */
  async #endCloudComputers(
    accountId: ControlPlaneAccountId,
    attemptId: string,
  ): Promise<Extract<AccountDeletionOutcome, { status: "pending" }> | null> {
    const cloud = this.#cloudComputers;
    if (!cloud) return null;
    for (const computer of await cloud.accountDeletionState(accountId)) {
      if (computer.machineGone || (computer.deletionRequested && computer.billingCanceled))
        continue;
      await this.#store.renewAccountDeletion(accountId, attemptId);
      // A Stripe failure keeps the durable request; the billing pass cancels on its next run.
      await cloud.mutate(computer.id, "delete", accountId);
    }
    const left = (await cloud.accountDeletionState(accountId)).filter(
      (computer) => !computer.machineGone,
    );
    return left.length === 0
      ? null
      : { status: "pending", billingCanceled: left.every((computer) => computer.billingCanceled) };
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
