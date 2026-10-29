import { randomBytes } from "node:crypto";
import {
  maxPasswordSignInsPerHost,
  passwordLoginLifetimeMs,
  passwordSignInProbeTimeoutMs,
  type LoginAuthorizationOutcome,
  type LoginField,
  type LoginFillStatus,
  type PasswordSignInCancelReason,
  type PasswordSignInAvailability,
} from "@opensteer/protocol";
import type { BrowserLoginAuthorizeInput, BrowserLoginAuthority } from "./sign-in.js";

export type HostLoginAuthorizeInput = Omit<BrowserLoginAuthorizeInput, "runtimeId">;
interface Operation {
  readonly input: HostLoginAuthorizeInput;
  readonly controller: AbortController;
  readonly expiry: NodeJS.Timeout;
  readonly report: (outcome: LoginAuthorizationOutcome) => Promise<void>;
  readonly ended: () => Promise<void>;
  notifications: Promise<void>;
  loginRef: string | null;
  detachAuthority: (() => void) | null;
}

/** Previous-release login.authorize adapter; modern references belong to desktop main. */
export class HostSignIns {
  readonly #authority: BrowserLoginAuthority | undefined;
  readonly #fills = new Map<string, Set<AbortController>>();
  readonly #finished = new Set<string>();
  readonly #leases = new Map<string, Operation>();
  readonly #operations = new Map<string, Operation>();
  readonly #now: () => number;
  readonly #runtimeId: string;
  #closed = false;

  constructor(options: {
    readonly authority: BrowserLoginAuthority | undefined;
    readonly now?: () => number;
    readonly runtimeId: string;
  }) {
    this.#authority = options.authority;
    this.#now = options.now ?? (() => Date.now());
    this.#runtimeId = options.runtimeId;
  }

