import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { webContents } from "electron";
import { browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import type {
  BrowserLoginAuthority,
  BrowserLoginAuthorizeInput,
} from "@opensteer/browser-runtime-core";
import {
  PasswordSignInAuthorityCommandSchema,
  loginEnvelopeMaxLifetimeMs,
  passwordLoginLifetimeMs,
  maxPasswordSignInsPerHost,
  type PasswordSignInAuthorityCommand,
  type PasswordSignInAuthorityEvent,
  type PasswordSignInAuthorityResult,
  type LoginAuthorizationOutcome,
  type LoginFillStatus,
  type LoginSealResult,
} from "@opensteer/protocol";
import type {
  DesktopPasswordsSignInApproveInput,
  DesktopPasswordsSignInCardState,
} from "@opensteer/protocol/desktop";
import {
  PasswordsBrokerSignInRequestParamsSchema,
  PasswordsBrokerSignInRequestV5ParamsSchema,
} from "@opensteer/protocol/passwords-broker";
import { PasswordsBrokerFailure, type PasswordsBrokerSession } from "./broker-session.js";
import { sealLoginEnvelope } from "./login-envelope.js";
import type { PasswordsSignInOperations } from "./sign-in-operations.js";

type ModernAuthorizeInput = Omit<BrowserLoginAuthorizeInput, "runtimeId" | "sessionId"> & {
  readonly loginRef: string;
};

type Authorization = Awaited<ReturnType<BrowserLoginAuthority["authorize"]>>;
type EndedOutcome = Exclude<LoginAuthorizationOutcome, { kind: "authorized" }>;
interface Operation {
  readonly site: string;
  readonly expiresAt: number;
  readonly authority: AbortController;
  readonly close: () => void;
  readonly modern: boolean;
  readonly broker: PasswordsBrokerSession;
  queue: Promise<void>;
  authorized: boolean;
}

export class PasswordsLoginAuthority implements BrowserLoginAuthority {
  readonly #broker: PasswordsBrokerSession;
  readonly #legacyBroker: PasswordsBrokerSession;
  readonly #cards: PasswordsSignInOperations;
  readonly #ownOrigins: () => readonly string[];
  readonly #operations = new Map<string, Operation>();
  readonly #references = new Map<string, string>();
  readonly #controls = new Map<string, { controller: AbortController; expiry: NodeJS.Timeout }>();

  constructor(options: {
    broker: PasswordsBrokerSession;
    legacyBroker?: PasswordsBrokerSession;
    operations: PasswordsSignInOperations;
    ownOrigins: () => readonly string[];
  }) {
    this.#broker = options.broker;
    this.#legacyBroker = options.legacyBroker ?? options.broker;
    this.#cards = options.operations;
    this.#ownOrigins = options.ownOrigins;
  }

  async probe(input: { site: string }) {
    return (await this.#broker.probe(input)).passwords;
  }

  async authorize(
    input: BrowserLoginAuthorizeInput | ModernAuthorizeInput,
    signal: AbortSignal,
    needs: (need: "approval" | null) => void,
  ): Promise<Authorization> {
    const modern = "loginRef" in input;
    const broker = modern ? this.#broker : this.#legacyBroker;
    const { promise, resolve } = Promise.withResolvers<Authorization>();
    const authority = new AbortController();
    let settled = false;
    let approving = false;
    let state: DesktopPasswordsSignInCardState = { stage: "gone" };
    let unregister = () => {};
    let unsubscribeLifetime = () => {};
    const finish = (outcome: EndedOutcome) => {
      if (settled) return;
      settled = true;
      needs(null);
      resolve({ kind: "ended", outcome });
    };
    const cancelled = () => {
      const reason = signal.reason;
      finish(
        reason === "expired"
          ? { kind: "expired" }
          : reason === "declined"
            ? { kind: "declined" }
            : {
                kind: "cancelled",
                reason: reason === "withdrawn" ? "withdrawn" : "authority-lost",
              },
      );
      authority.abort("expired");
    };
    const operation: Operation = {
      authority,
      modern,
      broker,
      queue: Promise.resolve(),
      authorized: false,
      expiresAt: input.expiresAt.getTime(),
      site: input.site,
      close: () => {
        signal.removeEventListener("abort", cancelled);
        unsubscribeLifetime();
        unregister();
        finish({ kind: "cancelled", reason: "authority-lost" });
      },
    };
    this.#operations.set(input.operationId, operation);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    const authorized = (account: string) => {
      if (settled || signal.aborted || authority.signal.aborted) return;
      if (Date.now() >= operation.expiresAt) {
        finish({ kind: "expired" });
        return;
      }
      operation.authorized = true;
      state = {
        stage: "authorized",
        account,
        ...(operation.modern ? { permissionVersion: 5 as const } : {}),
      };
      registration.changed();
      settled = true;
      needs(null);
      resolve({ kind: "authorized", account, authority: authority.signal });
    };
    const unavailable = (reason: "busy" | "passwords-off" | "not-set-up") =>
      finish(reason === "busy" ? { kind: "busy" } : { kind: "unavailable", reason });
    const registration = this.#cards.register(input.operationId, {
      state: () => state,
      approve: async (approval: DesktopPasswordsSignInApproveInput) => {
        if (settled || approving || signal.aborted || state.stage !== "approval")
          return { ok: false, message: "That sign-in is no longer waiting for approval." };
        if (Date.now() >= operation.expiresAt) {
          finish({ kind: "expired" });
          return { ok: false, message: "That sign-in expired. Ask the agent to request it again." };
        }
        approving = true;
        try {
          const result = await broker.approve(
            {
              transactionId: input.operationId,
              loginId: approval.loginId,
              revision: approval.revision,
              remember: approval.remember,
            },
            signal,
          );
          if (result.decision === "authorized") {
            authorized(result.login.account);
            return { ok: true };
          }
          if (result.decision === "unavailable") {
            unavailable(result.reason);
            return {
              ok: false,
              message: "Opensteer Passwords is no longer available for this sign-in.",
            };
          }
          state = {
            stage: "approval",
            accounts: result.accounts,
            site: input.site,
            ...(operation.modern ? { permissionVersion: 5 as const } : {}),
          };
          registration.changed();
          return { ok: false, message: result.message };
        } catch (error) {
          if (error instanceof PasswordsBrokerFailure && error.code === "invalid")
            return { ok: false, message: error.message };
          if (signal.aborted) cancelled();
          else finish({ kind: "unavailable", reason: "not-responding" });
          return { ok: false, message: "Opensteer Passwords could not authorize this sign-in." };
        } finally {
          approving = false;
        }
      },
    });
    unregister = registration.unregister;
    try {
      if (!settled) {
        const grant = await broker.request(
          operation.modern
            ? PasswordsBrokerSignInRequestV5ParamsSchema.parse({
                ...input.requester,
                expiresAt: input.expiresAt.toISOString(),
                protocolVersion: 5,
                permissionVersion: 5,
                site: input.site,
                transactionId: input.operationId,
                workspaceId: input.workspaceId,
              })
            : PasswordsBrokerSignInRequestParamsSchema.parse({
                ...input.requester,
                expiresAt: input.expiresAt.toISOString(),
                runtimeId: "runtimeId" in input ? input.runtimeId : undefined,
                sessionId: "sessionId" in input ? input.sessionId : undefined,
                site: input.site,
                transactionId: input.operationId,
                workspaceId: input.workspaceId,
              }),
          signal,
        );
        if (signal.aborted || this.#operations.get(input.operationId) !== operation)
          return await promise;
        const lost = () => {
          authority.abort(grant.lifetime.reason);
          finish({ kind: "cancelled", reason: "authority-lost" });
        };
        grant.lifetime.addEventListener("abort", lost, { once: true });
        unsubscribeLifetime = () => grant.lifetime.removeEventListener("abort", lost);
        if (grant.lifetime.aborted) lost();
        if (!settled) {
          const decision = grant.decision;
          if (decision.decision === "authorized") authorized(decision.login.account);
          else if (decision.decision === "unavailable") unavailable(decision.reason);
          else if (decision.accounts.length === 0)
            finish({ kind: "unavailable", reason: "no-saved-login" });
          else {
            state = {
              stage: "approval",
              accounts: decision.accounts,
              site: input.site,
              ...(operation.modern ? { permissionVersion: 5 as const } : {}),
            };
            registration.changed();
            needs("approval");
          }
        }
      }
    } catch {
      if (signal.aborted) cancelled();
      else finish({ kind: "unavailable", reason: "not-responding" });
    }
    return await promise;
  }

  async control(
    requested: PasswordSignInAuthorityCommand,
    emit: (event: PasswordSignInAuthorityEvent) => void,
  ): Promise<PasswordSignInAuthorityResult> {
    const parsed = PasswordSignInAuthorityCommandSchema.safeParse(requested);
    if (!parsed.success) return { type: "unavailable" };
    const command = parsed.data;
    try {
      switch (command.type) {
        case "signin.probe":
          return { type: "signin.probe.result", passwords: await this.probe(command) };
        case "login.cancel": {
          this.#controls.get(command.operationId)?.controller.abort(command.reason);
          await this.end(command.operationId);
          return { type: "login.cancelled" };
        }
        case "login.seal":
          return await this.#seal(command);
        case "login.authorize": {
          if (this.#controls.has(command.operationId)) return { type: "login.authorize.started" };
          if (this.#operations.has(command.operationId) || this.#references.has(command.loginRef))
            return { type: "unavailable" };
          if (
            [...this.#operations.values()].filter((operation) => !operation.authorized).length >=
            maxPasswordSignInsPerHost
          ) {
            emit({
              type: "login.result",
              operationId: command.operationId,
              outcome: { kind: "busy" },
            });
            return { type: "login.authorize.started" };
          }
          const controller = new AbortController();
          const expiresAt = new Date(
            Math.min(Date.parse(command.expiresAt), Date.now() + passwordLoginLifetimeMs),
          );
          if (expiresAt.getTime() <= Date.now()) {
            emit({
              type: "login.result",
              operationId: command.operationId,
              outcome: { kind: "expired" },
            });
            return { type: "login.authorize.started" };
          }
          const expiry = setTimeout(() => {
            controller.abort("expired");
            void this.end(command.operationId);
          }, expiresAt.getTime() - Date.now());
          expiry.unref();
          this.#controls.set(command.operationId, { controller, expiry });
          void this.authorize({ ...command, expiresAt }, controller.signal, (need) =>
            emit({ type: "login.needs", operationId: command.operationId, need }),
          )
            .then((result) => {
              if (controller.signal.aborted) return;
              if (result.kind === "ended") {
                emit({
                  type: "login.result",
                  operationId: command.operationId,
                  outcome: result.outcome,
                });
                void this.end(command.operationId);
                return;
              }
              this.#references.set(command.loginRef, command.operationId);
              emit({
                type: "login.result",
                operationId: command.operationId,
                outcome: {
                  kind: "authorized",
                  loginRef: command.loginRef,
                  account: result.account,
                  expiresAt: expiresAt.toISOString(),
                },
              });
              const ended = () => {
                emit({ type: "login.ended", operationId: command.operationId });
                void this.end(command.operationId);
              };
              result.authority.addEventListener("abort", ended, { once: true });
              if (result.authority.aborted) ended();
            })
            .catch(() => {
              if (!controller.signal.aborted)
                emit({
                  type: "login.result",
                  operationId: command.operationId,
                  outcome: { kind: "unavailable", reason: "not-responding" },
                });
              void this.end(command.operationId);
            });
          return { type: "login.authorize.started" };
        }
      }
    } catch {
      return { type: "unavailable" };
    }
  }

  async fillReference(input: {
    lease: AbortSignal;
    loginRef: string;
    targetId: string;
    field: "username" | "password" | "code";
  }): Promise<LoginFillStatus> {
    const operationId = this.#references.get(input.loginRef);
    const operation = operationId ? this.#operations.get(operationId) : undefined;
    if (!operationId || !operation) return "expired";
    return await this.fill({ ...input, operationId });
  }

  async #seal(
    command: Extract<PasswordSignInAuthorityCommand, { type: "login.seal" }>,
  ): Promise<LoginSealResult> {
    const operation = this.#operations.get(command.operationId);
    const expired = (): LoginSealResult => ({
      type: "login.seal.result",
      status: operation?.authority.signal.reason === "denied" ? "denied" : "expired",
    });
    if (!operation || !operation.authorized || !operation.modern) return expired();
    if (
      command.binding.connectionId !== command.receiver.connectionId ||
      command.binding.connectionGeneration !== command.receiver.connectionGeneration
    )
      return { type: "login.seal.result", status: "unavailable" };
    return await this.#serialized<LoginSealResult>(operation, async () => {
      if (!this.#live(command.operationId, operation) || command.binding.expiresAt <= Date.now())
        return expired();
      const release = await operation.broker.release(
        {
          transactionId: command.operationId,
          field: command.binding.field === "code" ? "totp" : command.binding.field,
          kind: "app",
        },
        operation.authority.signal,
      );
      if (!release.released) {
        if (release.reason === "revoked" || release.reason === "passwords-off")
          operation.authority.abort("denied");
        return {
          type: "login.seal.result",
          status:
            release.reason === "ended"
              ? "expired"
              : release.reason === "no-totp"
                ? "unavailable"
                : "denied",
        };
      }
      try {
        if (!this.#live(command.operationId, operation) || command.binding.expiresAt <= Date.now())
          return expired();
        const now = Date.now();
        const binding = {
          ...command.binding,
          expiresAt: Math.min(
            command.binding.expiresAt,
            operation.expiresAt,
            now + loginEnvelopeMaxLifetimeMs,
          ),
        };
        return {
          type: "login.seal.result",
          status: "sealed",
          envelope: sealLoginEnvelope({
            value: release.value,
            receiver: command.receiver,
            binding,
            now,
          }),
        };
      } finally {
        release.value = "";
      }
    }).catch(() =>
      this.#live(command.operationId, operation)
        ? { type: "login.seal.result", status: "unavailable" }
        : expired(),
    );
  }

  #live(operationId: string, operation: Operation): boolean {
    return (
      this.#operations.get(operationId) === operation &&
      !operation.authority.signal.aborted &&
      Date.now() < operation.expiresAt
    );
  }

  #serialized<T>(operation: Operation, release: () => Promise<T>): Promise<T> {
    const result = operation.queue.then(() => {
      operation.authority.signal.throwIfAborted();
      return release();
    });
    operation.queue = result.then(
      () => undefined,
      () => undefined,
    );
    const { promise, reject } = Promise.withResolvers<never>();
    const cancelled = () => reject(new Error("Saved login release cancelled."));
    operation.authority.signal.addEventListener("abort", cancelled, { once: true });
    if (operation.authority.signal.aborted) cancelled();
    return Promise.race([result, promise]).finally(() =>
      operation.authority.signal.removeEventListener("abort", cancelled),
    );
  }

  async fill(input: Parameters<BrowserLoginAuthority["fill"]>[0]): Promise<LoginFillStatus> {
    const operation = this.#operations.get(input.operationId);
    if (!operation) return "expired";
    try {
      return await this.#serialized(operation, async () => {
        if (!this.#live(input.operationId, operation)) return "expired";
        return await this.#fill(input);
      });
    } catch {
      return operation.authority.signal.reason === "denied" ? "denied" : "expired";
    }
  }

  async #fill(input: Parameters<BrowserLoginAuthority["fill"]>[0]): Promise<LoginFillStatus> {
    const operation = this.#operations.get(input.operationId);
    if (!operation || input.lease.aborted || Date.now() >= operation.expiresAt) return "expired";
    if (operation.authority.signal.aborted)
      return operation.authority.signal.reason === "denied" ? "denied" : "expired";
    const key = `__opensteer_fill_${randomBytes(24).toString("hex")}`;
    let cleanup: (() => Promise<void>) | undefined;
    let releasing = false;
    try {
      const wc = webContents.fromDevToolsTargetId(input.targetId);
      if (!wc || wc.isDestroyed()) return "stale";
      const frame = wc.focusedFrame;
      if (!frame) return "no-field";
      if (frame.detached) return "stale";
      const origin = frame.origin;
      if (!this.#allowedOrigin(origin, operation.site)) return "wrong-site";
      cleanup = async () => {
        await frame.executeJavaScript(
          `(() => { "use strict"; try { delete window[${JSON.stringify(key)}]; } catch {} })()`,
        );
      };
      const precheck = await frame.executeJavaScript(
        fieldScript({ key, origin, field: input.field }),
      );
      if (precheck !== "ready") return precheck === "no-field" ? "no-field" : "stale";
      releasing = true;
      const release = await operation.broker.release(
        {
          transactionId: input.operationId,
          field: input.field === "code" ? "totp" : input.field,
          origin,
          ...(operation.modern ? { kind: "browser" as const } : {}),
        },
        // Broker cancellation ends the shared transaction. A detached browser
        // only discards this fill after release; Workspace authority still cancels it.
        operation.authority.signal,
      );
      releasing = false;
      if (input.lease.aborted) {
        if (release.released) release.value = "";
        return "expired";
      }
      if (!release.released) {
        switch (release.reason) {
          case "revoked":
          case "passwords-off":
            operation.authority.abort("denied");
            return "denied";
          case "ended":
            return "expired";
          case "wrong-site":
            return "wrong-site";
          case "no-totp":
            return "unavailable";
        }
      }
      try {
        if (input.lease.aborted || Date.now() >= operation.expiresAt) return "expired";
        if (operation.authority.signal.aborted)
          return operation.authority.signal.reason === "denied" ? "denied" : "expired";
        if (
          wc.isDestroyed() ||
          wc.focusedFrame !== frame ||
          frame.detached ||
          frame.origin !== origin
        )
          return "stale";
        // The approved site's document receives the value anyway. Site-per-process
        // confines this frame to that site; the agent CDP allowlist blocks Debugger
        // and injected source access. Strict functions prevent stack hooks reading it.
        const script = fieldScript({ key, origin, field: input.field, value: release.value });
        release.value = "";
        cleanup = undefined;
        const status = await frame.executeJavaScript(script);
        return status === "filled" || status === "no-field" || status === "wrong-site"
          ? status
          : "stale";
      } finally {
        release.value = "";
      }
    } catch {
      // Never propagate page exception text or injected source across the boundary.
      return input.lease.aborted ? "expired" : releasing ? "unavailable" : "stale";
    } finally {
      await cleanup?.().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#operations.keys()].map((id) => this.end(id)));
  }

  async end(operationId: string): Promise<void> {
    const control = this.#controls.get(operationId);
    this.#controls.delete(operationId);
    if (!control && !this.#operations.has(operationId)) return;
    if (control) {
      clearTimeout(control.expiry);
      control.controller.abort("authority-lost");
    }
    const operation = this.#operations.get(operationId);
    this.#operations.delete(operationId);
    for (const [reference, id] of this.#references)
      if (id === operationId) this.#references.delete(reference);
    operation?.authority.abort("expired");
    operation?.close();
    await operation?.broker.cancel(operationId);
  }

  #allowedOrigin(origin: string, site: string): boolean {
    try {
      const url = new URL(origin);
      const host = url.hostname.toLowerCase().replace(/\.$/u, "");
      return (
        url.protocol === "https:" &&
        url.origin === origin &&
        isIP(host) === 0 &&
        !host.startsWith("[") &&
        host !== "localhost" &&
        !host.endsWith(".localhost") &&
        browserSiteFromUrl(origin) === site &&
        !this.#ownOrigins().some((own) => browserSiteFromUrl(own) === site)
      );
    } catch {
      return false;
    }
  }
}

/** Only status strings leave the page; the pre-check contains no credential. */
function fieldScript(input: {
  key: string;
  origin: string;
  field: "username" | "password" | "code";
  value?: string;
}): string {
  const writing = input.value !== undefined;
  return `(() => {
    "use strict";
    const key = ${JSON.stringify(input.key)};
    try {
      if (location.origin !== ${JSON.stringify(input.origin)}) return "stale";
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      ${writing ? 'const stash = window[key]; if (!stash || stash.doc !== document || stash.el !== el) return "stale";' : ""}
      if (!(el instanceof HTMLInputElement) || !el.isConnected || el.disabled || el.readOnly || el.matches(":disabled")) return "no-field";
      const types = ${JSON.stringify(input.field === "password" ? ["password"] : input.field === "username" ? ["text", "email", "tel", ""] : ["text", "tel", "number", "password"])};
      if (!types.includes(el.type)) return "no-field";
      ${
        writing
          ? `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(input.value)});
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return "filled";`
          : `Object.defineProperty(window, key, { value: { doc: document, el }, enumerable: false, configurable: true });
      return "ready";`
      }
    } catch { return "stale"; }
    ${writing ? "finally { try { delete window[key]; } catch {} }" : ""}
  })()`;
}
