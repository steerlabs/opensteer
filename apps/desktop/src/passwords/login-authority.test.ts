import { DeploymentIdSchema } from "@opensteer/core";
import { createECDH, randomUUID } from "node:crypto";
import { webContents } from "electron";
import { createId } from "@opensteer/core";
import { ComputerUseSessionIdSchema, type PasswordSignInAuthorityEvent } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostSignIns } from "../../../../packages/browser-runtime-core/src/browser/host-sign-ins.js";
import { PasswordsLoginAuthority } from "./login-authority.js";
import type { PasswordsBrokerSession } from "./broker-session.js";
import { openLoginEnvelope } from "./login-envelope.js";

vi.mock("electron", () => ({ webContents: { fromDevToolsTargetId: vi.fn() } }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function fixture() {
  const lifetime = new AbortController();
  const broker: PasswordsBrokerSession = {
    protocolVersion: 10,
    commit: vi.fn(async () => ({ committed: true })),
    probe: vi.fn<PasswordsBrokerSession["probe"]>(async () => ({ passwords: "has-login" })),
    request: vi.fn<PasswordsBrokerSession["request"]>(async () => ({
      decision: {
        decision: "authorized",
        login: { id: randomUUID(), account: "a•••", revision: 1, hasTOTP: true },
      },
      lifetime: lifetime.signal,
    })),
    approve: vi.fn(),
    release: vi.fn<PasswordsBrokerSession["release"]>(async () => ({
      released: true,
      value: "WPB-canary-秘密",
    })),
    cancel: vi.fn(async () => undefined),
  };
  const authority = new PasswordsLoginAuthority({
    broker,
    ownOrigins: () => [],
  });
  const events: PasswordSignInAuthorityEvent[] = [];
  const emit = (event: PasswordSignInAuthorityEvent) => {
    events.push(event);
  };
  const operationId = randomUUID();
  const loginRef = `lgn_${"a".repeat(32)}`;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const command = {
    type: "login.authorize",
    deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000003"),
    operationId,
    loginRef,
    site: "https://example.com",
    expiresAt,
    requester: {
      deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000003"),
      deploymentName: "Personal",
      threadTitle: "Login",
      reason: "Sign in",
    },
  } as const;
  const key = createECDH("prime256v1");
  key.generateKeys();
  const receiver = {
    version: 1,
    connectionId: randomUUID(),
    connectionGeneration: 1,
    publicKey: key.getPublicKey().toString("base64url"),
  } as const;
  const binding = {
    version: 1,
    connectionId: receiver.connectionId,
    connectionGeneration: 1,
    runId: createId("run"),
    sessionId: ComputerUseSessionIdSchema.parse(`cus_${randomUUID()}`),
    actId: randomUUID(),
    actionIndex: 0,
    field: "password",
    expiresAt: Date.now() + 30_000,
  } as const;
  const seal = () =>
    authority.control({ type: "login.seal", operationId, receiver, binding }, emit);
  const authorize = async () => {
    expect(await authority.control(command, emit)).toEqual({ type: "login.authorize.started" });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "login.result" && e.outcome.kind === "authorized")).toBe(
        true,
      ),
    );
  };
  cleanups.push(() => authority.end(operationId));
  return {
    authority,
    broker,
    events,
    emit,
    command,
    operationId,
    loginRef,
    authorize,
    seal,
    receiver,
    binding,
    key,
  };
}

