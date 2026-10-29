import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoginAuthorizationOutcome } from "@opensteer/protocol";
import { HostSignIns, type HostLoginAuthorizeInput } from "./host-sign-ins.js";
import type { BrowserLoginAuthority } from "./sign-in.js";

/* Failure cases: duplicate authorization, pending overflow, live leases counted as
 * pending, missing authority, lost/expired/cross-session lease, late authorization
 * after cancel, authority loss, hung probe, leaked fill exception, and abandoned
 * broker transactions on session/host close. Cookie handoff no longer exists. */
const site = "https://example.com";
function input(overrides: Partial<HostLoginAuthorizeInput> = {}): HostLoginAuthorizeInput {
  return {
    expiresAt: new Date(Date.now() + 60_000),
    operationId: crypto.randomUUID(),
    requester: {
      deploymentId: "deployment",
      deploymentName: "Personal",
      reason: "Read dashboard",
      threadTitle: "Dashboard",
      workspaceName: "Main",
    },
    sessionId: "bsn_session",
    site,
    workspaceId:
      "wsp_00000000-0000-4000-8000-000000000001" as HostLoginAuthorizeInput["workspaceId"],
    ...overrides,
  };
}
function fixture() {
  const authorization =
    Promise.withResolvers<Awaited<ReturnType<BrowserLoginAuthority["authorize"]>>>();
  const broker = new AbortController();
  const authority: BrowserLoginAuthority = {
    probe: vi.fn(async () => "has-login" as const),
    authorize: vi.fn(() => authorization.promise),
    fill: vi.fn(async () => "filled" as const),
    end: vi.fn(async () => undefined),
  };
  const registry = new HostSignIns({ authority, runtimeId: "runtime" });
  const outcomes: LoginAuthorizationOutcome[] = [];
  const report = async (outcome: LoginAuthorizationOutcome) => {
    outcomes.push(outcome);
  };
  const ended = vi.fn(async () => undefined);
  const start = input();
  const authorize = () => registry.authorize(start, report, async () => undefined, ended);
  const approve = async () => {
    authorization.resolve({
      kind: "authorized",
      account: "t•••@example.com",
      authority: broker.signal,
    });
    await vi.waitFor(() => expect(outcomes[0]?.kind).toBe("authorized"));
    const result = outcomes[0];
    if (result?.kind !== "authorized") throw new Error("Expected authorization");
    return result.loginRef;
  };
  return {
    registry,
    authority,
    authorization,
    broker,
    outcomes,
    report,
    ended,
    start,
    authorize,
    approve,
  };
}
afterEach(() => vi.useRealTimers());
describe("HostSignIns login leases", () => {
  it("authorizes once, retains a reusable session-bound lease, and ends it on close", async () => {
    const f = fixture();
    f.authorize();
    f.authorize();
    const loginRef = await f.approve();
    expect(loginRef).toMatch(/^lgn_[0-9a-f]{32}$/u);
    for (const field of ["username", "password", "code"] as const) {
      expect(
        await f.registry.fill({ loginRef, field, sessionId: f.start.sessionId, targetId: "page" }),
      ).toBe("filled");
    }
    expect(f.authority.authorize).toHaveBeenCalledTimes(1);
    expect(f.authority.fill).toHaveBeenCalledTimes(3);
    expect(
      await f.registry.fill({ loginRef, field: "password", sessionId: "other", targetId: "page" }),
    ).toBe("expired");
    f.registry.close();
    expect(
      await f.registry.fill({
        loginRef,
        field: "password",
        sessionId: f.start.sessionId,
        targetId: "page",
      }),
    ).toBe("expired");
    expect(f.authority.end).toHaveBeenCalledWith(f.start.operationId);
    await vi.waitFor(() => expect(f.ended).toHaveBeenCalledTimes(1));
    f.authorize();
    expect(f.authority.authorize).toHaveBeenCalledTimes(1);
  });
  it("caps pending authorizations at four but permits more live leases", async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.registry.authorize(input(), f.report);
    f.registry.authorize(input(), f.report);
    await vi.waitFor(() => expect(f.outcomes).toEqual([{ kind: "busy" }]));
    f.authorization.resolve({ kind: "authorized", account: "masked", authority: f.broker.signal });
    await vi.waitFor(() => expect(f.outcomes).toHaveLength(5));
    f.registry.authorize(input(), f.report);
    expect(f.authority.authorize).toHaveBeenCalledTimes(5);
    f.registry.close();
  });
  it.each(["declined", "withdrawn", "expired", "authority-lost"] as const)(
    "ignores a late approval after %s",
    async (reason) => {
      const f = fixture();
      f.authorize();
      f.registry.cancel(f.start.operationId, reason);
      f.authorization.resolve({
        kind: "authorized",
        account: "masked",
        authority: f.broker.signal,
      });
      await vi.waitFor(() => expect(f.outcomes).toHaveLength(1));
      expect(f.outcomes).toEqual([
        reason === "expired" ? { kind: "expired" } : { kind: "cancelled", reason },
      ]);
      expect(f.authority.end).toHaveBeenCalledWith(f.start.operationId);
      f.registry.close();
    },
  );
  it("expires a live lease even when the timer has not fired", async () => {
    const f = fixture();
    f.authorize();
    const loginRef = await f.approve();
    vi.spyOn(Date, "now").mockReturnValue(f.start.expiresAt.getTime() + 1);
    try {
      expect(
        await f.registry.fill({
          loginRef,
          field: "password",
          sessionId: f.start.sessionId,
          targetId: "page",
        }),
      ).toBe("expired");
      expect(f.authority.fill).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      f.registry.close();
    }
  });
  it("ends pending and live operations on session detach, authority loss, and deadline", async () => {
    const f = fixture();
    f.authorize();
    const loginRef = await f.approve();
    f.broker.abort("denied");
    expect(
      await f.registry.fill({
        loginRef,
        field: "password",
        sessionId: f.start.sessionId,
        targetId: "page",
      }),
    ).toBe("expired");
    await vi.waitFor(() => expect(f.ended).toHaveBeenCalledTimes(1));
    const pending = fixture();
    pending.authorize();
    pending.registry.sessionDetached(pending.start.sessionId);
    await vi.waitFor(() =>
      expect(pending.outcomes).toEqual([{ kind: "cancelled", reason: "authority-lost" }]),
    );
    pending.registry.close();
    f.registry.close();
    vi.useFakeTimers();
    const expired = fixture();
    expired.authorize();
    expired.authorization.resolve({
      kind: "authorized",
      account: "masked",
      authority: expired.broker.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(expired.outcomes[0]?.kind).toBe("authorized");
    await vi.advanceTimersByTimeAsync(60_001);
    expect(expired.ended).toHaveBeenCalledTimes(1);
    expect(expired.authority.end).toHaveBeenCalledTimes(1);
    expired.registry.close();
  });
  it("rejects authority already lost and never exposes a fill exception", async () => {
    const f = fixture();
    f.broker.abort();
    f.authorize();
    f.authorization.resolve({ kind: "authorized", account: "masked", authority: f.broker.signal });
    await vi.waitFor(() =>
      expect(f.outcomes).toEqual([{ kind: "cancelled", reason: "authority-lost" }]),
    );
    f.registry.close();
    const live = fixture();
    live.authorize();
    const loginRef = await live.approve();
    vi.mocked(live.authority.fill).mockRejectedValue(new Error("secret page exception"));
    expect(
      await live.registry.fill({
        loginRef,
        field: "password",
        sessionId: live.start.sessionId,
        targetId: "page",
      }),
    ).toBe("unavailable");
    live.registry.close();
  });
  it("aborts an in-flight fill synchronously on cancellation", async () => {
    const f = fixture();
    f.authorize();
    const loginRef = await f.approve();
    // Desktop cancellation can synchronously abort its authority signal too.
    const authorizationCall = vi.mocked(f.authority.authorize).mock.calls[0];
    authorizationCall?.[1].addEventListener("abort", () => f.broker.abort(), { once: true });
    const release = Promise.withResolvers<"expired">();
    vi.mocked(f.authority.fill).mockImplementation(({ lease }) => {
      lease.addEventListener("abort", () => release.resolve("expired"), { once: true });
      return release.promise;
    });
    const fill = f.registry.fill({
      loginRef,
      field: "password",
      sessionId: f.start.sessionId,
      targetId: "page",
    });
    f.registry.cancel(f.start.operationId, "withdrawn");
    expect(await fill).toBe("expired");
    await vi.waitFor(() => expect(f.ended).toHaveBeenCalledTimes(1));
    expect(f.authority.end).toHaveBeenCalledTimes(1);
    f.registry.close();
  });
  it("answers unavailable without authority and bounds a hung probe", async () => {
    const registry = new HostSignIns({ runtimeId: "runtime", authority: undefined });
    const result = vi.fn(async () => undefined);
    registry.authorize(input(), result);
    await vi.waitFor(() =>
      expect(result).toHaveBeenCalledWith({ kind: "unavailable", reason: "passwords-off" }),
    );
    expect(await registry.probe({ site })).toBe("unavailable");
    registry.close();
    vi.useFakeTimers();
    const f = fixture();
    vi.mocked(f.authority.probe).mockImplementation(() => new Promise(() => undefined));
    const probe = f.registry.probe({ site });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await probe).toBe("unavailable");
    f.registry.close();
  });
});
