import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createId,
  RunnerIdSchema,
  RunIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
  type Request,
} from "@opensteer/core";
import {
  BrowserSessionIdSchema,
  type LoginAuthorizationOutcome,
  type CardAuthorizationOutcome,
  type PasswordSignInAuthorityEvent,
} from "@opensteer/protocol";
import { ContinuationService } from "../agents/continuation-service.js";
import type { BrowserSignInTarget } from "./browser-service.js";
import {
  PasswordSignInService,
  type PasswordSignInServiceOptions,
} from "./password-sign-in-service.js";

const services: PasswordSignInService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  vi.useRealTimers();
});

describe("Passwords wait authority", () => {
  {
    it("refuses another Run's late approval", async () => {
      vi.useFakeTimers();
      const h = harness();
      const starter = h.start();
      await vi.advanceTimersByTimeAsync(1);
      const other = { ...h.call, ...otherRun(), callId: "other" };
      const joined = h.service.join({ ...other, site: h.site });
      h.event({ kind: "needs", need: "approval" });
      expect(await joined).toEqual({ status: "unavailable", reason: "busy", site: h.site });
      expect((await starter).status).toBe("pending");
      expect(
        h.hub.sendPasswordSignIn.mock.calls.some(([, command]) => command.type === "login.cancel"),
      ).toBe(false);
      expect(
        h.requests.openPasswordSignIn.mock.calls.every(
          ([input]) =>
            input.originatingRunId === h.call.runId &&
            input.originatingThreadId === h.call.threadId,
        ),
      ).toBe(true);
      await h.service.respond({
        ownerId: h.call.ownerId,
        requestId: h.request().id,
        sessionId: "test-session",
        revalidate: async () => {},
        decision: {
          kind: "approve",
          loginId: "00000000-0000-4000-8000-000000000001",
          revision: 1,
          remember: false,
          permissionVersion: 5,
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(h.resolved).toHaveBeenCalledTimes(1);
    });
  }

  it("expires a terminal no-Request identity even when no cancellation was sent", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = h.start();
    await vi.advanceTimersByTimeAsync(1);
    const start = h.hub.sendPasswordSignIn.mock.calls
      .map(([, command]) => command)
      .find((command) => command.type === "login.authorize" && "loginRef" in command);
    if (start?.type !== "login.authorize") throw new Error("Missing authorization start");
    h.event({ kind: "result", outcome: { kind: "busy" } });
    expect(await first).toMatchObject({ status: "unavailable", reason: "busy" });

    vi.setSystemTime(Date.parse(start.expiresAt));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.service.join({ ...h.call, site: h.site })).toBeNull();
  });
});

function otherRun() {
  return {
    runId: RunIdSchema.parse("run_00000000-0000-4000-8000-000000000002"),
    threadId: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000002"),
  };
}

function harness() {
  const call = {
    callId: "first",
    ownerId: UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001"),
    reason: "Read the page",
    runId: RunIdSchema.parse("run_00000000-0000-4000-8000-000000000001"),
    threadId: ThreadIdSchema.parse("thr_00000000-0000-4000-8000-000000000001"),
    workspaceId: WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000001"),
  };
  const target = {
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001"),
    workspaceId: call.workspaceId,
    computer: {
      name: "Test Mac",
      runnerId: RunnerIdSchema.parse("rnr_00000000-0000-4000-8000-000000000001"),
    },
    signIn: true,
    stateImport: true,
    profileName: null,
    profileId: null,
    live: true,
  } satisfies BrowserSignInTarget;
  const site = "https://example.test";
  let emit: (
    runnerId: typeof target.computer.runnerId,
    event: PasswordSignInAuthorityEvent,
  ) => void = () => {
    throw new Error("No listener");
  };
  let operationId = "";
  let loginRef = "";
  const resolved = vi.fn();
  const hub = {
    onPasswordSignIn: (listener: typeof emit) => {
      emit = listener;
      return () => undefined;
    },
    passwordSignInSupported: vi.fn(() => true),
    cardUseSupported: vi.fn(() => true),
    sendPasswordSignIn: vi.fn<PasswordSignInServiceOptions["authority"]["sendPasswordSignIn"]>(
      async (_runnerId, command) => {
        if (command.type === "signin.probe")
          return { type: "signin.probe.result", passwords: "has-login" };
        if (command.type === "card.probe") return { type: "card.probe.result", cards: "has-card" };
        if (command.type === "login.authorize" && "cardRef" in command) {
          operationId = command.operationId;
          loginRef = command.cardRef;
          return { type: "login.authorize.started" };
        }
        if (command.type === "login.authorize" && "loginRef" in command) {
          operationId = command.operationId;
          loginRef = command.loginRef;
          return { type: "login.authorize.started" };
        }
        if (command.type === "login.approve" && "credential" in command) {
          emit(target.computer.runnerId, {
            type: "login.result",
            operationId,
            outcome: {
              kind: "authorized",
              cardRef: loginRef,
              brand: "Visa",
              lastFour: "4242",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          });
          return { type: "login.approve.result", result: { ok: true } };
        }
        if (command.type === "login.approve") {
          emit(target.computer.runnerId, {
            type: "login.result",
            operationId,
            outcome: {
              kind: "authorized",
              account: "a•••",
              loginRef,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          });
          return { type: "login.approve.result", result: { ok: true } };
        }
        if (command.type === "login.commit") return { type: "login.committed", committed: true };
        if (command.type === "login.cancel") {
          emit(target.computer.runnerId, {
            type: "login.result",
            operationId,
            outcome: { kind: "cancelled", reason: command.reason },
          });
          return { type: "login.cancelled" };
        }
        return { type: "login.seal.result", status: "denied" };
      },
    ),
  } satisfies PasswordSignInServiceOptions["authority"];
  let request: Request | null = null;
  let runActive = true;
  let workspaceActive = true;
  const requests = {
    get: vi.fn(async () => request),
    hasActiveRunPasswordSignInAuthority: vi.fn(async () => runActive),
    hasDurablePasswordSignInRequestAuthority: vi.fn(
      async ({ ownerId, requestId }) =>
        workspaceActive &&
        request !== null &&
        request.id === requestId &&
        request.requestedBy === ownerId,
    ),
    listPendingPasswordSignIns: vi.fn(async () => []),
    openPasswordSignIn: vi.fn<PasswordSignInServiceOptions["requests"]["openPasswordSignIn"]>(
      async (input) => {
        if (!request || request.status !== "pending")
          request = {
            ...input,
            id: createId("request"),
            status: "pending",
          } as unknown as Request;
        return { request, events: [], replayed: false };
      },
    ),
    settlePasswordSignInRequest: vi.fn<
      PasswordSignInServiceOptions["requests"]["settlePasswordSignInRequest"]
    >(async (input) => {
      if (!request) return null;
      const correction =
        request.status === "fulfilled" &&
        request.response.kind === "external" &&
        request.response.value?.outcome === "authorized" &&
        input.settlement.status === "fulfilled" &&
        input.settlement.response.outcome === "interrupted";
      if (request.status !== "pending" && !correction) return null;
      request = {
        ...request,
        status: input.settlement.status,
        response: {
          kind: "external",
          value:
            input.settlement.status === "declined"
              ? { decision: "declined" }
              : input.settlement.response,
        },
        settlementProvenance: correction
          ? request.settlementProvenance
          : input.settlementSessionId
            ? { sessionId: input.settlementSessionId, deviceLabel: "Test phone" }
            : null,
      } as unknown as Request;
      return { request, events: [], replayed: false };
    }),
  } satisfies PasswordSignInServiceOptions["requests"];
  const service = new PasswordSignInService({
    authority: hub,
    resolveAuthority: async () => target.computer,
    requests,
    agentWaitMs: 1_000,
    declineAnswerMs: 50,
    reconcileIntervalMs: 10_000,
    describe: async () => ({
      deploymentId: "deployment",
      deploymentName: "Test",
      threadTitle: "Test",
      workspaceName: "Test",
    }),
    onRequestResolved: resolved,
    onWorkspaceEvent: () => undefined,
  });
  services.push(service);
  return {
    call,
    target,
    site,
    service,
    hub,
    requests,
    resolved,
    request: () => request!,
    revokeWorkspace: () => {
      workspaceActive = false;
    },
    completeRun: () => {
      runActive = false;
    },
    end: () => emit(target.computer.runnerId, { type: "login.ended", operationId }),
    operationId: () => operationId,
    loginRef: () => loginRef,
    start: () => service.request({ ...call, site, admitStart: () => true }),
    event: (
      event:
        | { kind: "needs"; need: "approval" | null }
        | {
            kind: "result";
            outcome: LoginAuthorizationOutcome | CardAuthorizationOutcome;
          },
    ) =>
      emit(target.computer.runnerId, {
        ...event,
        type: event.kind === "needs" ? "login.needs" : "login.result",
        operationId,
      } as PasswordSignInAuthorityEvent),
  };
}

describe("Workspace login leases", () => {
  it("reserves a ref without a browser and reuses it only in its Workspace", async () => {
    vi.useFakeTimers();
    const h = harness();
    const started = h.start();
    await vi.advanceTimersByTimeAsync(1);
    h.event({
      kind: "result",
      outcome: {
        kind: "authorized",
        account: "t•••@example.test",
        loginRef: h.loginRef(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(await started).toMatchObject({ status: "ready", loginRef: h.loginRef() });
    expect(await h.service.join({ ...h.call, callId: "reuse", site: h.site })).toMatchObject({
      status: "ready",
      loginRef: h.loginRef(),
    });
    expect(
      h.service.validateLease({ loginRef: h.loginRef(), workspaceId: h.call.workspaceId }),
    ).toBe(true);
    expect(
      h.service.validateLease({
        loginRef: h.loginRef(),
        workspaceId: WorkspaceIdSchema.parse("wsp_00000000-0000-4000-8000-000000000002"),
      }),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      h.service.validateLease({ loginRef: h.loginRef(), workspaceId: h.call.workspaceId }),
    ).toBe(false);
  });
  it("never republishes an automatic lease after its authority ends", async () => {
    vi.useFakeTimers();
    const h = harness();
    const started = h.start();
    await vi.advanceTimersByTimeAsync(1);
    h.event({
      kind: "result",
      outcome: {
        kind: "authorized",
        account: "masked",
        loginRef: h.loginRef(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(await started).toMatchObject({ status: "ready" });
    expect(h.service.leaseForOperation(h.operationId())).not.toBeNull();
    h.end();
    expect(h.service.leaseForOperation(h.operationId())).toBeNull();
    expect(
      h.service.validateLease({ loginRef: h.loginRef(), workspaceId: h.call.workspaceId }),
    ).toBe(false);
  });
  it("never accepts an authority substituting another reference", async () => {
    vi.useFakeTimers();
    const h = harness();
    const started = h.start();
    await vi.advanceTimersByTimeAsync(1);
    h.event({
      kind: "result",
      outcome: {
        kind: "authorized",
        account: "masked",
        loginRef: "lgn_" + "f".repeat(32),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(await started).toMatchObject({ status: "unavailable" });
    expect(h.service.leaseForOperation(h.operationId())).toBeNull();
  });
  it("opens a Workspace-scoped v5 Request on approval", async () => {
    vi.useFakeTimers();
    const h = harness();
    const started = h.start();
    await vi.advanceTimersByTimeAsync(1);
    h.event({ kind: "needs", need: "approval" });
    await started;
    expect(h.requests.openPasswordSignIn.mock.calls[0]?.[0].payload).toMatchObject({
      scope: "workspace",
      permissionVersion: 5,
    });
    expect(h.requests.openPasswordSignIn.mock.calls[0]?.[0].payload).not.toHaveProperty(
      "sessionId",
    );
  });
});

describe("human Passwords settlement", () => {
  async function pending() {
    vi.useFakeTimers();
    const h = harness();
    const call = h.start();
    await vi.advanceTimersByTimeAsync(1);
    h.event({ kind: "needs", need: "approval" });
    await call;
    return h;
  }
  const decision = {
    kind: "approve",
    loginId: "00000000-0000-4000-8000-000000000001",
    revision: 3,
    remember: true,
    permissionVersion: 5,
  } as const;
  function answer(h: Awaited<ReturnType<typeof pending>>, revalidate = async () => {}) {
    return h.service.respond({
      ownerId: h.call.ownerId,
      requestId: h.request().id,
      sessionId: "test-session",
      decision,
      revalidate,
    });
  }
  function replies(h: Awaited<ReturnType<typeof pending>>) {
    const original = h.hub.sendPasswordSignIn.getMockImplementation()!;
    h.hub.sendPasswordSignIn.mockImplementation(async (runner, command) => {
      if (command.type === "login.approve") {
        h.event({
          kind: "result",
          outcome: {
            kind: "authorized",
            account: "a•••",
            loginRef: h.loginRef(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        return { type: "login.approve.result", result: { ok: true } };
      }
      if (command.type === "login.commit") return { type: "login.committed", committed: true };
      return original(runner, command);
    });
  }
  it("reads and approves the stored durable Request after its asking Run ends", async () => {
    const h = await pending();
    const liveChecks = h.requests.hasActiveRunPasswordSignInAuthority.mock.calls.length;
    h.completeRun();
    await expect(
      h.service.get({ ownerId: h.call.ownerId, requestId: h.request().id }),
    ).resolves.toEqual({ stage: "gone" });
    await expect(answer(h)).resolves.toMatchObject({ status: "fulfilled" });
    expect(h.requests.hasDurablePasswordSignInRequestAuthority).toHaveBeenCalledWith({
      ownerId: h.call.ownerId,
      requestId: h.request().id,
    });
    expect(h.service.leaseForOperation(h.operationId())?.loginRef).toBe(h.loginRef());
    expect(h.requests.hasActiveRunPasswordSignInAuthority).toHaveBeenCalledTimes(liveChecks);
  });
  it("refuses chooser reads and approval after the completed Run loses Workspace authority", async () => {
    const h = await pending();
    h.completeRun();
    await expect(
      h.service.get({ ownerId: h.call.ownerId, requestId: h.request().id }),
    ).resolves.toEqual({ stage: "gone" });
    const commandsBeforeRevocation = h.hub.sendPasswordSignIn.mock.calls.length;
    h.revokeWorkspace();
    await expect(
      h.service.get({ ownerId: h.call.ownerId, requestId: h.request().id }),
    ).rejects.toThrow("This sign-in no longer has Workspace authority.");
    await expect(answer(h)).rejects.toThrow("This sign-in no longer has Workspace authority.");
    expect(
      h.hub.sendPasswordSignIn.mock.calls
        .slice(commandsBeforeRevocation)
        .some(([, c]) => c.type === "login.get" || c.type === "login.approve"),
    ).toBe(false);
  });
  it.each([true, false])(
    "defers continuation delivery until publication finishes (committed=%s)",
    async (committed) => {
      const h = await pending();
      const commit = Promise.withResolvers<void>();
      const send = h.hub.sendPasswordSignIn.getMockImplementation()!;
      h.hub.sendPasswordSignIn.mockImplementation(async (runner, command) => {
        if (command.type === "login.commit") {
          await commit.promise;
          return { type: "login.committed", committed };
        }
        return send(runner, command);
      });
      const recordContinuationAttempt = vi.fn(async () => true);
      const enqueueThreadInput = vi.fn(async () => ({ disposition: "run-queued" as const }));
      const continuations = new ContinuationService({
        commands: { enqueueThreadInput } as unknown as ConstructorParameters<
          typeof ContinuationService
        >[0]["commands"],
        integrations: {
          listDiscoveryInventory: async () => [],
          listCallableTools: async () => [],
          computerUseMachines: async () => [],
          computerUsePhones: async () => [],
        },
        passwordSignIn: (operationId) => h.service.continuationState(operationId),
        intervalMs: 5_000,
        onError: (error) => {
          throw error;
        },
        requests: {
          listPendingContinuations: vi.fn(async () =>
            h.request().status === "fulfilled"
              ? [
                  {
                    request: h.request(),
                    attemptedAt: null,
                    reason: null,
                    status: "waiting" as const,
                  },
                ]
              : [],
          ),
          recordContinuationAttempt,
        },
      });
      h.resolved.mockImplementation(() => continuations.notify());
      continuations.start();
      const response = answer(h);
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(h.request().status).toBe("fulfilled");
        expect(h.service.leaseForOperation(h.operationId())).toBeNull();
        expect(enqueueThreadInput).not.toHaveBeenCalled();
        expect(recordContinuationAttempt).not.toHaveBeenCalled();
        commit.resolve();
        await response;
        await vi.advanceTimersByTimeAsync(0);
        expect(enqueueThreadInput).toHaveBeenCalledOnce();
        if (committed)
          expect(JSON.stringify(enqueueThreadInput.mock.calls)).toContain(h.loginRef());
        else {
          expect(JSON.stringify(enqueueThreadInput.mock.calls)).not.toContain(h.loginRef());
          expect(h.request()).toMatchObject({ response: { value: { outcome: "interrupted" } } });
        }
        expect(recordContinuationAttempt).toHaveBeenCalledWith({
          requestId: h.request().id,
          reason: null,
          status: "queued",
        });
      } finally {
        commit.resolve();
        await response;
        await continuations.close();
      }
    },
  );
  it("withholds release authority until durable settlement, then commits the broker", async () => {
    const h = await pending();
    replies(h);
    const gate =
      Promise.withResolvers<Awaited<ReturnType<typeof h.requests.settlePasswordSignInRequest>>>();
    const settle = h.requests.settlePasswordSignInRequest.getMockImplementation()!;
    h.requests.settlePasswordSignInRequest.mockImplementationOnce(async (input) => {
      await gate.promise;
      return settle(input);
    });
    const response = answer(h);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.service.leaseForOperation(h.operationId())).toBeNull();
    expect(h.hub.sendPasswordSignIn.mock.calls.some(([, c]) => c.type === "login.commit")).toBe(
      false,
    );
    gate.resolve(null);
    await response;
    expect(h.service.leaseForOperation(h.operationId())).not.toBeNull();
    expect(h.requests.settlePasswordSignInRequest).toHaveBeenCalledWith(
      expect.objectContaining({ settlementSessionId: "test-session" }),
    );
  });
  it.each(["refused", "lost-response", "ended", "expired"] as const)(
    "records an interrupted outcome after broker commit %s, preserving the approval",
    async (failure) => {
      const h = await pending();
      replies(h);
      const original = h.hub.sendPasswordSignIn.getMockImplementation()!;
      h.hub.sendPasswordSignIn.mockImplementation(async (runner, command) => {
        if (command.type !== "login.commit") return original(runner, command);
        if (failure === "lost-response") throw new Error("Lost commit response");
        if (failure === "ended") h.end();
        if (failure === "expired") vi.setSystemTime(Date.now() + 60 * 60_000);
        return { type: "login.committed", committed: failure !== "refused" };
      });
      const requestId = h.request().id;
      await answer(h);
      expect(h.service.leaseForOperation(h.operationId())).toBeNull();
      expect(h.request()).toMatchObject({
        response: { kind: "external", value: { outcome: "interrupted" } },
        settlementProvenance: { sessionId: "test-session", deviceLabel: "Test phone" },
      });
      expect(h.requests.settlePasswordSignInRequest.mock.calls[0]?.[0]).toMatchObject({
        settlement: { status: "fulfilled", response: { outcome: "authorized" } },
        settlementSessionId: "test-session",
      });
      expect(h.hub.sendPasswordSignIn).toHaveBeenCalledWith(
        h.target.computer.runnerId,
        expect.objectContaining({ type: "login.cancel" }),
      );
      const next = h.service.request({
        ...h.call,
        callId: "try-again",
        site: h.site,
        admitStart: () => true,
      });
      await vi.advanceTimersByTimeAsync(1);
      h.event({ kind: "needs", need: "approval" });
      expect(await next).toMatchObject({ status: "pending" });
      expect(h.request().id).not.toBe(requestId);
    },
  );
  for (const failure of ["lost", "failed"] as const)
    it(`never commits a grant when durable settlement ${failure}`, async () => {
      const h = await pending();
      replies(h);
      if (failure === "lost") h.requests.settlePasswordSignInRequest.mockResolvedValueOnce(null);
      else
        h.requests.settlePasswordSignInRequest.mockRejectedValueOnce(
          new Error("database unavailable"),
        );
      await answer(h);
      expect(h.service.leaseForOperation(h.operationId())).toBeNull();
      expect(h.hub.sendPasswordSignIn.mock.calls.some(([, c]) => c.type === "login.commit")).toBe(
        false,
      );
      expect(h.hub.sendPasswordSignIn).toHaveBeenCalledWith(
        h.target.computer.runnerId,
        expect.objectContaining({ type: "login.cancel" }),
      );
    });
  it.each(["interruption-write", "announcement"] as const)(
    "retries interruption after %s fails, preserving provenance",
    async (failure) => {
      const h = await pending();
      replies(h);
      const send = h.hub.sendPasswordSignIn.getMockImplementation()!;
      h.hub.sendPasswordSignIn.mockImplementation(async (runner, command) =>
        command.type === "login.commit"
          ? { type: "login.committed", committed: failure === "announcement" }
          : send(runner, command),
      );
      const settle = h.requests.settlePasswordSignInRequest.getMockImplementation()!;
      if (failure === "interruption-write")
        h.requests.settlePasswordSignInRequest
          .mockImplementationOnce(settle)
          .mockRejectedValueOnce(new Error("Interruption write failed"));
      else
        h.resolved.mockImplementationOnce(() => {
          throw new Error("Announcement failed after broker commit");
        });
      await answer(h);
      expect(h.service.leaseForOperation(h.operationId())).toBeNull();
      expect(h.service.continuationState(h.operationId())).toEqual({ publishing: true });
      expect(h.resolved).toHaveBeenCalledTimes(failure === "announcement" ? 1 : 0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.request()).toMatchObject({
        response: { kind: "external", value: { outcome: "interrupted" } },
        settlementProvenance: { sessionId: "test-session", deviceLabel: "Test phone" },
      });
      expect(h.resolved).toHaveBeenCalledTimes(failure === "announcement" ? 2 : 1);
      expect(h.service.continuationState(h.operationId())).toEqual({
        publishing: false,
        loginRef: undefined,
      });
    },
  );
  it("refuses an older client's login decision on a stored card Request", async () => {
    const h = await pending();
    const request = h.request();
    if (request.payload.kind !== "browser.password-sign-in")
      throw new Error("Expected Passwords Request");
    request.payload.credential = "card";
    await expect(answer(h)).rejects.toThrow("requires card approval");
    expect(request.status).toBe("pending");
    expect(
      h.hub.sendPasswordSignIn.mock.calls.some(([, command]) => command.type === "login.approve"),
    ).toBe(false);
    expect(h.requests.settlePasswordSignInRequest).not.toHaveBeenCalled();
  });
  it("refuses another user's chooser and answer", async () => {
    const h = await pending();
    const ownerId = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000099");
    await expect(h.service.get({ ownerId, requestId: h.request().id })).rejects.toThrow(
      "not found",
    );
    await expect(
      h.service.respond({
        ownerId,
        requestId: h.request().id,
        sessionId: "session",
        decision,
        revalidate: async () => {},
      }),
    ).rejects.toThrow("not found");
  });
  it("revalidates a queued session and sends no approval after revocation", async () => {
    const h = await pending();
    h.completeRun();
    const revalidate = vi.fn().mockRejectedValue(new Error("Session revoked"));
    await expect(answer(h, revalidate)).rejects.toThrow("Session revoked");
    expect(h.hub.sendPasswordSignIn.mock.calls.some(([, c]) => c.type === "login.approve")).toBe(
      false,
    );
  });
  it("admits only one device's pending decision", async () => {
    const h = await pending();
    replies(h);
    const gate = Promise.withResolvers<void>();
    const first = answer(h, () => gate.promise);
    await expect(answer(h)).rejects.toThrow("already being answered");
    gate.resolve();
    await first;
    expect(
      h.hub.sendPasswordSignIn.mock.calls.filter(([, c]) => c.type === "login.approve"),
    ).toHaveLength(1);
  });
  it("records the declining session without inventing an automatic approver", async () => {
    const h = await pending();
    await h.service.respond({
      ownerId: h.call.ownerId,
      requestId: h.request().id,
      sessionId: "declining-session",
      decision: { kind: "decline" },
      revalidate: async () => {},
    });
    expect(h.requests.settlePasswordSignInRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementSessionId: "declining-session",
        settlement: { status: "declined" },
      }),
    );
  });
});

describe("card Workspace lifecycle", () => {
  it("settles a fresh Request before committing and publishing the reusable card lease", async () => {
    vi.useFakeTimers();
    const h = harness();
    const input = {
      ...h.call,
      site: h.site,
      cardRunnerId: h.target.computer.runnerId,
      admitStart: () => true,
    };
    const first = h.service.requestCard(input);
    await vi.advanceTimersByTimeAsync(1);
    h.event({ kind: "needs", need: "approval" });
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toMatchObject({ status: "pending" });
    expect(h.request().payload).toMatchObject({ credential: "card", permissionVersion: 5 });
    expect(h.service.leaseForOperation(h.operationId())).toBeNull();
    h.hub.sendPasswordSignIn.mockImplementationOnce(async () => ({
      type: "login.approve.result",
      result: { ok: true },
    }));
    await expect(
      h.service.respond({
        ownerId: h.call.ownerId,
        requestId: h.request().id,
        sessionId: "phone",
        revalidate: async () => {},
        decision: {
          kind: "approve",
          loginId: "00000000-0000-4000-8000-000000000001",
          revision: 1,
          remember: false,
          permissionVersion: 5,
        },
      }),
    ).rejects.toThrow("requires card approval");
    // The rejected login decision never reached the authority.
    expect(h.hub.sendPasswordSignIn.mock.calls.some(([, c]) => c.type === "login.approve")).toBe(
      false,
    );
    h.hub.sendPasswordSignIn.mockReset();
    h.hub.sendPasswordSignIn.mockImplementation(async (_runner, c) => {
      if (c.type === "login.approve") {
        h.event({
          kind: "result",
          outcome: {
            kind: "authorized",
            cardRef: h.loginRef(),
            brand: "Visa",
            lastFour: "4242",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        return { type: "login.approve.result", result: { ok: true } };
      }
      if (c.type === "login.commit") {
        expect(h.request().status).toBe("fulfilled");
        expect(h.service.leaseForOperation(h.operationId())).toBeNull();
        return { type: "login.committed", committed: true };
      }
      return { type: "login.cancelled" };
    });
    await h.service.respond({
      ownerId: h.call.ownerId,
      requestId: h.request().id,
      sessionId: "phone",
      revalidate: async () => {},
      decision: {
        kind: "approve-card",
        cardId: "00000000-0000-4000-8000-000000000001",
        revision: 1,
        permissionVersion: 7,
      },
    });
    expect(await h.service.requestCard({ ...input, callId: "reuse" })).toMatchObject({
      status: "ready",
      cardRef: h.loginRef(),
      brand: "Visa",
      lastFour: "4242",
    });
    expect(
      h.service.validateLease({ workspaceId: createId("workspace"), loginRef: h.loginRef() }),
    ).toBe(false);
    expect(JSON.stringify(h.request())).not.toContain(h.loginRef());
    h.end();
    expect(h.service.continuationState(h.operationId())).toEqual({
      publishing: false,
      loginRef: undefined,
    });
    expect(
      h.service.validateLease({ workspaceId: h.call.workspaceId, loginRef: h.loginRef() }),
    ).toBe(false);
  });
  it("refuses capability and different-computer mismatches before sending a card command", async () => {
    const h = harness();
    h.hub.cardUseSupported.mockReturnValue(false);
    expect(
      await h.service.requestCard({
        ...h.call,
        site: h.site,
        cardRunnerId: h.target.computer.runnerId,
        admitStart: () => true,
      }),
    ).toMatchObject({ status: "unavailable" });
    expect(h.hub.sendPasswordSignIn).not.toHaveBeenCalled();
    expect(h.requests.openPasswordSignIn).not.toHaveBeenCalled();
  });
});
