import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { webContents } from "electron";
import { browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import type {
  BrowserLoginAuthority,
  BrowserLoginAuthorizeInput,
  PersonFillInput,
  PersonFillScope,
  PersonSaveCandidate,
} from "@opensteer/browser-runtime-core";
import {
  CardFieldSchema,
  cardUseLifetimeMs,
  type CardField,
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
  type PasswordSignInCard,
} from "@opensteer/protocol";
import { PasswordsBrokerSignInRequestParamsSchema } from "@opensteer/protocol/passwords-broker";
import {
  PasswordsBrokerFailure,
  type PasswordsBrokerSession,
  type PasswordsBrokerCardSession,
} from "./broker-session.js";
import { PasswordsPersonFillAuthority } from "./person-fill.js";
import { PasswordsPersonSaveAuthority } from "./person-save.js";
import type { DesktopPasswordsStatus } from "@opensteer/protocol/desktop";
import { sealLoginEnvelope } from "./login-envelope.js";

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
  readonly referenceBound: boolean;
  readonly credential: "login" | "card";
  readonly broker: PasswordsBrokerSession;
  queue: Promise<void>;
  authorized: boolean;
  committed: boolean;
  card: {
    state: () => PasswordSignInCard;
    approve: (
      approval: Extract<PasswordSignInAuthorityCommand, { type: "login.approve" }>,
    ) => Promise<
      Extract<PasswordSignInAuthorityResult, { type: "login.approve.result" }>["result"]
    >;
  } | null;
}

export class PasswordsLoginAuthority implements BrowserLoginAuthority {
  readonly #broker: PasswordsBrokerSession;
  readonly #personFill: PasswordsPersonFillAuthority;
  readonly #personSave: PasswordsPersonSaveAuthority;
  readonly #unobserveStatus: (() => void) | undefined;
  readonly #cardBroker: (PasswordsBrokerSession & PasswordsBrokerCardSession) | undefined;
  readonly #epochs = new WeakMap<Electron.WebContents, { value: number }>();
  readonly #ownOrigins: () => readonly string[];
  readonly #operations = new Map<string, Operation>();
  readonly #references = new Map<string, string>();
  readonly #controls = new Map<string, { controller: AbortController; expiry: NodeJS.Timeout }>();

