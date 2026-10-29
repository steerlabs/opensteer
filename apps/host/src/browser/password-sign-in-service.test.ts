import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
  type PasswordSignInAuthorityEvent,
} from "@opensteer/protocol";
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
  for (const canRequest of [true, false]) {
    it(`refuses another Run's late approval (canRequest=${canRequest})`, async () => {
      vi.useFakeTimers();
      const h = harness();
      const starter = h.start();
      await vi.advanceTimersByTimeAsync(1);
      const other = { ...h.call, ...otherRun(), canRequest, callId: "other" };
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
      h.event({
        kind: "result",
        outcome: {
          kind: "authorized",
          account: "t•••@example.test",
          loginRef: h.loginRef(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(h.resolved).toHaveBeenCalledTimes(1);
    });
  }

  it("replays a delegated refusal after reconciliation without starting the Mac again", async () => {
    vi.useFakeTimers();
    const h = harness();
    const refused = { status: "unavailable", reason: "needs-approval", site: h.site };
    const first = h.start(false);
    await vi.advanceTimersByTimeAsync(1);
    h.event({ kind: "needs", need: "approval" });
    expect(await first).toEqual(refused);

    // A delayed replay can arrive after the production reconciliation timer.
    await vi.advanceTimersByTimeAsync(10_000);
    const replay = h.start(false);
    await vi.advanceTimersByTimeAsync(1);
    h.event({ kind: "needs", need: "approval" });
    expect(await replay).toEqual(refused);
    const commands = h.hub.sendPasswordSignIn.mock.calls.map(([, command]) => command);
    expect(commands.filter((command) => command.type === "login.authorize")).toHaveLength(1);
    expect(commands.filter((command) => command.type === "login.cancel")).toHaveLength(1);
    expect(h.requests.openPasswordSignIn).not.toHaveBeenCalled();
  });

  it("allows a fresh call for the same site after a delegated cancellation", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = h.start(false);
    await vi.advanceTimersByTimeAsync(1);
    h.event({ kind: "needs", need: "approval" });
    expect(await first).toMatchObject({ reason: "needs-approval" });

    const fresh = h.service.request({
      ...h.call,
      callId: "fresh",
      site: h.site,
      admitStart: () => true,
    });
    await vi.advanceTimersByTimeAsync(1);
    h.event({ kind: "needs", need: "approval" });
    expect(await fresh).toMatchObject({ status: "pending" });
    expect(
      h.hub.sendPasswordSignIn.mock.calls.filter(
        ([, command]) => command.type === "login.authorize",
      ),
    ).toHaveLength(2);
    expect(h.requests.openPasswordSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "fresh" }),
    );
    expect(
      h.requests.openPasswordSignIn.mock.calls.every(([input]) => input.callId === "fresh"),
    ).toBe(true);
    expect(h.service.leaseForOperation(h.operationId())).toBeNull();
  });

  it("requires new approval when a refused call is replayed after its original deadline", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = h.start(false);
    await vi.advanceTimersByTimeAsync(1);
    const start = h.hub.sendPasswordSignIn.mock.calls
      .map(([, command]) => command)
      .find((command) => command.type === "login.authorize");
    if (start?.type !== "login.authorize") throw new Error("Missing authorization start");
    h.event({ kind: "needs", need: "approval" });
    expect(await first).toMatchObject({ reason: "needs-approval" });

    vi.setSystemTime(Date.parse(start.expiresAt));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.service.join({ ...h.call, canRequest: false, site: h.site })).toBeNull();
    const replay = h.start(false);
    let answered = false;
    void replay.then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toBe(false);
    expect(h.service.leaseForOperation(h.operationId())).toBeNull();
    h.event({ kind: "needs", need: "approval" });
    expect(await replay).toMatchObject({ status: "unavailable", reason: "needs-approval" });
    expect(
      h.hub.sendPasswordSignIn.mock.calls.filter(
        ([, command]) => command.type === "login.authorize",
      ),
    ).toHaveLength(2);
    expect(h.requests.openPasswordSignIn).not.toHaveBeenCalled();
  });

  it("does not let old-operation cleanup erase a call rebound to a newer lease", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = h.start(false);
    await vi.advanceTimersByTimeAsync(1);
    const oldStart = h.hub.sendPasswordSignIn.mock.calls
      .map(([, command]) => command)
      .find((command) => command.type === "login.authorize");
    if (oldStart?.type !== "login.authorize") throw new Error("Missing authorization start");
    h.event({ kind: "needs", need: "approval" });
    await first;

    // Move domain time without running reconciliation: the new lease outlives the old record.
    vi.setSystemTime(Date.now() + 60_000);
    const fresh = h.service.request({
      ...h.call,
      callId: "fresh",
      site: h.site,
      admitStart: () => true,
    });
    await vi.advanceTimersByTimeAsync(1);
    const freshStart = h.hub.sendPasswordSignIn.mock.calls
      .map(([, command]) => command)
      .findLast((command) => command.type === "login.authorize");
    if (freshStart?.type !== "login.authorize") throw new Error("Missing fresh authorization");
    h.event({
      kind: "result",
      outcome: {
        kind: "authorized",
        account: "masked",
        loginRef: h.loginRef(),
        expiresAt: freshStart.expiresAt,
      },
    });
    expect(await fresh).toMatchObject({ status: "ready" });
    expect(await h.service.join({ ...h.call, site: h.site })).toMatchObject({ status: "ready" });

    vi.setSystemTime(Date.parse(oldStart.expiresAt));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(() => h.service.join({ ...h.call, site: "https://different.test" })).toThrow(
      /another Workspace or site/,
    );
  });

  it("expires a terminal no-Request identity even when no cancellation was sent", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = h.start();
    await vi.advanceTimersByTimeAsync(1);
    const start = h.hub.sendPasswordSignIn.mock.calls
      .map(([, command]) => command)
      .find((command) => command.type === "login.authorize");
    if (start?.type !== "login.authorize") throw new Error("Missing authorization start");
    h.event({ kind: "result", outcome: { kind: "busy" } });
    expect(await first).toMatchObject({ status: "unavailable", reason: "busy" });

    vi.setSystemTime(Date.parse(start.expiresAt));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.service.join({ ...h.call, site: h.site })).toBeNull();
  });

  it("withdraws a delegated starter when approval is needed", async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = h.start(false);
    await vi.advanceTimersByTimeAsync(1);
    h.event({ kind: "needs", need: "approval" });
    expect(await first).toEqual({ status: "unavailable", reason: "needs-approval", site: h.site });
    expect(h.hub.sendPasswordSignIn).toHaveBeenCalledWith(h.target.computer.runnerId, {
      type: "login.cancel",
      operationId: h.operationId(),
      reason: "withdrawn",
    });
    expect(h.requests.openPasswordSignIn).not.toHaveBeenCalled();
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
    canRequest: true,
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
    sendPasswordSignIn: vi.fn<PasswordSignInServiceOptions["authority"]["sendPasswordSignIn"]>(
      async (_runnerId, command) => {
        if (command.type === "signin.probe")
          return { type: "signin.probe.result", passwords: "has-login" };
        if (command.type === "login.authorize") {
          operationId = command.operationId;
          loginRef = command.loginRef;
          return { type: "login.authorize.started" };
        }
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
  const requests = {
    get: vi.fn(async () => request),
    hasPasswordSignInAuthority: vi.fn(async () => true),
    listPendingPasswordSignIns: vi.fn(async () => []),
    openPasswordSignIn: vi.fn<PasswordSignInServiceOptions["requests"]["openPasswordSignIn"]>(
      async (input) => {
        request ??= {
          ...input,
          id: "req_00000000-0000-4000-8000-000000000001",
          status: "pending",
        } as unknown as Request;
        return { request, events: [], replayed: false };
      },
    ),
    settlePasswordSignInRequest: vi.fn<
      PasswordSignInServiceOptions["requests"]["settlePasswordSignInRequest"]
    >(async (input) => {
      if (!request || request.status !== "pending") return null;
      request = { ...request, ...input.settlement } as unknown as Request;
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
    operationId: () => operationId,
    loginRef: () => loginRef,
    start: (canRequest = true) =>
      service.request({ ...call, canRequest, site, admitStart: () => true }),
    event: (
      event:
        | { kind: "needs"; need: "approval" | null }
        | {
            kind: "result";
            outcome: LoginAuthorizationOutcome;
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
