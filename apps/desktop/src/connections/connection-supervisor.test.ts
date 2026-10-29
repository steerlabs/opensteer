import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { ConnectionSupervisor } from "./connection-supervisor.js";

describe("ConnectionSupervisor", () => {
  it("fences a stale completion after a route swap", async () => {
    const deploymentId = createId("deployment");
    let complete: ((value: Observation) => void) | undefined;
    const establish = vi.fn(
      () =>
        new Promise<Observation>((resolve) => {
          complete = resolve;
        }),
    );
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish,
    });

    supervisor.attach();
    supervisor.deactivate();
    supervisor.reconfigure({ attachmentKey: "route:2" });
    complete!({ attachmentKey: "route:1", deploymentId, outcome: "ready" });
    await settle();

    expect(supervisor.snapshot().status).toBe("idle");
  });

  it("owns bounded retry and connects only when its scheduled generation is current", async () => {
    const deploymentId = createId("deployment");
    const scheduled: Array<() => void> = [];
    const establish = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce({ attachmentKey: "route:1", deploymentId, outcome: "ready" });
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish,
      schedule: (callback) => scheduled.push(callback),
    });

    supervisor.attach();
    await settle();
    expect(supervisor.snapshot()).toMatchObject({
      status: "offline",
      failure: { retryable: true },
    });
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await settle();
    expect(supervisor.snapshot()).toMatchObject({ status: "connected", failure: null });
  });

  it("reports sign-in as a retryable state and missing remote access as its own", async () => {
    const deploymentId = createId("deployment");
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish: async () => ({ attachmentKey: "route:1", deploymentId, outcome: "needs-sign-in" }),
    });
    supervisor.attach();
    await settle();
    expect(supervisor.snapshot()).toMatchObject({
      failure: { code: "host-sign-in-required", retryable: true },
      status: "needs-sign-in",
    });
    expect(supervisor.canRetry()).toBe(true);

    supervisor.reconfigure({ attachmentKey: null });
    supervisor.attach();
    expect(supervisor.snapshot().status).toBe("needs-remote-access");
    expect(supervisor.canRetry()).toBe(false);
  });

  it("publishes a browser authorization as its own state, stoppable and retryable", async () => {
    const deploymentId = createId("deployment");
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish: async () => ({
        attachmentKey: "route:1",
        deploymentId,
        detail: "Complete authorization in your browser.",
        outcome: "authorizing",
      }),
    });
    const published: string[] = [];
    supervisor.subscribe(({ status }) => published.push(status));

    supervisor.attach();
    await settle();

    // Never "connecting": a person's browser is the thing being waited on, and
    // no amount of waiting here advances it.
    expect(supervisor.snapshot()).toEqual({ failure: null, status: "authorizing" });
    expect(published).toEqual(["connecting", "authorizing"]);
    expect(supervisor.canCancel()).toBe(true);
    expect(supervisor.canRetry()).toBe(true);

    supervisor.cancel();
    expect(supervisor.snapshot()).toMatchObject({ failure: null, status: "idle" });
  });

  it("carries a Host's own timeout out of authorizing and into a signalled repair", async () => {
    const deploymentId = createId("deployment");
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish: async () => ({ attachmentKey: "route:1", deploymentId, outcome: "authorizing" }),
    });
    supervisor.attach();
    await settle();
    expect(supervisor.snapshot().status).toBe("authorizing");

    // The OAuth manager's expiry arrives as an ordinary observation, which is
    // the whole point of publishing it: the row moves without anyone asking.
    supervisor.observe({
      attachmentKey: "route:1",
      deploymentId,
      detail: "Authorization timed out. Sign in again.",
      outcome: "needs-sign-in",
    });

    expect(supervisor.snapshot()).toMatchObject({
      failure: { detail: "Authorization timed out. Sign in again.", retryable: true },
      status: "needs-sign-in",
    });
  });

  it("forces a changed Host authority through close and reverify", async () => {
    const deploymentId = createId("deployment");
    const order: string[] = [];
    let liveKey = "1:host-a:key-a";
    const close = vi.fn(async () => {
      order.push("close");
    });
    const establish = vi.fn(async () => {
      order.push("establish");
      return { attachmentKey: liveKey, deploymentId, outcome: "ready" as const };
    });
    const supervisor = new ConnectionSupervisor({
      attachmentKey: liveKey,
      deploymentId,
      close,
      establish,
    });
    supervisor.attach();
    await settle();
    expect(supervisor.snapshot().status).toBe("connected");

    // The Host restarted under a live attachment: the supervisor must not park
    // on a key nobody will ever answer for.
    order.length = 0;
    liveKey = "2:host-b:key-b";
    supervisor.reconfigure({ attachmentKey: liveKey });
    expect(supervisor.snapshot().status).toBe("connecting");
    await settle();

    expect(order).toEqual(["close", "establish"]);
    expect(supervisor.snapshot().status).toBe("connected");
  });

  it("leaves a detached supervisor alone when its attachment key rotates", async () => {
    const deploymentId = createId("deployment");
    const establish = vi.fn(async () => ({
      attachmentKey: "route:2",
      deploymentId,
      outcome: "ready" as const,
    }));
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish,
    });

    supervisor.reconfigure({ attachmentKey: "route:2" });
    await settle();

    expect(establish).not.toHaveBeenCalled();
    expect(supervisor.snapshot().status).toBe("idle");
  });

  it("returns a cancelled attempt to idle instead of to a failure", async () => {
    const deploymentId = createId("deployment");
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish: () => new Promise<Observation>(() => undefined),
    });

    supervisor.attach();
    expect(supervisor.snapshot().status).toBe("connecting");
    expect(supervisor.canCancel()).toBe(true);
    supervisor.cancel();
    await settle();

    expect(supervisor.snapshot()).toMatchObject({ failure: null, status: "idle" });
    expect(supervisor.canRetry()).toBe(true);
  });

  it("fences a retry that was already scheduled when it stopped being selected", async () => {
    const deploymentId = createId("deployment");
    const scheduled: Array<() => void> = [];
    const establish = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish,
      schedule: (callback) => scheduled.push(callback),
    });

    supervisor.attach();
    await settle();
    expect(scheduled).toHaveLength(1);
    supervisor.deactivate();
    scheduled[0]!();
    await settle();

    expect(establish).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({ failure: null, status: "idle" });
  });

  it("resumes on an ambient trigger only from a failure", async () => {
    const deploymentId = createId("deployment");
    const establish = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValue({ attachmentKey: "route:1", deploymentId, outcome: "ready" });
    const supervisor = new ConnectionSupervisor({
      attachmentKey: "route:1",
      deploymentId,
      establish,
      schedule: () => undefined,
    });

    supervisor.resume();
    expect(establish).not.toHaveBeenCalled();

    supervisor.attach();
    await settle();
    supervisor.resume();
    await settle();
    expect(supervisor.snapshot().status).toBe("connected");

    supervisor.resume();
    expect(establish).toHaveBeenCalledTimes(2);
  });
});

interface Observation {
  readonly attachmentKey: string;
  readonly deploymentId: string;
  readonly outcome: "ready";
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
