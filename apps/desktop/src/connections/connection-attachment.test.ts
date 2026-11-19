import { HostTransportError } from "@opensteer/client/connections";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { ConnectionAttachment } from "./connection-attachment.js";

describe("ConnectionAttachment", () => {
  it("fences a stale completion after a route swap", async () => {
    const deploymentId = createId("deployment");
    let complete: ((value: Observation) => void) | undefined;
    const establish = vi.fn(
      () =>
        new Promise<Observation>((resolve) => {
          complete = resolve;
        }),
    );
    const supervisor = new ConnectionAttachment({
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

  it("keeps a held attachment waiting through a late session result", async () => {
    const deploymentId = createId("deployment");
    const attachment = new ConnectionAttachment({
      attachmentKey: "owner",
      deploymentId,
      establish: async () => ({ attachmentKey: "owner", deploymentId, outcome: "ready" }),
    });
    attachment.attach();
    await settle();
    expect(attachment.snapshot().status).toBe("connected");

    // The Host restarts as the same key; the earlier attempt's ready arrives afterwards.
    attachment.hold("owner");
    attachment.observe({ attachmentKey: "owner", deploymentId, outcome: "ready" });

    expect(attachment.snapshot().status).toBe("connecting");
    expect(attachment.canCancel()).toBe(true);
  });

  it("leaves retry scheduling to the shared controller", async () => {
    const deploymentId = createId("deployment");
    const establish = vi
      .fn()
      .mockRejectedValueOnce(new HostTransportError("unreachable"))
      .mockResolvedValueOnce({ attachmentKey: "route:1", deploymentId, outcome: "ready" });
    const attachment = new ConnectionAttachment({
      attachmentKey: "route:1",
      deploymentId,
      establish,
    });
    attachment.attach();
    await settle();
    expect(attachment.snapshot()).toMatchObject({
      status: "offline",
      failure: { retryable: true },
    });
    expect(establish).toHaveBeenCalledTimes(1);
    attachment.attach();
    await settle();
    expect(attachment.snapshot().status).toBe("connected");
  });

  it("reports sign-in as a retryable state and missing remote access as its own", async () => {
    const deploymentId = createId("deployment");
    const supervisor = new ConnectionAttachment({
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
    const supervisor = new ConnectionAttachment({
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
    const supervisor = new ConnectionAttachment({
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
    const supervisor = new ConnectionAttachment({
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
    const supervisor = new ConnectionAttachment({
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
    const supervisor = new ConnectionAttachment({
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

  it("does not call establish when cancelled while closing a rotated route", async () => {
    const deploymentId = createId("deployment");
    const closeGate = Promise.withResolvers<void>();
    const establish = vi.fn(async () => ({
      attachmentKey: "route:1",
      deploymentId,
      outcome: "ready" as const,
    }));
    const supervisor = new ConnectionAttachment({
      attachmentKey: "route:1",
      close: () => closeGate.promise,
      deploymentId,
      establish,
    });

    supervisor.attach();
    await settle();
    expect(establish).toHaveBeenCalledOnce();

    supervisor.reconfigure({ attachmentKey: "route:2" });
    expect(supervisor.snapshot().status).toBe("connecting");
    supervisor.cancel();
    expect(supervisor.snapshot().status).toBe("idle");

    closeGate.resolve();
    await settle();

    expect(establish).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({ failure: null, status: "idle" });
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
