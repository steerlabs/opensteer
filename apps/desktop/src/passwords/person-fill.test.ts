import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonFillInput } from "@opensteer/browser-runtime-core";
import { personFillMaxAccounts } from "@opensteer/protocol";
import type { PasswordsBrokerPersonFillSession, PasswordsBrokerSession } from "./broker-session.js";
import { PasswordsPersonFillAuthority } from "./person-fill.js";

const targets = vi.hoisted(() => new Map<string, unknown>());
vi.mock("electron", () => ({
  webContents: { fromDevToolsTargetId: (id: string) => targets.get(id) },
}));
const authorities: PasswordsPersonFillAuthority[] = [];
afterEach(async () => {
  await Promise.all(authorities.splice(0).map((authority) => authority.close()));
  targets.clear();
  vi.useRealTimers();
});
function fixture() {
  const target = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => "https://example.com",
  });
  targets.set("tab", target);
  const lifetime = new AbortController();
  const account = {
    id: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    username: "synthetic@example.com",
    label: null,
    hasCode: true,
  };
  const order: string[] = [];
  const broker = {
    fillAccounts: vi.fn<PasswordsBrokerPersonFillSession["fillAccounts"]>(async () => ({
      fill: "on",
      accounts: [account],
    })),
    fillBegin: vi.fn<PasswordsBrokerPersonFillSession["fillBegin"]>(async () => ({
      decision: { decision: "authorized", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      lifetime: lifetime.signal,
    })),
    release: vi.fn<PasswordsBrokerSession["release"]>(async (input) => {
      order.push(`release:${input.field}`);
      return { released: true, value: `synthetic-${input.field}` };
    }),
    cancel: vi.fn(async () => undefined),
  };
  const authority = new PasswordsPersonFillAuthority(broker as unknown as PasswordsBrokerSession);
  authorities.push(authority);
  const input: PersonFillInput = {
    consumerToken: "web",
    targetId: "tab",
    origin: "https://example.com",
    role: "username",
    presence: "elsewhere",
    loginId: account.id,
    revision: 1,
    slots: { partner: true, group: false },
    signal: new AbortController().signal,
    write: vi.fn(async (slot, value) => {
      order.push(`write:${slot}:${value}`);
      return true;
    }),
  };
  return { authority, broker, input, account, order, target, lifetime };
}

