import { browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import type {
  PasswordsBrokerLogin,
  PasswordsBrokerSignInDecision,
  PasswordsBrokerSignInProbeParams,
  PasswordsBrokerSignInProbeResult,
  PasswordsBrokerSignInRequestParams,
  PasswordsBrokerSignInReleaseParams,
  PasswordsBrokerSignInReleaseResult,
  PasswordsBrokerStatus,
} from "@opensteer/protocol/passwords-broker";
import {
  PasswordsBrokerFailure,
  type PasswordsBrokerSignInApproveParams,
  type PasswordsBrokerSignInApproveResult,
  type PasswordsBrokerSession,
  type PasswordsBrokerSignInGrant,
} from "../broker-session.js";

export type FakePasswordsBrokerCall =
  | { readonly method: "probe"; readonly params: PasswordsBrokerSignInProbeParams }
  | { readonly method: "request"; readonly params: PasswordsBrokerSignInRequestParams }
  | { readonly method: "approve"; readonly params: PasswordsBrokerSignInApproveParams }
  | { readonly method: "release"; readonly params: PasswordsBrokerSignInReleaseParams }
  | { readonly method: "cancel"; readonly transactionId: string };

/** Synthetic data only. Never use real credentials with these test helpers. */
export interface FakePasswordsLogin {
  readonly id: string;
  readonly revision: number;
  readonly origins: readonly string[];
  readonly username: string;
  readonly password: string;
  readonly totp: string | null;
  readonly account?: string;
}

export interface FakePasswordsGrant {
  readonly id: string;
  readonly revision: number;
  readonly permissionVersion: number;
}
interface Transaction {
  readonly params: PasswordsBrokerSignInRequestParams;
  readonly lifetime: AbortController;
  login: PasswordsBrokerLogin | null;
  remembered: boolean;
  used: boolean;
}

export const fakePasswordsLogin: FakePasswordsLogin = {
  id: "8d1c2a4b-5d6e-4f80-9a1b-2c3d4e5f6071",
  revision: 1,
  origins: ["https://example.com"],
  username: "person@example.com",
  password: "synthetic-password-7c1a",
  totp: "123456",
  account: "p•••@example.com",
};

/** The same authorization/release policy as the Swift broker, with synthetic values. */
export class FakePasswordsBrokerSession implements PasswordsBrokerSession {
  availability: PasswordsBrokerSignInProbeResult["passwords"] = "has-login";
  status: PasswordsBrokerStatus = { agentSignIns: "on", vault: "ready" };
  cancelAuthentication = false;
  approvalLogin: Extract<PasswordsBrokerSignInApproveResult, { decision: "authorized" }> | null =
    null;
  approvalResult: PasswordsBrokerSignInApproveResult | null = null;
  now: () => number = Date.now;
  readonly logins: Map<string, FakePasswordsLogin>;
  readonly grants: Map<string, FakePasswordsGrant>;

  constructor(
    options: {
      logins?: Map<string, FakePasswordsLogin>;
      grants?: Map<string, FakePasswordsGrant>;
    } = {},
  ) {
    this.logins = options.logins ?? new Map([[fakePasswordsLogin.id, fakePasswordsLogin]]);
    this.grants = options.grants ?? new Map();
  }
  readonly usedTransactions: string[] = [];
  readonly calls: FakePasswordsBrokerCall[] = [];
  readonly #decisions: PasswordsBrokerSignInDecision[] = [];
  readonly #transactions = new Map<string, Transaction>();
  readonly #arrivals = new Set<() => void>();

  queueDecision(decision: PasswordsBrokerSignInDecision): void {
    this.#decisions.push(decision);
  }
  setLogin(login: FakePasswordsLogin): void {
    this.logins.set(login.id, login);
  }
  grantKey(
    params: Pick<PasswordsBrokerSignInRequestParams, "deploymentId" | "workspaceId" | "site">,
  ): string {
    return JSON.stringify([params.deploymentId, params.workspaceId, params.site]);
  }
  remember(
    params: PasswordsBrokerSignInRequestParams,
    login: PasswordsBrokerLogin,
    permissionVersion = 4,
  ): void {
    this.grants.set(this.grantKey(params), {
      id: login.id,
      revision: login.revision,
      permissionVersion,
    });
  }
  revoke(params: PasswordsBrokerSignInRequestParams): void {
    this.grants.delete(this.grantKey(params));
  }

  async waitForCall(method: FakePasswordsBrokerCall["method"]): Promise<FakePasswordsBrokerCall> {
    for (;;) {
      const found = this.calls.find((call) => call.method === method);
      if (found) return found;
      await new Promise<void>((resolve) => this.#arrivals.add(resolve));
    }
  }
  dropConnection(): void {
    for (const transaction of this.#transactions.values()) transaction.lifetime.abort();
    this.#transactions.clear();
  }
  async probe(params: PasswordsBrokerSignInProbeParams): Promise<PasswordsBrokerSignInProbeResult> {
    this.#record({ method: "probe", params });
    return { passwords: this.availability };
  }
  async request(
    params: PasswordsBrokerSignInRequestParams,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInGrant> {
    signal.throwIfAborted();
    this.#record({ method: "request", params });
    const lifetime = new AbortController();
    const transaction: Transaction = {
      params: {
        ...params,
        expiresAt: new Date(
          Math.min(Date.parse(params.expiresAt), this.now() + 60 * 60_000),
        ).toISOString(),
      },
      lifetime,
      login: null,
      remembered: false,
      used: false,
    };
    this.#transactions.set(params.transactionId, transaction);
    const grant = this.grants.get(this.grantKey(params));
    const item = grant && grant.permissionVersion === 4 ? this.logins.get(grant.id) : undefined;
    const decision =
      this.#decisions.shift() ??
      (this.status.vault !== "ready"
        ? { decision: "unavailable", reason: "not-set-up" }
        : this.status.agentSignIns === "off"
          ? { decision: "unavailable", reason: "passwords-off" }
          : item &&
              item.revision === grant?.revision &&
              item.origins.some((origin) => browserSiteFromUrl(origin) === params.site)
            ? { decision: "authorized", login: descriptor(item) }
            : { decision: "approve", accounts: [] });
    this.applyDecision(params.transactionId, decision, decision.decision === "authorized");
    return { decision, lifetime: lifetime.signal };
  }

  /** Used by the socket fake when the test answers a held authentication. */
  applyDecision(
    transactionId: string,
    decision: PasswordsBrokerSignInDecision | PasswordsBrokerSignInApproveResult,
    remembered = false,
  ): void {
    const transaction = this.#transactions.get(transactionId);
    if (!transaction) return;
    if (decision.decision === "authorized") {
      transaction.login = { ...decision.login };
      transaction.remembered = remembered;
      if (remembered) this.remember(transaction.params, decision.login);
    } else if (decision.decision === "unavailable") {
      transaction.lifetime.abort();
      this.#transactions.delete(transactionId);
    }
  }

  async approve(
    params: PasswordsBrokerSignInApproveParams,
    signal: AbortSignal,
  ): Promise<PasswordsBrokerSignInApproveResult> {
    signal.throwIfAborted();
    const transaction = this.#transactions.get(params.transactionId);
    if (!transaction || !this.#live(transaction))
      throw new PasswordsBrokerFailure("connection-lost", "That sign-in ended.");
    this.#record({ method: "approve", params });
    if (this.cancelAuthentication) {
      this.cancelAuthentication = false;
      throw new PasswordsBrokerFailure("invalid", "Authentication was cancelled.");
    }
    const item = this.logins.get(params.loginId);
    const decision =
      this.approvalResult ??
      this.approvalLogin ??
      (item && item.revision === params.revision
        ? { decision: "authorized" as const, login: descriptor(item) }
        : {
            decision: "approve" as const,
            accounts: [],
            message: "That account changed. Choose it again.",
          });
    this.applyDecision(params.transactionId, decision, params.remember);
    return decision;
  }

  async release(
    params: PasswordsBrokerSignInReleaseParams,
    signal?: AbortSignal,
  ): Promise<PasswordsBrokerSignInReleaseResult> {
    signal?.throwIfAborted();
    this.#record({ method: "release", params });
    const transaction = this.#transactions.get(params.transactionId);
    if (!transaction || !this.#live(transaction) || !transaction.login)
      return { released: false, reason: "ended" };
    if (this.status.agentSignIns === "off") return { released: false, reason: "passwords-off" };
    if (this.status.vault !== "ready") return { released: false, reason: "revoked" };
    const pinned = transaction.login;
    const item = this.logins.get(pinned.id);
    if (!item || item.revision !== pinned.revision) return { released: false, reason: "revoked" };
    if (transaction.remembered) {
      const grant = this.grants.get(this.grantKey(transaction.params));
      if (
        !grant ||
        grant.permissionVersion !== 4 ||
        grant.id !== pinned.id ||
        grant.revision !== pinned.revision
      )
        return { released: false, reason: "revoked" };
    }
    let withinSite = false;
    try {
      const origin = new URL(params.origin);
      withinSite =
        origin.protocol === "https:" &&
        origin.origin === params.origin &&
        browserSiteFromUrl(params.origin) === transaction.params.site;
    } catch {
      /* Invalid origins release nothing. */
    }
    if (
      !withinSite ||
      !item.origins.some((origin) => browserSiteFromUrl(origin) === transaction.params.site)
    )
      return { released: false, reason: "wrong-site" };
    if (params.field === "totp" && item.totp === null)
      return { released: false, reason: "no-totp" };
    if (params.field === "password" && !transaction.used) {
      transaction.used = true;
      this.usedTransactions.push(params.transactionId);
    }
    return {
      released: true,
      value:
        params.field === "username"
          ? item.username
          : params.field === "password"
            ? item.password
            : (item.totp ?? ""),
    };
  }
  async cancel(transactionId: string): Promise<void> {
    this.#record({ method: "cancel", transactionId });
    this.#transactions.get(transactionId)?.lifetime.abort();
    this.#transactions.delete(transactionId);
  }
  #live(transaction: Transaction): boolean {
    if (
      transaction.lifetime.signal.aborted ||
      Date.parse(transaction.params.expiresAt) <= this.now()
    ) {
      transaction.lifetime.abort();
      return false;
    }
    return true;
  }
  #record(call: FakePasswordsBrokerCall): void {
    this.calls.push(call);
    for (const resolve of this.#arrivals) resolve();
    this.#arrivals.clear();
  }
}
function descriptor(item: FakePasswordsLogin): PasswordsBrokerLogin {
  return {
    id: item.id,
    revision: item.revision,
    account: item.account ?? `${item.username.slice(0, 1)}•••`,
    hasTOTP: item.totp !== null,
  };
}