  constructor(options: {
    broker: PasswordsBrokerSession;
    ownOrigins: () => readonly string[];
    observeStatus?: (listener: (status: DesktopPasswordsStatus) => void) => () => void;
  }) {
    this.#broker = options.broker;
    this.#personFill = new PasswordsPersonFillAuthority(options.broker);
    this.#personSave = new PasswordsPersonSaveAuthority(options.broker, (origin) => {
      try {
        return this.#allowedOrigin(origin, browserSiteFromUrl(origin));
      } catch {
        return false;
      }
    });
    this.#unobserveStatus = options.observeStatus?.((status) =>
      this.#personFill.statusChanged(status),
    );
    if (
      "cardRequest" in options.broker &&
      "cardRelease" in options.broker &&
      "cardApprove" in options.broker &&
      "cardProbe" in options.broker
    )
      this.#cardBroker = options.broker as PasswordsBrokerSession & PasswordsBrokerCardSession;
    this.#ownOrigins = options.ownOrigins;
  }

  personFillAccounts(input: PersonFillScope) {
    return this.#personFill.accounts(input);
  }

  personFill(input: PersonFillInput) {
    return this.#personFill.fill(input);
  }

  personSaveBegin(input: PersonSaveCandidate) {
    return this.#personSave.begin(input);
  }

  personSaveCommit(transactionId: string) {
    return this.#personSave.commit(transactionId);
  }

  personSaveCancel(transactionId: string) {
    this.#personSave.cancel(transactionId);
  }

  async probe(input: { site: string }) {
    // The Host's command carries its `type`; the broker's strict params take the site alone.
    return (await this.#broker.probe({ site: input.site })).passwords;
  }

  async authorize(
    input: BrowserLoginAuthorizeInput | ModernAuthorizeInput,
    signal: AbortSignal,
    needs: (need: "approval" | null) => void,
  ): Promise<Authorization> {
    const referenceBound = "loginRef" in input;
    const broker = this.#broker;
    const { promise, resolve } = Promise.withResolvers<Authorization>();
    const authority = new AbortController();
    let settled = false;
    let approving = false;
    let state: PasswordSignInCard = { stage: "gone" };
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
      referenceBound,
      credential: "login",
      broker,
      queue: Promise.resolve(),
      authorized: false,
      committed: false,
      card: null,
      expiresAt: input.expiresAt.getTime(),
      site: input.site,
      close: () => {
        signal.removeEventListener("abort", cancelled);
        unsubscribeLifetime();
        operation.card = null;
        finish({ kind: "cancelled", reason: "authority-lost" });
      },
    };
    this.#operations.set(input.operationId, operation);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    const authorized = (account: string, prepared = false) => {
      if (settled || signal.aborted || authority.signal.aborted) return;
      if (Date.now() >= operation.expiresAt) {
        finish({ kind: "expired" });
        return;
      }
      operation.authorized = true;
      operation.committed = !prepared;
      state = { stage: "authorized" };
      settled = true;
      needs(null);
      resolve({ kind: "authorized", account, authority: authority.signal });
    };
    const unavailable = (reason: "busy" | "passwords-off" | "not-set-up") =>
      finish(reason === "busy" ? { kind: "busy" } : { kind: "unavailable", reason });
    operation.card = {
      state: () => state,
      approve: async (
        approval: Extract<PasswordSignInAuthorityCommand, { type: "login.approve" }>,
      ) => {
        if (
          "credential" in approval ||
          settled ||
          approving ||
          signal.aborted ||
          state.stage !== "approval"
        )
          return {
            ok: false,
            card: state,
            message: "That sign-in is no longer waiting for approval.",
          };
        if (Date.now() >= operation.expiresAt) {
          finish({ kind: "expired" });
          return {
            ok: false,
            card: state,
            message: "That sign-in expired. Ask the agent to request it again.",
          };
        }
        approving = true;
        try {
          const result = await broker.approve(
            {
              transactionId: input.operationId,
              loginId: approval.loginId,
              revision: approval.revision,
              remember: approval.remember,
              permissionVersion: approval.permissionVersion,
            },
            signal,
          );
          if (result.decision === "authorized") {
            authorized(result.login.account, true);
            return { ok: true };
          }
          if (result.decision === "unavailable") {
            unavailable(result.reason);
            return {
              card: state,
              ok: false,
              message: "Opensteer Passwords is no longer available for this sign-in.",
            };
          }
          state = {
            stage: "approval",
            accounts: result.accounts,
            permissionVersion: 6 as const,
          };
          return { ok: false, card: state, message: result.message };
        } catch (error) {
          if (error instanceof PasswordsBrokerFailure && error.code === "invalid")
            return { ok: false, card: state, message: error.message };
          if (signal.aborted) cancelled();
          else finish({ kind: "unavailable", reason: "not-responding" });
          return {
            ok: false,
            card: state,
            message: "Opensteer Passwords could not authorize this sign-in.",
          };
        } finally {
          approving = false;
        }
      },
    };
    try {
      if (!settled) {
        const grant = await broker.request(
          PasswordsBrokerSignInRequestParamsSchema.parse({
            ...input.requester,
            deploymentId: input.deploymentId,
            expiresAt: input.expiresAt.toISOString(),
            protocolVersion: 10,
            permissionVersion: 6,
            site: input.site,
            transactionId: input.operationId,
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
              permissionVersion: 6 as const,
            };
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
        case "card.probe":
          return {
            type: "card.probe.result",
            cards: this.#cardBroker ? (await this.#cardBroker.cardProbe()).cards : "unavailable",
          };
        case "login.get":
          return {
            type: "login.get.result",
            card: this.#operations.get(command.operationId)?.card?.state() ?? { stage: "gone" },
          };
        case "login.approve": {
          const card = this.#operations.get(command.operationId)?.card;
          return {
            type: "login.approve.result",
            result: card
              ? await card.approve(command)
              : {
                  ok: false,
                  message: "This sign-in is no longer waiting.",
                  card: { stage: "gone" },
                },
          };
        }
        case "login.commit": {
          const operation = this.#operations.get(command.operationId);
          if (!operation || !operation.authorized || !this.#live(command.operationId, operation))
            return { type: "login.committed", committed: false };
          const result = await operation.broker.commit(
            command.operationId,
            operation.authority.signal,
          );
          operation.committed = result.committed && this.#live(command.operationId, operation);
          return { type: "login.committed", committed: operation.committed };
        }
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
          if ("credential" in command) return this.#authorizeCard(command, emit);
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

  #authorizeCard(
    input: Extract<PasswordSignInAuthorityCommand, { type: "login.authorize"; credential: "card" }>,
    emit: (event: PasswordSignInAuthorityEvent) => void,
  ): PasswordSignInAuthorityResult {
    const broker = this.#cardBroker;
    if (!broker || this.#operations.has(input.operationId) || this.#references.has(input.cardRef))
      return { type: "unavailable" };
    if (
      [...this.#operations.values()].filter((op) => !op.authorized).length >=
      maxPasswordSignInsPerHost
    )
      return { type: "unavailable" };
    const expiresAt = Math.min(Date.parse(input.expiresAt), Date.now() + cardUseLifetimeMs);
    if (expiresAt <= Date.now()) return { type: "unavailable" };
    const authority = new AbortController();
    let state: PasswordSignInCard = { stage: "gone" };
    let approving = false;
    let detach = () => {};
    const operation: Operation = {
      site: input.site,
      expiresAt,
      authority,
      broker,
      credential: "card",
      referenceBound: true,
      queue: Promise.resolve(),
      authorized: false,
      committed: false,
      close: () => {
        detach();
        state = { stage: "gone" };
      },
      card: {
        state: () => state,
        approve: async (approval) => {
          const gone = () => ({
            ok: false as const,
            card: state,
            message: "This card use is no longer waiting for approval.",
          });
          if (
            !("credential" in approval) ||
            approving ||
            state.stage !== "card-approval" ||
            !this.#live(input.operationId, operation)
          )
            return gone();
          approving = true;
          try {
            const result = await broker.cardApprove(
              {
                transactionId: input.operationId,
                cardId: approval.cardId,
                revision: approval.revision,
                permissionVersion: 7,
              },
              authority.signal,
            );
            if (!this.#live(input.operationId, operation)) return gone();
            if (result.decision === "authorized") {
              operation.authorized = true;
              state = { stage: "authorized" };
              this.#references.set(input.cardRef, input.operationId);
              emit({
                type: "login.result",
                operationId: input.operationId,
                outcome: {
                  kind: "authorized",
                  cardRef: input.cardRef,
                  brand: result.card.brand,
                  lastFour: result.card.lastFour,
                  expiresAt: new Date(expiresAt).toISOString(),
                },
              });
              return { ok: true };
            }
            if (result.decision === "approve") {
              state = { stage: "card-approval", cards: result.cards, permissionVersion: 7 };
              return { ok: false, card: state, message: "The saved cards changed. Choose again." };
            }
            await this.end(input.operationId);
            return gone();
          } catch {
            await this.end(input.operationId);
            return gone();
          } finally {
            approving = false;
          }
        },
      },
    };
    this.#operations.set(input.operationId, operation);
    const expiry = setTimeout(() => {
      void this.end(input.operationId);
    }, expiresAt - Date.now());
    expiry.unref();
    this.#controls.set(input.operationId, { controller: authority, expiry });
    authority.signal.addEventListener(
      "abort",
      () => emit({ type: "login.ended", operationId: input.operationId }),
      { once: true },
    );
    void broker
      .cardRequest(
        {
          ...input.requester,
          deploymentId: input.deploymentId,
          transactionId: input.operationId,
          expiresAt: new Date(expiresAt).toISOString(),
          site: input.site,
          protocolVersion: 10,
          permissionVersion: 7,
        },
        authority.signal,
      )
      .then((grant) => {
        if (!this.#live(input.operationId, operation)) return;
        const lost = () => {
          void this.end(input.operationId);
        };
        grant.lifetime.addEventListener("abort", lost, { once: true });
        detach = () => grant.lifetime.removeEventListener("abort", lost);
        if (grant.lifetime.aborted) {
          lost();
          return;
        }
        if (grant.decision.decision !== "approve" || grant.decision.cards.length === 0) {
          emit({
            type: "login.result",
            operationId: input.operationId,
            outcome: {
              kind: "unavailable",
              reason:
                grant.decision.decision === "unavailable"
                  ? grant.decision.reason === "busy"
                    ? "not-responding"
                    : grant.decision.reason
                  : "no-saved-card",
            },
          });
          void this.end(input.operationId);
          return;
        }
        state = { stage: "card-approval", cards: grant.decision.cards, permissionVersion: 7 };
        emit({ type: "login.needs", operationId: input.operationId, need: "approval" });
      })
      .catch(() => {
        void this.end(input.operationId);
      });
    return { type: "login.authorize.started" };
  }

  async fillCardReference(input: {
    lease: AbortSignal;
    cardRef: string;
    targetId: string;
    field: CardField;
  }): Promise<LoginFillStatus> {
    const id = this.#references.get(input.cardRef);
    const operation = id ? this.#operations.get(id) : undefined;
    if (!id || !operation || operation.credential !== "card" || !this.#cardBroker) return "expired";
    if (!CardFieldSchema.safeParse(input.field).success) return "no-field";
    try {
      return await this.#serialized(operation, () => this.#fillCard(input, id, operation));
    } catch {
      return operation.authority.signal.reason === "denied" ? "denied" : "expired";
    }
  }

  async #fillCard(
    input: { lease: AbortSignal; targetId: string; field: CardField },
    id: string,
    operation: Operation,
  ): Promise<LoginFillStatus> {
    if (!operation.committed || input.lease.aborted || !this.#live(id, operation)) return "expired";
    const wc = webContents.fromDevToolsTargetId(input.targetId);
    if (!wc || wc.isDestroyed()) return "stale";
    let epoch = this.#epochs.get(wc);
    if (!epoch) {
      epoch = { value: 0 };
      this.#epochs.set(wc, epoch);
      const captured = epoch;
      wc.on("did-start-navigation", (_event, _url, sameDocument) => {
        if (!sameDocument) captured.value++;
      });
      wc.on("render-process-gone", () => {
        captured.value++;
      });
      wc.once("destroyed", () => {
        captured.value++;
      });
    }
    const version = epoch.value;
    const top = wc.mainFrame;
    const frame = wc.focusedFrame;
    if (!frame || frame.detached) return "no-field";
    const topOrigin = top.origin;
    const origin = frame.origin;
    const https = (url: string, expected: string) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && parsed.origin === expected;
      } catch {
        return false;
      }
    };
    if (
      !this.#allowedOrigin(topOrigin, operation.site) ||
      !https(top.url, topOrigin) ||
      !https(frame.url, origin)
    )
      return "wrong-site";
    const key = `__opensteer_fill_${randomBytes(24).toString("hex")}`;
    let releasing = false;
    try {
      const ready = await frame.executeJavaScript(
        cardFieldScript({ key, origin, field: input.field }),
      );
      if (ready !== "ready") return ready === "no-field" ? "no-field" : "stale";
      releasing = true;
      const release = await this.#cardBroker!.cardRelease(
        { transactionId: id, topOrigin, frameOrigin: origin, field: input.field },
        operation.authority.signal,
      );
      releasing = false;
      if (!release.released) {
        if (release.reason === "no-field") return "no-field";
        if (release.reason === "wrong-site") return "wrong-site";
        if (release.reason === "ended") return "expired";
        operation.authority.abort("denied");
        return "denied";
      }
      try {
        if (input.lease.aborted || Date.now() >= operation.expiresAt) return "expired";
        if (operation.authority.signal.aborted) return "denied";
        if (
          wc.isDestroyed() ||
          epoch.value !== version ||
          wc.mainFrame !== top ||
          wc.focusedFrame !== frame ||
          frame.detached ||
          top.origin !== topOrigin ||
          frame.origin !== origin ||
          !https(top.url, topOrigin) ||
          !https(frame.url, origin)
        )
          return "stale";
        let ancestor = frame;
        while (ancestor.parent) ancestor = ancestor.parent;
        if (ancestor !== top) return "stale";
        const script = cardFieldScript({ key, origin, field: input.field, value: release.value });
        release.value = "";
        const status = await frame.executeJavaScript(script);
        return status === "filled" || status === "no-field" ? status : "stale";
      } finally {
        release.value = "";
      }
    } catch {
      return releasing ? "unavailable" : "stale";
    } finally {
      await frame
        .executeJavaScript(`try { delete window[${JSON.stringify(key)}]; } catch {}`)
        .catch(() => undefined);
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
    if (
      !operation ||
      operation.credential === "card" ||
      !operation.authorized ||
      !operation.committed ||
      !operation.referenceBound
    )
      return expired();
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
    if (operation.credential === "card") return "denied";
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
    if (
      !operation ||
      !operation.committed ||
      input.lease.aborted ||
      Date.now() >= operation.expiresAt
    )
      return "expired";
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
          kind: "browser",
        },
        // Broker cancellation ends the shared transaction. A detached browser
        // only discards this fill after release; Personal authority still cancels it.
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
    this.#unobserveStatus?.();
    await this.#personFill.close();
    this.#personSave.close();
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

function cardFieldScript(input: {
  key: string;
  origin: string;
  field: CardField;
  value?: string;
}): string {
  const writing = input.value !== undefined;
  return `(() => { "use strict";
    const key = ${JSON.stringify(input.key)};
    try {
      if (location.origin !== ${JSON.stringify(input.origin)}) return "stale";
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      ${writing ? 'const stash = window[key]; if (!stash || stash.doc !== document || stash.el !== el) return "stale";' : ""}
      if (!el || !el.isConnected || el.disabled || el.matches(":disabled")) return "no-field";
      const select = el instanceof HTMLSelectElement;
      if (select ? !["expiry-month", "expiry-year"].includes(${JSON.stringify(input.field)}) : !(el instanceof HTMLInputElement) || el.readOnly || !["text","tel","number","password", ""].includes(el.type)) return "no-field";
      ${
        writing
          ? `let value = ${JSON.stringify(input.value)};
      if (select) {
        const month = ${JSON.stringify(input.field)} === "expiry-month";
        const names = ["january","february","march","april","may","june","july","august","september","october","november","december"];
        const matches = text => {
          const t = text.trim().toLowerCase();
          if (month) {
            const name = names[Number(value)-1];
            return /^\\d{1,2}$/.test(t) ? Number(t) === Number(value) : t === name || t === name.slice(0,3) || new RegExp("^0?" + Number(value) + "\\\\s*[-/]\\\\s*(?:" + name + "|" + name.slice(0,3) + ")$").test(t);
          }
          return /^\\d{2}$|^\\d{4}$/.test(t) && (t.length === 2 ? t === value.slice(-2) : t === value);
        };
        const enabled = [...el.options].filter(o => !o.disabled && !(o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled));
        // Named months identify themselves; their values may be zero-based.
        const named = month && enabled.some(o => names.some(n => o.label.toLowerCase().includes(n.slice(0,3))));
        const options = enabled.filter(o => named ? matches(o.label) : matches(o.value) || matches(o.label));
        if (options.length !== 1) return "no-field";
        value = options[0].value;
      }
      Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", {bubbles:true, composed:true}));
      el.dispatchEvent(new Event("change", {bubbles:true, composed:true}));
      return "filled";`
          : `Object.defineProperty(window, key, {value:{doc:document, el}, configurable:true}); return "ready";`
      }
    } catch { return "stale"; } ${writing ? "finally { try { delete window[key]; } catch {} }" : ""}
  })()`;
}