describe("person fill authority", () => {
  it("disables person fills for a legacy session", async () => {
    const authority = new PasswordsPersonFillAuthority({} as PasswordsBrokerSession);
    const { input } = fixture();
    expect(await authority.accounts(input)).toEqual([]);
    expect(await authority.fill(input)).toBe("unavailable");
    // The service keeps its methods but answers undefined after reconnecting at protocol 7.
    const reconnected = Object.defineProperties({} as PasswordsBrokerSession, {
      fillAccounts: { get: () => undefined },
      fillBegin: { get: () => undefined },
    });
    const downgraded = new PasswordsPersonFillAuthority(reconnected);
    expect(await downgraded.accounts(input)).toEqual([]);
    expect(await downgraded.fill(input)).toBe("unavailable");
  });
  it("reuses only the consumer, tab, site, login revision and presence that confirmed", async () => {
    const { authority, broker, input } = fixture();
    expect((await authority.accounts(input))[0]?.ready).toBe(false);
    expect(await authority.fill(input)).toBe("filled");
    expect(
      (await authority.accounts({ ...input, origin: "https://login.example.com" }))[0]?.ready,
    ).toBe(true);
    for (const change of [
      { consumerToken: "phone" },
      { presence: "here" as const },
      { targetId: "other-tab" },
      { origin: "https://other.com" },
    ])
      expect((await authority.accounts({ ...input, ...change }))[0]?.ready).toBe(false);
    await authority.fill(input);
    expect(broker.fillBegin).toHaveBeenCalledTimes(1);
    broker.fillAccounts.mockResolvedValue({
      fill: "on",
      accounts: [
        { id: input.loginId, revision: 2, username: "synthetic", label: null, hasCode: true },
      ],
    });
    expect((await authority.accounts(input))[0]?.ready).toBe(false);
  });
  it("filters code accounts and caps offers without beginning a transaction", async () => {
    const { authority, broker, input, account } = fixture();
    broker.fillAccounts.mockResolvedValue({
      fill: "on",
      accounts: [{ ...account, hasCode: false }, ...Array.from({ length: 30 }, () => account)],
    });
    expect(await authority.accounts({ ...input, role: "code" })).toHaveLength(
      personFillMaxAccounts,
    );
    expect(broker.fillBegin).not.toHaveBeenCalled();
  });
  it.each(["username", "password", "code"] as const)(
    "releases and writes %s slots in order and clears released values",
    async (role) => {
      const { authority, broker, input, order } = fixture();
      expect(await authority.fill({ ...input, role, slots: { partner: true, group: true } })).toBe(
        "filled",
      );
      expect(order).toEqual(
        role === "code"
          ? ["release:totp", "write:group:synthetic-totp"]
          : [
              `release:${role}`,
              `write:target:synthetic-${role}`,
              `release:${role === "username" ? "password" : "username"}`,
              `write:partner:synthetic-${role === "username" ? "password" : "username"}`,
            ],
      );
      for (const release of broker.release.mock.results)
        expect(await release.value).toEqual({ released: true, value: "" });
    },
  );
  it("begins a fresh confirmation for another consumer or presence", async () => {
    const { authority, broker, input } = fixture();
    await authority.fill(input);
    await authority.fill({ ...input, consumerToken: "phone" });
    await authority.fill({ ...input, presence: "here" });
    expect(broker.fillBegin).toHaveBeenCalledTimes(3);
    authority.statusChanged({
      availability: "available",
      development: true,
      broker: { personFill: "on", agentSignIns: "off", vault: "ready" },
    });
    expect((await authority.accounts(input))[0]?.ready).toBe(true);
  });
  it.each(["password", "code"] as const)(
    "writes a lone %s target without extra releases",
    async (role) => {
      const { authority, broker, input, order } = fixture();
      expect(
        await authority.fill({ ...input, role, slots: { partner: false, group: false } }),
      ).toBe("filled");
      expect(broker.release).toHaveBeenCalledTimes(1);
      expect(order).toEqual([
        `release:${role === "code" ? "totp" : "password"}`,
        `write:target:synthetic-${role === "code" ? "totp" : "password"}`,
      ]);
    },
  );
  it("ends reuse on an opaque main-frame navigation without throwing", async () => {
    const { authority, broker, input, target } = fixture();
    await authority.fill(input);
    expect(() => target.emit("did-navigate", {}, "about:blank")).not.toThrow();
    expect((await authority.accounts(input))[0]?.ready).toBe(false);
    expect(broker.cancel).toHaveBeenCalledTimes(1);
  });
  it("compares main-frame navigation to the top-level site when the bound frame has another site", async () => {
    const { authority, broker, input, target } = fixture();
    const iframe = { ...input, origin: "https://identity.example.net" };
    await authority.fill(iframe);
    target.emit("did-navigate", {}, "https://login.example.com");
    expect((await authority.accounts(iframe))[0]?.ready).toBe(true);
    target.emit("did-navigate", {}, iframe.origin);
    expect((await authority.accounts(iframe))[0]?.ready).toBe(false);
    expect(broker.cancel).toHaveBeenCalledTimes(1);
  });
  it("maps a failed broker call to unavailable and cancels its transaction", async () => {
    const { authority, broker, input } = fixture();
    broker.fillBegin.mockRejectedValue(new Error("synthetic failure"));
    expect(await authority.fill(input)).toBe("unavailable");
    expect(broker.cancel).toHaveBeenCalledTimes(1);
    expect(input.write).not.toHaveBeenCalled();
  });
  it.each(["navigation", "off"])(
    "ends a pending confirmation on %s without later writing",
    async (reason) => {
      const { authority, broker, input, target, lifetime } = fixture();
      const grant =
        Promise.withResolvers<Awaited<ReturnType<PasswordsBrokerPersonFillSession["fillBegin"]>>>();
      broker.fillBegin.mockReturnValue(grant.promise);
      const fill = authority.fill(input);
      await vi.waitFor(() => expect(broker.fillBegin).toHaveBeenCalledTimes(1), { timeout: 1_000 });
      if (reason === "navigation") target.emit("did-navigate", {}, "https://other.com");
      else
        authority.statusChanged({
          availability: "available",
          development: true,
          broker: { personFill: "off", agentSignIns: "on", vault: "ready" },
        });
      expect(broker.fillBegin.mock.calls[0]![1].aborted).toBe(true);
      grant.resolve({
        decision: {
          decision: "authorized",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        lifetime: lifetime.signal,
      });
      expect(await fill).toBe(reason === "off" ? "denied" : "expired");
      expect(input.write).not.toHaveBeenCalled();
    },
  );
  it("begins only once when concurrent requests arrive during confirmation", async () => {
    const { authority, broker, input, lifetime } = fixture();
    const grant =
      Promise.withResolvers<Awaited<ReturnType<PasswordsBrokerPersonFillSession["fillBegin"]>>>();
    broker.fillBegin.mockReturnValue(grant.promise);
    const fills = [authority.fill(input), authority.fill(input)];
    await vi.waitFor(() => expect(broker.fillBegin).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    grant.resolve({
      decision: { decision: "authorized", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      lifetime: lifetime.signal,
    });
    expect(await Promise.all(fills)).toEqual(["filled", "filled"]);
    expect(broker.fillBegin).toHaveBeenCalledTimes(1);
  });
  it("stops after a stale write", async () => {
    const { authority, input, broker } = fixture();
    expect(await authority.fill({ ...input, write: async () => false })).toBe("stale");
    expect(broker.release).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ decision: "changed" }, "changed"],
    [{ decision: "cancelled" }, "cancelled"],
    [{ decision: "unavailable", reason: "fill-off" }, "denied"],
    [{ decision: "unavailable", reason: "busy" }, "unavailable"],
    [{ decision: "unavailable", reason: "not-set-up" }, "unavailable"],
  ] as const)("maps begin %j to %s", async (decision, status) => {
    const { authority, input, broker, lifetime } = fixture();
    broker.fillBegin.mockResolvedValue({ decision, lifetime: lifetime.signal });
    expect(await authority.fill(input)).toBe(status);
    expect(broker.release).not.toHaveBeenCalled();
  });
  it.each([
    ["ended", "expired"],
    ["revoked", "denied"],
    ["passwords-off", "denied"],
    ["wrong-site", "stale"],
    ["no-totp", "changed"],
  ] as const)("maps release %s to %s", async (reason, status) => {
    const { authority, input, broker } = fixture();
    broker.release.mockResolvedValue({ released: false, reason });
    expect(await authority.fill(input)).toBe(status);
    expect(input.write).not.toHaveBeenCalled();
    if (["revoked", "passwords-off", "ended"].includes(reason))
      expect((await authority.accounts(input))[0]?.ready).toBe(false);
  });
  it.each(["navigation", "destroyed", "off", "vault", "lifetime", "deadline", "close"])(
    "ends a reusable transaction on %s",
    async (end) => {
      vi.useFakeTimers();
      const { authority, broker, input, target, lifetime } = fixture();
      await authority.fill(input);
      target.emit("did-navigate", {}, "https://login.example.com/path");
      expect((await authority.accounts(input))[0]?.ready).toBe(true);
      if (end === "navigation") target.emit("did-navigate", {}, "https://other.com");
      if (end === "destroyed") target.emit("destroyed");
      if (end === "off")
        authority.statusChanged({
          availability: "available",
          development: true,
          broker: { personFill: "off", agentSignIns: "on", vault: "ready" },
        });
      if (end === "vault")
        broker.fillAccounts.mockResolvedValue({ fill: "not-set-up", accounts: [] });
      if (end === "lifetime") lifetime.abort();
      if (end === "deadline") await vi.advanceTimersByTimeAsync(60_000);
      if (end === "close") await authority.close();
      expect((await authority.accounts(input))[0]?.ready ?? false).toBe(false);
      expect(broker.cancel).toHaveBeenCalledTimes(1);
    },
  );
  it("serializes concurrent fills and waits for the first write before releasing another", async () => {
    const { authority, broker, input } = fixture();
    const held = Promise.withResolvers<boolean>();
    const first = authority.fill({
      ...input,
      write: async () => {
        return held.promise;
      },
    });
    await vi.waitFor(() => expect(broker.release).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    const second = authority.fill(input);
    expect(broker.fillBegin).toHaveBeenCalledTimes(1);
    expect(broker.release).toHaveBeenCalledTimes(1);
    held.resolve(true);
    expect(await Promise.all([first, second])).toEqual(["filled", "filled"]);
    expect(broker.fillBegin).toHaveBeenCalledTimes(1);
  });
  it("refuses to write a value released after the offer aborts", async () => {
    const { authority, broker, input } = fixture();
    const abort = new AbortController();
    broker.release.mockImplementation(async () => {
      abort.abort();
      return { released: true, value: "synthetic" };
    });
    expect(await authority.fill({ ...input, signal: abort.signal })).toBe("expired");
    expect(input.write).not.toHaveBeenCalled();
  });
});