  async probe(input: { readonly site: string }): Promise<PasswordSignInAvailability> {
    if (!this.#authority || this.#closed) return "unavailable";
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<PasswordSignInAvailability>((resolve) => {
      timer = setTimeout(() => resolve("unavailable"), passwordSignInProbeTimeoutMs - 500);
      timer.unref();
    });
    try {
      return await Promise.race([this.#authority.probe(input), timeout]);
    } catch {
      return "unavailable";
    } finally {
      clearTimeout(timer);
    }
  }

  authorize(
    requested: HostLoginAuthorizeInput,
    report: (outcome: LoginAuthorizationOutcome) => Promise<void>,
    needs: (need: "approval" | null) => Promise<void> = async () => undefined,
    ended: () => Promise<void> = async () => undefined,
  ): void {
    if (this.#finished.has(requested.operationId)) return;
    this.#finished.add(requested.operationId);
    const answer = (outcome: LoginAuthorizationOutcome) => {
      void report(outcome).catch(() => undefined);
    };
    const authority = this.#authority;
    if (!authority || this.#closed) {
      answer({ kind: "unavailable", reason: "passwords-off" });
      return;
    }
    if (
      [...this.#operations.values()].filter((op) => op.loginRef === null).length >=
      maxPasswordSignInsPerHost
    ) {
      answer({ kind: "busy" });
      return;
    }
    const input = {
      ...requested,
      expiresAt: new Date(
        Math.min(requested.expiresAt.getTime(), this.#now() + passwordLoginLifetimeMs),
      ),
    };
    const remainingMs = input.expiresAt.getTime() - this.#now();
    if (remainingMs <= 0) {
      answer({ kind: "expired" });
      return;
    }
    const operation: Operation = {
      input,
      controller: new AbortController(),
      expiry: setTimeout(() => this.cancel(input.operationId, "expired"), remainingMs),
      report,
      ended,
      notifications: Promise.resolve(),
      loginRef: null,
      detachAuthority: null,
    };
    operation.expiry.unref();
    this.#operations.set(input.operationId, operation);
    void this.#authorize(authority, operation, needs);
  }

  async fill(input: {
    loginRef: string;
    sessionId: string;
    targetId: string;
    field: LoginField;
  }): Promise<LoginFillStatus> {
    if (this.#closed) return "expired";
    const controller = new AbortController();
    const fills = this.#fills.get(input.sessionId) ?? new Set<AbortController>();
    fills.add(controller);
    this.#fills.set(input.sessionId, fills);
    try {
      const operation = this.#leases.get(input.loginRef);
      if (!operation && this.#authority?.fillReference) {
        return await this.#authority.fillReference({ ...input, lease: controller.signal });
      }
      if (!operation || operation.input.sessionId !== input.sessionId || !this.#authority)
        return "expired";
      if (operation.input.expiresAt.getTime() <= this.#now())
        this.cancel(operation.input.operationId, "expired");
      if (operation.controller.signal.aborted) return "expired";
      return await this.#authority.fill({
        operationId: operation.input.operationId,
        targetId: input.targetId,
        field: input.field,
        lease: AbortSignal.any([controller.signal, operation.controller.signal]),
      });
    } catch {
      // Never expose page/broker exception text through the agent's CDP path.
      return controller.signal.aborted ? "expired" : "unavailable";
    } finally {
      fills.delete(controller);
      if (fills.size === 0) this.#fills.delete(input.sessionId);
    }
  }

  cancel(operationId: string, reason: PasswordSignInCancelReason): void {
    const operation = this.#operations.get(operationId);
    if (!operation || operation.controller.signal.aborted) return;
    const live = operation.loginRef !== null;
    // Abort before any asynchronous cleanup so an in-flight release cannot write.
    operation.controller.abort(reason);
    this.#remove(operation);
    this.#notify(
      operation,
      live
        ? operation.ended
        : () =>
            operation.report(
              reason === "expired" ? { kind: "expired" } : { kind: "cancelled", reason },
            ),
    );
  }

  sessionDetached(sessionId: string): void {
    for (const controller of this.#fills.get(sessionId) ?? []) controller.abort();
    for (const [id, operation] of this.#operations) {
      if (operation.input.sessionId === sessionId) this.cancel(id, "authority-lost");
    }
  }

  close(): void {
    this.#closed = true;
    for (const fills of this.#fills.values()) for (const controller of fills) controller.abort();
    for (const id of this.#operations.keys()) this.cancel(id, "authority-lost");
  }

  async #authorize(
    authority: BrowserLoginAuthority,
    operation: Operation,
    needs: (need: "approval" | null) => Promise<void>,
  ): Promise<void> {
    try {
      const result = await authority.authorize(
        { ...operation.input, runtimeId: this.#runtimeId },
        operation.controller.signal,
        (need) => {
          if (!operation.controller.signal.aborted && !operation.loginRef)
            this.#notify(operation, () => needs(need));
        },
      );
      if (operation.controller.signal.aborted) return;
      if (operation.input.expiresAt.getTime() <= this.#now()) {
        this.cancel(operation.input.operationId, "expired");
        return;
      }
      if (result.kind === "ended") {
        this.#remove(operation);
        this.#notify(operation, () => operation.report(result.outcome));
        return;
      }
      if (result.authority.aborted) {
        this.cancel(operation.input.operationId, "authority-lost");
        return;
      }
      const loginRef = `lgn_${randomBytes(16).toString("hex")}`;
      operation.loginRef = loginRef;
      this.#leases.set(loginRef, operation);
      const authorityLost = () => this.cancel(operation.input.operationId, "authority-lost");
      result.authority.addEventListener("abort", authorityLost, { once: true });
      operation.detachAuthority = () =>
        result.authority.removeEventListener("abort", authorityLost);
      this.#notify(operation, () =>
        operation.report({
          kind: "authorized",
          loginRef,
          account: result.account,
          expiresAt: operation.input.expiresAt.toISOString(),
        }),
      );
    } catch {
      if (operation.controller.signal.aborted) return;
      this.#remove(operation);
      this.#notify(operation, () =>
        operation.report({ kind: "unavailable", reason: "not-responding" }),
      );
    }
  }

  #remove(operation: Operation): void {
    clearTimeout(operation.expiry);
    operation.detachAuthority?.();
    this.#operations.delete(operation.input.operationId);
    if (operation.loginRef) this.#leases.delete(operation.loginRef);
    void this.#authority?.end(operation.input.operationId).catch(() => undefined);
  }

  #notify(operation: Operation, work: () => Promise<void>): void {
    // Preserve result-before-ended ordering even if authority disappears while
    // the transport is still sending the authorization result.
    operation.notifications = operation.notifications.then(work).catch(() => undefined);
  }
}
