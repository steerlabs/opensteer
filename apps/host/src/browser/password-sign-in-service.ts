import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  type AgentEvent,
  type Request,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { RequestStore } from "@opensteer/database";
import {
  passwordSignInAgentWaitMs,
  passwordLoginLifetimeMs,
  loginEnvelopeMaxLifetimeMs,
  PasswordSignInRequesterSchema,
  type AgentBrowserSignInResult,
  type LoginText,
  type LoginReceiverKey,
  type LoginEnvelopeBinding,
  type LoginSealResult,
  type PasswordSignInAvailability,
  type PasswordSignInCancelReason,
  type LoginAuthorizationOutcome,
} from "@opensteer/protocol";
import { browserSiteDomain } from "@opensteer/browser-profile/source-state";
import type { ComputerAppHub, PasswordSignInHubEvent } from "../computer-apps/computer-app-hub.js";
import { canonicalJson } from "@opensteer/shared/canonicalJson";

interface PasswordSignInComputer {
  readonly name: string;
  readonly runnerId: RunnerId;
}

const defaultDeclineAnswerMs = 10_000;
const defaultReconcileIntervalMs = 10_000;
const sweepPageSize = 64;

type PasswordSignInRequests = Pick<
  RequestStore,
  | "get"
  | "hasPasswordSignInAuthority"
  | "listPendingPasswordSignIns"
  | "openPasswordSignIn"
  | "settlePasswordSignInRequest"
>;
type Settlement = Parameters<RequestStore["settlePasswordSignInRequest"]>[0]["settlement"];
type Finish = "settled" | "ended-elsewhere" | "retrying";

interface Call {
  readonly callId: string;
  readonly canRequest: boolean;
  readonly arrivedAt?: number;
  readonly ownerId: UserId;
  readonly reason: string;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
}
interface Operation {
  readonly id: string;
  readonly starter: Call;
  readonly target: PasswordSignInComputer;
  readonly loginRef: string;
  readonly site: string;
  readonly expiresAt: number;
  readonly calls: Map<string, Call>;
  readonly answers: Map<string, AgentBrowserSignInResult>;
  readonly waiters: Set<() => void>;
  cancelSent: PasswordSignInCancelReason | null;
  cancelledAt: number | null;
  need: "approval" | null;
  result: AgentBrowserSignInResult | null;
  requestId: RequestId | null;
  opening: Promise<void> | null;
  settlement: Settlement | null;
  settling: Promise<Finish> | null;
  settled: boolean;
  authorityEnded: boolean;
}

export interface PasswordLoginLease {
  readonly loginRef: string;
  readonly workspaceId: WorkspaceId;
  readonly site: string;
  readonly account: string;
  readonly expiresAt: number;
  readonly operationId: string;
}

/** Authorization settles once; the resulting lease lives until its authority ends. */
export class PasswordSignInService {
  readonly #authority: PasswordSignInServiceOptions["authority"];
  readonly #resolveAuthority: PasswordSignInServiceOptions["resolveAuthority"];
  readonly #agentWaitMs: number;
  readonly #declineAnswerMs: number;
  readonly #describe: PasswordSignInServiceOptions["describe"];
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #onRequestResolved: () => void;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #leases = new Map<string, PasswordLoginLease>();
  readonly #operations = new Map<string, Operation>();
  readonly #calls = new Map<string, Operation>();
  readonly #bySite = new Map<string, Operation>();
  readonly #admissions = new Map<string, Promise<void>>();
  readonly #requests: PasswordSignInRequests;
  readonly #reconcile: ReturnType<typeof setInterval>;
  readonly #unsubscribe: () => void;
  #closed = false;
  #reconciling = false;