describe("desktop-lifetime Passwords authority", () => {
  it("serves the chooser and prepares shared consent without release until Host commit", async () => {
    const f = fixture();
    const account = {
      id: randomUUID(),
      revision: 3,
      username: "person@example.com",
      host: "example.com",
      onPage: true,
      updatedAt: new Date().toISOString(),
      label: null,
    };
    vi.mocked(f.broker.request).mockResolvedValueOnce({
      decision: { decision: "approve", accounts: [account] },
      lifetime: new AbortController().signal,
    });
    vi.mocked(f.broker.approve).mockResolvedValue({
      decision: "authorized",
      login: { id: account.id, revision: 3, account: "p•••", hasTOTP: false },
    });
    await f.authority.control(f.command, f.emit);
    await vi.waitFor(() =>
      expect(f.events).toContainEqual({
        type: "login.needs",
        operationId: f.operationId,
        need: "approval",
      }),
    );
    expect(
      await f.authority.control({ type: "login.get", operationId: f.operationId }, f.emit),
    ).toEqual({
      type: "login.get.result",
      card: { stage: "approval", accounts: [account], permissionVersion: 6 },
    });
    const choice = {
      loginId: account.id,
      revision: 3,
      remember: true,
      permissionVersion: 6,
    } as const;
    expect(
      await f.authority.control(
        { type: "login.approve", operationId: f.operationId, ...choice },
        f.emit,
      ),
    ).toEqual({ type: "login.approve.result", result: { ok: true } });
    expect(f.broker.approve).toHaveBeenCalledWith(
      { transactionId: f.operationId, ...choice },
      expect.any(AbortSignal),
    );
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === "login.result")).toBe(true),
    );
    expect(JSON.stringify(f.events)).not.toContain(account.username);
    expect(await f.seal()).toEqual({ type: "login.seal.result", status: "expired" });
    expect(f.broker.release).not.toHaveBeenCalled();
    expect(
      await f.authority.control({ type: "login.commit", operationId: f.operationId }, f.emit),
    ).toEqual({ type: "login.committed", committed: true });
    expect(await f.seal()).toMatchObject({ type: "login.seal.result", status: "sealed" });
  });

  it("caps sealing at the lease, act deadline and the desktop clock's lifetime cap", async () => {
    const f = fixture();
    await f.authorize();
    const leaseExpiry = Date.parse(f.command.expiresAt);
    for (const [actExpiry, now, expectedExpiry] of [
      [leaseExpiry + 1, leaseExpiry - 30_000, leaseExpiry],
      [leaseExpiry - 10_000, leaseExpiry - 30_000, leaseExpiry - 10_000],
      [leaseExpiry, leaseExpiry - 60_001, leaseExpiry - 1],
    ]) {
      const clock = vi.spyOn(Date, "now").mockReturnValue(now!);
      try {
        const result = await f.authority.control(
          {
            type: "login.seal",
            operationId: f.operationId,
            receiver: f.receiver,
            binding: { ...f.binding, expiresAt: actExpiry! },
          },
          f.emit,
        );
        expect(result).toMatchObject({
          type: "login.seal.result",
          status: "sealed",
          envelope: { binding: { ...f.binding, expiresAt: expectedExpiry } },
        });
      } finally {
        clock.mockRestore();
      }
    }
  });

  it("authorizes without a browser or helper and seals only to the final receiver", async () => {
    const f = fixture();
    await f.authorize();
    expect(f.broker.request).toHaveBeenCalledWith(
      expect.objectContaining({ protocolVersion: 10, permissionVersion: 6 }),
      expect.any(AbortSignal),
    );
    const request = vi.mocked(f.broker.request).mock.calls[0]?.[0];
    expect(request).not.toHaveProperty("sessionId");
    expect(request).not.toHaveProperty("runtimeId");
    const result = await f.seal();
    expect(result.type === "login.seal.result" && result.status).toBe("sealed");
    if (result.type !== "login.seal.result" || result.status !== "sealed")
      throw new Error("Expected ciphertext");
    expect(
      openLoginEnvelope({
        envelope: result.envelope,
        receiver: f.receiver,
        privateKey: Buffer.from(f.key.getPrivateKey().toString("hex").padStart(64, "0"), "hex"),
        expectedBinding: f.binding,
        now: Date.now(),
        consumed: new Map(),
      }),
    ).toBe("WPB-canary-秘密");
    expect(JSON.stringify([f.events, result])).not.toContain("WPB-canary");
  });
  it.each(["detach", "close"] as const)(
    "%s cancels a pending modern browser fill without ending the Workspace reference",
    async (ending) => {
      const f = fixture();
      await f.authorize();
      const writes: string[] = [];
      const frame = {
        origin: "https://example.com",
        detached: false,
        executeJavaScript: vi.fn(async (source: string) => {
          if (source.includes('return "filled";')) {
            writes.push("inserted");
            return "filled";
          }
          return "ready";
        }),
      };
      vi.mocked(webContents.fromDevToolsTargetId).mockReturnValue({
        isDestroyed: () => false,
        focusedFrame: frame,
      } as unknown as Electron.WebContents);
      const browser = new HostSignIns({ authority: f.authority, runtimeId: "runtime" });
      const held = Promise.withResolvers<Awaited<ReturnType<PasswordsBrokerSession["release"]>>>();
      vi.mocked(f.broker.release).mockImplementationOnce(() => held.promise);
      try {
        const fill = browser.fill({
          loginRef: f.loginRef,
          sessionId: "session",
          targetId: "page",
          field: "password",
        });
        await vi.waitFor(() => expect(f.broker.release).toHaveBeenCalledTimes(1));
        if (ending === "detach") browser.sessionDetached("session");
        else browser.close();
        held.resolve({ released: true, value: "WPB-canary-秘密" });
        expect(await fill).toBe("expired");
        expect(writes).toEqual([]);
        expect(f.broker.cancel).not.toHaveBeenCalled();
        expect(await f.seal()).toMatchObject({ type: "login.seal.result", status: "sealed" });
        const next = new HostSignIns({ authority: f.authority, runtimeId: "next-runtime" });
        try {
          expect(
            await next.fill({
              loginRef: f.loginRef,
              sessionId: "next-session",
              targetId: "next-page",
              field: "username",
            }),
          ).toBe("filled");
          expect(writes).toEqual(["inserted"]);
        } finally {
          next.close();
        }
      } finally {
        held.resolve({ released: true, value: "WPB-canary-秘密" });
        browser.close();
      }
    },
  );
  it("serializes releases and discards late results and queued work on cancellation", async () => {
    const f = fixture();
    await f.authorize();
    const frame = {
      origin: "https://example.com",
      detached: false,
      executeJavaScript: vi.fn(async (source: string) =>
        source.includes('return "filled";') ? "filled" : "ready",
      ),
    };
    vi.mocked(webContents.fromDevToolsTargetId).mockReturnValue({
      isDestroyed: () => false,
      focusedFrame: frame,
    } as unknown as Electron.WebContents);
    const firstRelease =
      Promise.withResolvers<Awaited<ReturnType<PasswordsBrokerSession["release"]>>>();
    vi.mocked(f.broker.release).mockImplementationOnce(() => firstRelease.promise);
    const app = f.seal();
    const browser = f.authority.fillReference({
      lease: new AbortController().signal,
      loginRef: f.loginRef,
      targetId: "page",
      field: "username",
    });
    await vi.waitFor(() => expect(f.broker.release).toHaveBeenCalledTimes(1));
    firstRelease.resolve({ released: true, value: "WPB-canary-秘密" });
    expect(await app).toMatchObject({ type: "login.seal.result", status: "sealed" });
    expect(await browser).toBe("filled");
    expect(vi.mocked(f.broker.release).mock.calls[1]?.[0]).toMatchObject({
      kind: "browser",
      origin: "https://example.com",
    });
    vi.mocked(f.broker.release).mockClear();
    const held = Promise.withResolvers<Awaited<ReturnType<PasswordsBrokerSession["release"]>>>();
    vi.mocked(f.broker.release).mockImplementationOnce(() => held.promise);
    const first = f.seal();
    const second = f.seal();
    await vi.waitFor(() => expect(f.broker.release).toHaveBeenCalledTimes(1));
    await f.authority.control(
      { type: "login.cancel", operationId: f.operationId, reason: "withdrawn" },
      f.emit,
    );
    expect(await second).toEqual({ type: "login.seal.result", status: "expired" });
    expect(await first).toEqual({ type: "login.seal.result", status: "expired" });
    held.resolve({ released: true, value: "WPB-canary-秘密" });
    expect(await first).toEqual({ type: "login.seal.result", status: "expired" });
    expect(await second).toEqual({ type: "login.seal.result", status: "expired" });
    expect(f.broker.release).toHaveBeenCalledTimes(1);
  });
  it("refuses expired or mismatched bindings before release and suppresses secret-bearing failures", async () => {
    const f = fixture();
    await f.authorize();
    expect(
      await f.authority.control(
        {
          type: "login.seal",
          operationId: f.operationId,
          receiver: f.receiver,
          binding: { ...f.binding, connectionGeneration: 2 },
        },
        f.emit,
      ),
    ).toEqual({ type: "login.seal.result", status: "unavailable" });
    expect(
      await f.authority.control(
        {
          type: "login.seal",
          operationId: f.operationId,
          receiver: f.receiver,
          binding: { ...f.binding, expiresAt: Date.now() - 1 },
        },
        f.emit,
      ),
    ).toEqual({ type: "login.seal.result", status: "expired" });
    expect(f.broker.release).not.toHaveBeenCalled();
    vi.mocked(f.broker.release).mockRejectedValueOnce(new Error("WPB-canary-秘密"));
    expect(JSON.stringify(await f.seal())).not.toContain("WPB-canary");
  });
});
