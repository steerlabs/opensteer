import { describe, expect, it, vi } from "vitest";
import {
  accountDirectoryRefreshCooldownMilliseconds,
  AccountDirectoryRefreshService,
  type AccountDirectoryRefreshEvent,
} from "./account-directory-refresh.js";

describe("AccountDirectoryRefreshService", () => {
  it("syncs at most once per cooldown across trigger sources and never queues a trailing sync", async () => {
    const clock = { value: 1_000 };
    const refresh = vi.fn(async () => undefined);
    const service = new AccountDirectoryRefreshService({
      eligible: () => true,
      now: () => clock.value,
    });
    service.attach(refresh);

    await expect(service.request("app-focus")).resolves.toBe("refreshed");
    await expect(service.request("system-resume")).resolves.toBe("throttled");
    await expect(service.request("heartbeat")).resolves.toBe("throttled");
    expect(refresh).toHaveBeenCalledOnce();

    clock.value += accountDirectoryRefreshCooldownMilliseconds - 1;
    await expect(service.request("app-focus")).resolves.toBe("throttled");
    expect(refresh).toHaveBeenCalledOnce();

    // Nothing was queued while the cooldown ran: time alone performs no sync,
    // and the next trigger after it is the one that refreshes.
    clock.value += 10 * accountDirectoryRefreshCooldownMilliseconds;
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();
    await expect(service.request("app-focus")).resolves.toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("coalesces triggers that arrive while a sync is running", async () => {
    let release: () => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const service = new AccountDirectoryRefreshService({ eligible: () => true, now: () => 0 });
    service.attach(refresh);

    const first = service.request("app-focus");
    const second = service.request("system-resume");
    const third = service.request("heartbeat");
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toBe("refreshed");
    await expect(second).resolves.toBe("coalesced");
    await expect(third).resolves.toBe("coalesced");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("skips ineligible triggers without spending the cooldown", async () => {
    const clock = { value: 0 };
    const refresh = vi.fn(async () => undefined);
    let signedIn = false;
    const service = new AccountDirectoryRefreshService({
      eligible: () => signedIn,
      now: () => clock.value,
    });
    service.attach(refresh);

    await expect(service.request("app-focus")).resolves.toBe("not-eligible");
    await expect(service.request("system-resume")).resolves.toBe("not-eligible");
    expect(refresh).not.toHaveBeenCalled();

    signedIn = true;
    await expect(service.request("app-focus")).resolves.toBe("refreshed");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("treats a failing eligibility check as ineligible", async () => {
    const refresh = vi.fn(async () => undefined);
    const service = new AccountDirectoryRefreshService({
      eligible: () => Promise.reject(new Error("protected storage is unavailable")),
      now: () => 0,
    });
    service.attach(refresh);

    await expect(service.request("system-resume")).resolves.toBe("not-eligible");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reports a failed sync to the observer and still spends the cooldown", async () => {
    const clock = { value: 0 };
    const observed: AccountDirectoryRefreshEvent[] = [];
    const failure = new Error("Account Host discovery was rejected.");
    const refresh = vi.fn(async () => {
      throw failure;
    });
    const service = new AccountDirectoryRefreshService({
      eligible: () => true,
      now: () => clock.value,
      observe: (event) => observed.push(event),
    });
    service.attach(refresh);

    await expect(service.request("app-focus")).resolves.toBe("failed");
    expect(observed).toEqual([{ error: failure, outcome: "failed", trigger: "app-focus" }]);

    clock.value += 1_000;
    await expect(service.request("app-focus")).resolves.toBe("throttled");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("reports nothing to sync until a refresh source is attached", async () => {
    const service = new AccountDirectoryRefreshService({ eligible: () => true, now: () => 0 });
    await expect(service.request("app-focus")).resolves.toBe("unavailable");
    await expect(service.refreshNow()).rejects.toThrow(/refresh source is unavailable/u);

    const refresh = vi.fn(async () => undefined);
    const detach = service.attach(refresh);
    expect(() => service.attach(refresh)).toThrow(/already attached/u);
    await expect(service.request("app-focus")).resolves.toBe("refreshed");

    detach();
    await expect(service.request("system-resume")).resolves.toBe("unavailable");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("runs a renderer-driven refresh through the cooldown it restarts", async () => {
    const clock = { value: 0 };
    const observed: AccountDirectoryRefreshEvent[] = [];
    const refresh = vi.fn(async () => "selection");
    const service = new AccountDirectoryRefreshService<string>({
      eligible: () => false,
      now: () => clock.value,
      observe: (event) => observed.push(event),
    });
    service.attach(refresh);

    // The renderer asks during onboarding, before the stored credential makes
    // background refreshes eligible, so the explicit request must still run.
    await expect(service.refreshNow()).resolves.toBe("selection");
    expect(observed).toEqual([{ outcome: "refreshed", trigger: "renderer" }]);

    clock.value += accountDirectoryRefreshCooldownMilliseconds - 1;
    await expect(service.request("app-focus")).resolves.toBe("throttled");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("coalesces a background trigger into a renderer refresh already running", async () => {
    let release: (value: string) => void = () => undefined;
    const refresh = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const service = new AccountDirectoryRefreshService<string>({
      eligible: () => true,
      now: () => 0,
    });
    service.attach(refresh);

    const rendererRefresh = service.refreshNow();
    const focus = service.request("app-focus");
    await Promise.resolve();
    release("selection");

    await expect(rendererRefresh).resolves.toBe("selection");
    await expect(focus).resolves.toBe("coalesced");
    expect(refresh).toHaveBeenCalledOnce();
  });
});