  constructor(options: PasswordSignInServiceOptions) {
    this.#authority = options.authority;
    this.#resolveAuthority = options.resolveAuthority;
    this.#agentWaitMs = options.agentWaitMs ?? passwordSignInAgentWaitMs;
    this.#declineAnswerMs = options.declineAnswerMs ?? defaultDeclineAnswerMs;
    this.#describe = async (input) => {
      const description = await options.describe(input);
      return {
        ...description,
        deploymentName:
          description.deploymentName
            .replace(/[\p{Cc}\p{Cf}]/gu, " ")
            .trim()
            .slice(0, 120)
            .replace(/\p{Cs}/gu, "")
            .trim() || "Opensteer",
        threadTitle:
          description.threadTitle
            .replace(/[\p{Cc}\p{Cf}]/gu, " ")
            .trim()
            .slice(0, 200)
            .replace(/\p{Cs}/gu, "")
            .trim() || "An agent",
        workspaceName:
          description.workspaceName
            .replace(/[\p{Cc}\p{Cf}]/gu, " ")
            .trim()
            .slice(0, 120)
            .replace(/\p{Cs}/gu, "")
            .trim() || "Workspace",
      };
    };
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => undefined);
    this.#onRequestResolved = options.onRequestResolved;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#requests = options.requests;
    this.#unsubscribe = this.#authority.onPasswordSignIn((runnerId, event) => {
      void this.#onAuthorityEvent(runnerId, event).catch(this.#onError);
    });
    this.#reconcile = setInterval(() => {
      void this.#reconcileOperations().catch(this.#onError);
    }, options.reconcileIntervalMs ?? defaultReconcileIntervalMs);
    this.#reconcile.unref();
  }

  async sweepAfterRestart(): Promise<void> {
    let after: RequestId | null = null;
    for (;;) {
      const page = await this.#requests.listPendingPasswordSignIns({ after, limit: sweepPageSize });
      for (const request of page) {
        if ([...this.#operations.values()].some((operation) => operation.requestId === request.id))
          continue;
        const result = await this.#requests.settlePasswordSignInRequest({
          ownerId: request.requestedBy,
          requestId: request.id,
          settlement: {
            status: "fulfilled",
            response: {
              outcome:
                request.payload.kind === "browser.password-sign-in" &&
                request.payload.scope === "workspace"
                  ? "interrupted"
                  : "session-closed",
            },
          },
        });
        if (result) this.#announce(result);
      }
      if (page.length < sweepPageSize) return;
      after = page.at(-1)?.id ?? null;
    }
  }

  async probe(ownerId: UserId, site: string): Promise<PasswordSignInAvailability> {
    const target = await this.#resolveAuthority(ownerId);
    if (!target || !this.#authority.passwordSignInSupported(target.runnerId)) return "unavailable";
    const result = await this.#authority.sendPasswordSignIn(target.runnerId, {
      type: "signin.probe",
      site,
    });
    return result.type === "signin.probe.result" ? result.passwords : "unavailable";
  }

  async seal(
    input: LoginText & {
      readonly workspaceId: WorkspaceId;
      readonly receiver: LoginReceiverKey;
      readonly binding: LoginEnvelopeBinding;
    },
  ): Promise<LoginSealResult> {
    const lease = this.#liveLease(input.loginRef);
    if (!lease || lease.workspaceId !== input.workspaceId || input.binding.field !== input.field)
      return { type: "login.seal.result", status: "denied" };
    const operation = this.#operations.get(lease.operationId);
    if (!operation || input.binding.expiresAt <= this.#now())
      return { type: "login.seal.result", status: "expired" };
    const binding = {
      ...input.binding,
      expiresAt: Math.min(
        input.binding.expiresAt,
        lease.expiresAt,
        this.#now() + loginEnvelopeMaxLifetimeMs,
      ),
    };
    const result = await this.#authority.sendPasswordSignIn(operation.target.runnerId, {
      type: "login.seal",
      operationId: operation.id,
      receiver: input.receiver,
      binding,
    });
    if (this.#liveLease(input.loginRef) !== lease || input.binding.expiresAt <= this.#now())
      return { type: "login.seal.result", status: "denied" };
    if (result.type !== "login.seal.result")
      return { type: "login.seal.result", status: "unavailable" };
    if (
      result.status === "sealed" &&
      (result.envelope.binding.expiresAt > binding.expiresAt ||
        result.envelope.binding.expiresAt <= this.#now() ||
        canonicalJson({ ...result.envelope.binding, expiresAt: binding.expiresAt }) !==
          canonicalJson(binding))
    )
      return { type: "login.seal.result", status: "denied" };
    if (result.status === "denied" || result.status === "expired") this.#dropLeases(operation);
    return result;
  }

  replayResult(request: Request): AgentBrowserSignInResult {
    if (request.status === "pending") {
      return {
        replayed: true,
        requestId: request.id,
        status: "pending",
      };
    }
    if (request.status === "declined") return { requestId: request.id, status: "declined" };
    return { requestId: request.id, status: "resolved" };
  }

  leaseForOperation(operationId: string): PasswordLoginLease | null {
    for (const lease of this.#leases.values()) {
      if (lease.operationId === operationId) return this.#liveLease(lease.loginRef);
    }
    return null;
  }

  validateLease(input: { loginRef: string; workspaceId: WorkspaceId }): boolean {
    const lease = this.#liveLease(input.loginRef);
    return lease !== null && lease.workspaceId === input.workspaceId;
  }

  #liveLease(loginRef: string): PasswordLoginLease | null {
    const lease = this.#leases.get(loginRef);
    if (!lease) return null;
    const operation = this.#operations.get(lease.operationId);
    if (
      this.#closed ||
      this.#now() >= lease.expiresAt ||
      !operation ||
      !this.#authority.passwordSignInSupported(operation.target.runnerId)
    ) {
      this.#leases.delete(loginRef);
      if (operation)
        void this.#cancel(
          operation,
          this.#now() >= lease.expiresAt ? "expired" : "authority-lost",
        ).catch(this.#onError);
      return null;
    }
    return lease;
  }

  #ready(workspaceId: WorkspaceId, site: string): AgentBrowserSignInResult | null {
    for (const lease of this.#leases.values()) {
      if (
        lease.workspaceId === workspaceId &&
        lease.site === site &&
        this.#liveLease(lease.loginRef)
      )
        return { status: "ready", site, loginRef: lease.loginRef, account: lease.account };
    }
    return null;
  }

  /**
   * A call answered from a live lease joins that lease's operation, so reusing
   * its call ID for another Workspace or site is refused like any joined call.
   */
  #bindToLease(result: AgentBrowserSignInResult, call: Call): void {
    if (result.status !== "ready") return;
    const lease = this.#leases.get(result.loginRef);
    const operation = lease ? this.#operations.get(lease.operationId) : undefined;
    if (operation) this.#recordCall(operation, call);
  }

  #dropLeases(operation: Operation): void {
    for (const lease of this.#leases.values()) {
      if (lease.operationId === operation.id) this.#leases.delete(lease.loginRef);
    }
  }

  /** A live join or a recorded call bypasses method selection and start rate limits. */
  join(input: Call & { readonly site: string }): Promise<AgentBrowserSignInResult> | null {
    const own = this.#calls.get(callKey(input));
    if (own) this.#assertScope(own, input);
    const ready = this.#ready(input.workspaceId, input.site);
    if (ready) {
      this.#bindToLease(ready, input);
      return Promise.resolve(ready);
    }
    if (own?.settlement?.status === "fulfilled" && own.settlement.response.outcome === "authorized")
      return null;
    const operation = own ?? this.#bySite.get(siteKey(input.workspaceId, input.site));
    if (!operation) return null;
    this.#assertScope(operation, input);
    if (operation.starter.workspaceId !== input.workspaceId)
      return Promise.resolve(unavailable(input.site, "busy"));
    const recorded = operation.answers.get(callKey(input));
    if (recorded) return Promise.resolve(recorded);
    const replayed = operation.calls.has(callKey(input)) || operation.requestId !== null;
    this.#recordCall(operation, input);
    return this.#answer(operation, input, replayed);
  }

  async request(
    input: Call & {
      readonly site: string;
      readonly admitStart: () => boolean;
    },
  ): Promise<AgentBrowserSignInResult> {
    const key = siteKey(input.workspaceId, input.site);
    const prior = this.#admissions.get(key) ?? Promise.resolve();
    const admitted = prior.then(async (): Promise<Operation | AgentBrowserSignInResult> => {
      const own = this.#calls.get(callKey(input));
      if (own) this.#assertScope(own, input);
      const ready = this.#ready(input.workspaceId, input.site);
      if (ready) {
        this.#bindToLease(ready, input);
        return ready;
      }
      const existing =
        (own?.settlement?.status === "fulfilled" && own.settlement.response.outcome === "authorized"
          ? undefined
          : own) ?? this.#bySite.get(key);
      if (existing) {
        this.#assertScope(existing, input);
        if (existing.starter.workspaceId !== input.workspaceId)
          return unavailable(input.site, "busy");
        this.#recordCall(existing, input);
        return existing;
      }
      const target = await this.#resolveAuthority(input.ownerId);
      if (this.#closed || !target || !this.#authority.passwordSignInSupported(target.runnerId))
        return unavailable(input.site, "unsupported");
      if (!input.admitStart()) return unavailable(input.site, "rate-limited");
      if (!(await this.#requests.hasPasswordSignInAuthority(authority(input))))
        return unavailable(input.site, "stopped");
      const description = await this.#describe({
        ownerId: input.ownerId,
        threadId: input.threadId,
        workspaceId: input.workspaceId,
      });
      const requester = PasswordSignInRequesterSchema.parse({
        ...description,
        reason: input.reason,
      });
      const operation: Operation = {
        id: randomUUID(),
        starter: input,
        target,
        loginRef: `lgn_${randomUUID().replaceAll("-", "")}`,
        site: input.site,
        expiresAt: this.#now() + passwordLoginLifetimeMs,
        calls: new Map(),
        answers: new Map(),
        waiters: new Set(),
        cancelSent: null,
        cancelledAt: null,
        need: null,
        result: null,
        requestId: null,
        opening: null,
        settlement: null,
        settling: null,
        settled: false,
        authorityEnded: false,
      };
      this.#operations.set(operation.id, operation);
      this.#bySite.set(key, operation);
      this.#recordCall(operation, input);
      void this.#authority
        .sendPasswordSignIn(target.runnerId, {
          type: "login.authorize",
          loginRef: operation.loginRef,
          expiresAt: new Date(operation.expiresAt).toISOString(),
          operationId: operation.id,
          site: input.site,
          requester,
          workspaceId: input.workspaceId,
        })
        .then(async (result) => {
          if (result.type !== "login.authorize.started")
            await this.#finish(operation, interrupted());
        })
        .catch(async () => {
          if (!operation.settlement) await this.#finish(operation, interrupted());
        })
        .catch(this.#onError);
      return operation;
    });
    const tail = admitted.then(
      () => undefined,
      () => undefined,
    );
    this.#admissions.set(key, tail);
    void tail.then(() => {
      if (this.#admissions.get(key) === tail) this.#admissions.delete(key);
    });
    const operation = await admitted;
    if (!("id" in operation)) return operation;
    return this.#answer(operation, input, operation.starter !== input);
  }

  async decline(input: {
    readonly ownerId: UserId;
    readonly requestId: RequestId;
  }): Promise<Request["status"]> {
    const request = await this.#requests.get(input.requestId);
    if (
      !request ||
      request.payload.kind !== "browser.password-sign-in" ||
      request.requestedBy !== input.ownerId
    ) {
      throw new OpensteerError({ code: "not_found", message: "Sign-in request not found." });
    }
    if (request.status !== "pending") return request.status;
    const operation = this.#operations.get(request.payload.operationId);
    if (!operation) {
      const result = await this.#requests.settlePasswordSignInRequest({
        ownerId: input.ownerId,
        requestId: input.requestId,
        settlement: { status: "declined" },
      });
      if (result) this.#announce(result);
    } else {
      await this.#cancel(operation, "declined");
      await this.#wait(operation, this.#declineAnswerMs, true);
      if (!operation.settlement) await this.#finish(operation, { status: "declined" });
    }
    if (operation?.settling) await operation.settling;
    return (await this.#requests.get(input.requestId))?.status ?? "declined";
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#reconcile);
    this.#unsubscribe();
    this.#leases.clear();
    for (const operation of this.#operations.values()) {
      void this.#cancel(operation, "authority-lost").catch(this.#onError);
      if (!operation.settlement) void this.#finish(operation, interrupted()).catch(this.#onError);
    }
  }

  async #answer(
    operation: Operation,
    call: Call,
    replayed: boolean,
  ): Promise<AgentBrowserSignInResult> {
    const recorded = operation.answers.get(callKey(call));
    if (recorded) return recorded;
    const refuse = (reason: "busy" | "needs-approval") => {
      const answer = unavailable(operation.site, reason);
      operation.answers.set(callKey(call), answer);
      return answer;
    };
    const cannotJoin = () => {
      if (
        call.runId === operation.starter.runId ||
        !(operation.need || operation.requestId || operation.opening)
      )
        return null;
      return refuse("busy");
    };
    const refused = cannotJoin();
    if (refused) return refused;
    if (!call.canRequest && (operation.requestId || operation.opening))
      return refuse("needs-approval");
    if (!operation.requestId)
      await this.#wait(
        operation,
        Math.max(0, this.#agentWaitMs - (Date.now() - (call.arrivedAt ?? Date.now()))),
      );
    const refusedAfterWait = cannotJoin();
    if (refusedAfterWait) return refusedAfterWait;
    if (!operation.settlement && !operation.need && !operation.requestId && !operation.opening) {
      // Cancellation can synchronously emit a terminal event. Decide the timeout
      // result first so that its acknowledgement cannot replace it.
      await this.#finish(operation, {
        status: "fulfilled",
        response: { outcome: "unavailable", reason: "not-responding" },
      });
      await this.#cancel(operation, "authority-lost");
    }
    if (!operation.settlement && operation.need) {
      if (!call.canRequest) {
        if (operation.requestId || operation.opening) return refuse("needs-approval");
        await this.#cancel(operation, "withdrawn");
        await this.#wait(operation, this.#declineAnswerMs, true);
        if (!operation.settlement)
          await this.#finish(operation, {
            status: "fulfilled",
            response: { outcome: "interrupted" },
          });
        return refuse("needs-approval");
      }
      if (!operation.requestId)
        await (operation.opening ??= this.#openRequest(operation).finally(() => {
          operation.opening = null;
          if (operation.authorityEnded && (!operation.requestId || operation.settled))
            this.#forget(operation);
        }));
    }
    if (operation.opening) await operation.opening;
    const refusedAfterOpening = cannotJoin();
    if (refusedAfterOpening) return refusedAfterOpening;
    if (operation.requestId) {
      if (!operation.settlement) {
        const joined = await this.#requests.openPasswordSignIn(requestInput(operation, call));
        if (joined.request.id !== operation.requestId)
          throw new Error("Sign-in join changed its Request");
      }
      const request = await this.#requests.get(operation.requestId);
      if (request && request.status !== "pending") return this.replayResult(request);
      return {
        status: "pending",
        requestId: operation.requestId,
        replayed,
      };
    }
    if (
      operation.settlement?.status === "fulfilled" &&
      operation.settlement.response.outcome === "authorized"
    )
      return (
        this.#ready(call.workspaceId, operation.site) ?? unavailable(operation.site, "expired")
      );
    return operation.result ?? directResult(operation.site, operation.settlement ?? interrupted());
  }

  async #openRequest(operation: Operation): Promise<void> {
    if (operation.settlement) return;
    try {
      // The store holds live Run and Workspace fences through the insert.
      const created = await this.#requests.openPasswordSignIn({
        ...requestInput(operation, operation.starter),
        joinedCallIds: [...operation.calls.values()]
          .filter((call) => call.runId === operation.starter.runId)
          .map((call) => call.callId),
      });
      operation.requestId = created.request.id;
      for (const event of created.events) this.#onWorkspaceEvent(event);
      if (operation.settlement) await this.#finish(operation, operation.settlement);
      else if (created.request.status !== "pending")
        await this.#cancel(operation, "authority-lost");
    } catch (error) {
      this.#onError(error);
      await this.#cancel(operation, "authority-lost");
      await this.#finish(operation, {
        status: "fulfilled",
        response: { outcome: "interrupted" },
      });
    }
  }

  async #onAuthorityEvent(runnerId: RunnerId, event: PasswordSignInHubEvent): Promise<void> {
    if (event.type === "authority-lost") {
      const affected = [...this.#operations.values()].filter(
        (operation) => operation.target.runnerId === runnerId,
      );
      for (const operation of affected) {
        this.#dropLeases(operation);
        operation.authorityEnded = true;
      }
      await Promise.all(
        affected.map(async (operation) => {
          await this.#finish(operation, interrupted());
          if (!operation.opening && (!operation.requestId || operation.settled))
            this.#forget(operation);
        }),
      );
      return;
    }
    const operation = this.#operations.get(event.operationId);
    if (!operation || operation.target.runnerId !== runnerId) return;
    if (event.type === "login.ended") {
      operation.authorityEnded = true;
      this.#dropLeases(operation);
      await this.#finish(operation, interrupted());
      return;
    }
    if (event.type === "login.needs") {
      if (operation.settlement || operation.cancelSent) return;
      operation.need = event.need;
      // Start the Request at the person-needed event, even if the tool caller detached.
      if (event.need === "approval" && operation.starter.canRequest && !operation.requestId)
        await (operation.opening ??= this.#openRequest(operation).finally(() => {
          operation.opening = null;
        }));
      this.#notify(operation);
      return;
    }
    if (
      operation.settlement ||
      (event.outcome.kind === "authorized" &&
        (operation.cancelSent || operation.authorityEnded || this.#now() >= operation.expiresAt))
    ) {
      if (event.outcome.kind === "authorized" && !this.leaseForOperation(operation.id))
        await this.#authority.sendPasswordSignIn(runnerId, {
          type: "login.cancel",
          operationId: operation.id,
          reason: operation.cancelSent ?? "expired",
        });
      return;
    }
    if (event.outcome.kind === "authorized") {
      const expiresAt = Date.parse(event.outcome.expiresAt);
      if (
        event.outcome.loginRef !== operation.loginRef ||
        expiresAt > operation.expiresAt ||
        expiresAt <= this.#now()
      ) {
        await this.#cancel(operation, "authority-lost");
        await this.#finish(operation, interrupted());
        return;
      }
      this.#leases.set(operation.loginRef, {
        loginRef: operation.loginRef,
        account: event.outcome.account,
        expiresAt,
        workspaceId: operation.starter.workspaceId,
        site: operation.site,
        operationId: operation.id,
      });
    }
    if (event.outcome.kind === "busy") operation.result = unavailable(operation.site, "busy");
    await this.#finish(operation, settlementFor(event.outcome));
  }

  async #reconcileOperations(): Promise<void> {
    if (this.#reconciling || this.#closed) return;
    this.#reconciling = true;
    try {
      for (const lease of this.#leases.values()) this.#liveLease(lease.loginRef);
      for (const operation of this.#operations.values()) {
        if (operation.settlement) {
          if (operation.requestId && !operation.settled)
            await this.#finish(operation, operation.settlement);
          if (
            !operation.opening &&
            (operation.requestId
              ? operation.authorityEnded && operation.settled
              : this.#now() >= operation.expiresAt)
          )
            this.#forget(operation);
          continue;
        }
        const now = this.#now();
        if (!operation.cancelSent && now >= operation.expiresAt) {
          await this.#cancel(operation, "expired");
          await this.#finish(operation, { status: "fulfilled", response: { outcome: "expired" } });
          continue;
        }
        if (operation.cancelSent) {
          if (
            operation.cancelledAt !== null &&
            now >= operation.cancelledAt + this.#declineAnswerMs
          ) {
            await this.#finish(
              operation,
              operation.cancelSent === "declined" ? { status: "declined" } : interrupted(),
            );
          }
          continue;
        }
        if (operation.requestId) {
          const request = await this.#requests.get(operation.requestId);
          if (operation.settlement) continue;
          if (!request || request.status !== "pending")
            await this.#cancel(
              operation,
              request?.status === "withdrawn" ? "withdrawn" : "authority-lost",
            );
        } else {
          const permitted = await this.#requests.hasPasswordSignInAuthority(
            authority(operation.starter),
          );
          if (!operation.settlement && !permitted) await this.#cancel(operation, "authority-lost");
        }
      }
    } finally {
      this.#reconciling = false;
    }
  }

  async #cancel(operation: Operation, reason: PasswordSignInCancelReason): Promise<void> {
    if (operation.cancelSent) return;
    this.#dropLeases(operation);
    operation.cancelSent = reason;
    operation.authorityEnded = true;
    operation.cancelledAt = this.#now();
    void this.#authority
      .sendPasswordSignIn(operation.target.runnerId, {
        type: "login.cancel",
        operationId: operation.id,
        reason,
      })
      .then(async (result) => {
        if (result.type !== "login.cancelled") await this.#finish(operation, interrupted());
      })
      .catch(async () => {
        await this.#finish(operation, interrupted());
      })
      .catch(this.#onError);
  }

  async #finish(operation: Operation, settlement: Settlement): Promise<Finish> {
    const mine = operation.settlement === null || operation.settlement === settlement;
    operation.settlement ??= settlement;
    const key = siteKey(operation.starter.workspaceId, operation.site);
    if (this.#bySite.get(key) === operation) this.#bySite.delete(key);
    operation.need = null;
    this.#notify(operation);
    if (!operation.requestId) return mine ? "settled" : "ended-elsewhere";
    if (operation.settled) return "ended-elsewhere";
    if (operation.settling) {
      const result = await operation.settling;
      return mine ? result : "ended-elsewhere";
    }
    operation.settling = (async (): Promise<Finish> => {
      try {
        const result = await this.#requests.settlePasswordSignInRequest({
          ownerId: operation.starter.ownerId,
          requestId: operation.requestId!,
          settlement: operation.settlement!,
        });
        operation.settled = true;
        if (!result) {
          await this.#cancel(operation, "authority-lost");
          return "ended-elsewhere";
        }
        this.#announce(result);
        return mine ? "settled" : "ended-elsewhere";
      } catch (error) {
        this.#onError(error);
        return mine ? "retrying" : "ended-elsewhere";
      }
    })();
    try {
      return await operation.settling;
    } finally {
      operation.settling = null;
    }
  }

  #wait(operation: Operation, timeoutMs: number, terminalOnly = false): Promise<void> {
    if (operation.settlement || (!terminalOnly && operation.need)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (terminalOnly && !operation.settlement) return;
        clearTimeout(timer);
        operation.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        operation.waiters.delete(done);
        resolve();
      }, timeoutMs);
      timer.unref();
      operation.waiters.add(done);
    });
  }

  #forget(operation: Operation): void {
    // Without a durable Request, this is the only replay record for a refused call.
    if (!operation.requestId && this.#now() < operation.expiresAt) return;
    this.#operations.delete(operation.id);
    for (const identity of operation.calls.keys()) {
      if (this.#calls.get(identity) === operation) this.#calls.delete(identity);
    }
  }

  #notify(operation: Operation): void {
    for (const waiter of operation.waiters) waiter();
  }
  #recordCall(operation: Operation, call: Call): void {
    const identity: Call = {
      callId: call.callId,
      canRequest: call.canRequest,
      ownerId: call.ownerId,
      reason: call.reason,
      runId: call.runId,
      threadId: call.threadId,
      workspaceId: call.workspaceId,
    };
    operation.calls.set(callKey(call), identity);
    this.#calls.set(callKey(call), operation);
  }
  #assertScope(operation: Operation, input: Call & { readonly site: string }): void {
    if (
      operation.starter.workspaceId !== input.workspaceId ||
      operation.site !== input.site ||
      operation.starter.ownerId !== input.ownerId
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "Sign-in call identity belongs to another Workspace or site.",
      });
    }
  }
  #announce(result: { readonly events: readonly AgentEvent[] }): void {
    for (const event of result.events) this.#onWorkspaceEvent(event);
    this.#onRequestResolved();
  }
}

