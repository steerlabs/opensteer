import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import type { HostClient, HostSnapshot } from "./client.js";
import { AppIconOwner } from "./app-icons.js";

const identity = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
async function setup() {
  const mock = new MockHostClient({ latencyMs: 0 });
  await mock.load();
  let snapshot = mock.getSnapshot();
  const machine = snapshot.machines.find((m) => m.name === "Studio Mac")!;
  const rpc = vi.fn(async () => ({ ok: true, data: { apps: [{ identity, iconPng: "png" }] } }));
  const host = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    rpc: { "integration.computer.apps.installed": rpc },
  } as unknown as HostClient;
  mock.dispose();
  return {
    owner: new AppIconOwner(host),
    machine,
    machines: snapshot.machines,
    rpc,
    change: (change: Partial<HostSnapshot>) => {
      snapshot = { ...snapshot, ...change };
    },
  };
}
afterEach(() => vi.useRealTimers());
it("shares icons by machine and case insensitive bundle, independently across computers", async () => {
  const { owner, machine, machines, rpc } = await setup();
  expect(await owner.read(machine.id, identity)).toBe("png");
  expect(
    await owner.read(machine.id, { ...identity, bundleId: identity.bundleId.toLowerCase() }),
  ).toBe("png");
  expect(rpc).toHaveBeenCalledTimes(1);
  const second = machines.find((m) => m.name === "Mac mini")!;
  expect(await owner.read(second.id, identity)).toBe("png");
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(await owner.read("missing", identity)).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(await owner.read(machine.id, { ...identity, bundleId: "com.apple.Calendar" })).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(3);
});
it.each<Partial<HostSnapshot>>([{ session: "authentication-required" }, { connection: "offline" }])(
  "refuses icon RPCs without authority: %j",
  async (state) => {
    const { owner, machine, rpc, change } = await setup();
    change(state);
    expect(await owner.read(machine.id, identity)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  },
);
it.each(["user", "deployment"])(
  "invalidates cached and pending icons on %s change",
  async (scope) => {
    const { owner, machine, rpc, change } = await setup();
    expect(await owner.read(machine.id, identity)).toBe("png");
    if (scope === "deployment") change({ deploymentId: "other" });
    else change({ user: { id: "other" } } as Partial<HostSnapshot>);
    let finish!: (value: Awaited<ReturnType<typeof rpc>>) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = owner.read(machine.id, identity);
    expect(rpc).toHaveBeenCalledTimes(2);
    change({ deploymentId: "third" });
    finish({ ok: true, data: { apps: [{ identity, iconPng: "previous-reader" }] } });
    expect(await pending).toBeNull();
    expect(await owner.read(machine.id, identity)).toBe("png");
  },
);
it("retries a failed read at sixty seconds, never sooner", async () => {
  const { owner, machine, rpc } = await setup();
  vi.useFakeTimers();
  rpc.mockRejectedValueOnce(new Error("offline"));
  expect(await owner.read(machine.id, identity)).toBeNull();
  vi.advanceTimersByTime(59_999);
  expect(await owner.read(machine.id, identity)).toBeNull();
  expect(rpc).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(await owner.read(machine.id, identity)).toBe("png");
  expect(rpc).toHaveBeenCalledTimes(2);
});
it("does not ask an offline Mac or an Android phone for Mac icons", async () => {
  const { owner, machine, rpc, change } = await setup();
  change({ machines: [{ ...machine, status: "offline" }] });
  expect(await owner.read(machine.id, identity)).toBeNull();
  change({ machines: [{ ...machine, device: { ...machine.device!, platform: "android" } }] });
  expect(await owner.read(machine.id, identity)).toBeNull();
  expect(rpc).not.toHaveBeenCalled();
});