export interface PasswordSignInServiceOptions {
  readonly authority: Pick<
    ComputerAppHub,
    "onPasswordSignIn" | "passwordSignInSupported" | "sendPasswordSignIn"
  >;
  readonly resolveAuthority: (ownerId: UserId) => Promise<PasswordSignInComputer | null>;
  readonly agentWaitMs?: number;
  readonly declineAnswerMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly describe: (input: {
    readonly ownerId: UserId;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }) => Promise<{
    readonly deploymentId: string;
    readonly deploymentName: string;
    readonly threadTitle: string;
    readonly workspaceName: string;
  }>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly onRequestResolved: () => void;
  readonly onWorkspaceEvent: (event: AgentEvent) => void;
  readonly requests: PasswordSignInRequests;
}

function siteKey(workspaceId: WorkspaceId, site: string): string {
  return `${workspaceId}\0${site}`;
}
function callKey(call: Pick<Call, "runId" | "callId">): string {
  return `${call.runId}\0${call.callId}`;
}
function authority(call: Call) {
  return {
    originatingRunId: call.runId,
    originatingThreadId: call.threadId,
    originatingWorkspaceId: call.workspaceId,
    requestedBy: call.ownerId,
    targetWorkspaceId: call.workspaceId,
  };
}
function requestInput(
  operation: Operation,
  call: Call,
): Parameters<RequestStore["openPasswordSignIn"]>[0] {
  const computer = operation.target;
  if (!computer) throw new Error("Password sign-in has no computer");
  return {
    ...authority(call),
    callId: call.callId,
    kind: "browser.password-sign-in",
    mode: "durable",
    requiredActor: "requester",
    payload: {
      kind: "browser.password-sign-in",
      computerName: computer.name,
      expiresAt: new Date(operation.expiresAt).toISOString(),
      operationId: operation.id,
      reason: operation.starter.reason,
      runnerId: computer.runnerId,
      scope: "workspace",
      permissionVersion: 5,
      site: operation.site,
    },
    presentation: {
      kind: "external",
      detail: operation.starter.reason,
      subject: { kind: "browser-site", id: operation.site },
      title: `Sign in to ${browserSiteDomain(operation.site)}?`,
    },
  };
}
function unavailable(
  site: string,
  reason: Extract<AgentBrowserSignInResult, { status: "unavailable" }>["reason"],
): AgentBrowserSignInResult {
  return { site, reason, status: "unavailable" };
}
function interrupted(): Settlement {
  return { status: "fulfilled", response: { outcome: "interrupted" } };
}
function directResult(site: string, settlement: Settlement): AgentBrowserSignInResult {
  if (settlement.status === "declined") return unavailable(site, "interrupted");
  const response = settlement.response;
  switch (response.outcome) {
    case "authorized":
      return unavailable(site, "expired");
    case "signed-in":
      return unavailable(site, "expired");
    case "failed":
      return unavailable(site, "interrupted");
    case "unavailable":
      return unavailable(
        site,
        response.reason === "no-saved-login"
          ? "no-saved-login"
          : response.reason === "passwords-off"
            ? "passwords-off"
            : response.reason === "not-set-up"
              ? "passwords-not-set-up"
              : "passwords-not-responding",
      );
    case "expired":
      return unavailable(site, "expired");
    case "interrupted":
    case "outcome-unknown":
      return unavailable(site, "interrupted");
    case "session-closed":
      return unavailable(site, "session-closed");
  }
}
function settlementFor(outcome: LoginAuthorizationOutcome): Settlement {
  switch (outcome.kind) {
    case "authorized":
      return { status: "fulfilled", response: { outcome: "authorized", account: outcome.account } };
    case "declined":
      return { status: "declined" };
    case "cancelled":
      return outcome.reason === "declined"
        ? { status: "declined" }
        : {
            status: "fulfilled",
            response: { outcome: outcome.reason === "expired" ? "expired" : "interrupted" },
          };
    case "expired":
      return { status: "fulfilled", response: { outcome: "expired" } };
    case "unavailable":
      return { status: "fulfilled", response: { outcome: "unavailable", reason: outcome.reason } };
    case "busy":
      return { status: "fulfilled", response: { outcome: "interrupted" } };
  }
}
