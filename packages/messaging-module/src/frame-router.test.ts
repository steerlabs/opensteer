import { RunnerAuxiliaryFrameFenceSchema } from "@opensteer/protocol";
import type { RunnerModuleStream } from "@opensteer/runner-client";
import { describe, expect, it, vi } from "vitest";
import { MessagingFrameRouter } from "./host-client.js";

/**
 * The fence every messaging-stream frame repeats. It names the Runner, its
 * boot, the primary connection this stream was granted beside, and the stream
 * itself, so a frame can never be replayed onto a later connection.
 */
const messagingFence = RunnerAuxiliaryFrameFenceSchema.parse({
  auxiliaryStreamId: "rax_11111111-1111-4111-8111-111111111111",
  bootId: "rbt_11111111-1111-4111-8111-111111111111",
  connectionGeneration: 1,
  connectionId: "rcn_11111111-1111-4111-8111-111111111111",
  connectionLeaseId: "rls_11111111-1111-4111-8111-111111111111",
  module: "messaging",
  runnerId: "rnr_11111111-1111-4111-8111-111111111111",
});

describe("MessagingFrameRouter", () => {
  // Failure cases for the disconnect race: a result rejects while the socket
  // still owns the write callback; a rejected/synchronously throwing send
  // strands its pending result and timer. Every path must settle and clean up.
  it("settles disconnect while the socket write is still pending", async () => {
    let finishSend!: () => void;
    const sending = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const router = new MessagingFrameRouter();
    router.attach({
      fence: messagingFence,
      browserAttachPublicKeys: undefined,
      send: () => sending,
    });
    let failure: unknown;
    const pending = router.request("delivery.claim", {}).catch((error: unknown) => {
      failure = error;
    });
    router.detach(new Error("closed during send"));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(failure).toMatchObject({ message: "closed during send" });
    } finally {
      finishSend();
      await pending;
    }
  });

  it.each([false, true])(
    "clears pending state when a socket write fails (synchronous: %s)",
    async (synchronous) => {
      vi.useFakeTimers();
      const router = new MessagingFrameRouter();
      router.attach({
        fence: messagingFence,
        browserAttachPublicKeys: undefined,
        send: () => {
          if (synchronous) throw new Error("write refused");
          return Promise.reject(new Error("write refused"));
        },
      });
      try {
        await expect(router.request("delivery.claim", {})).rejects.toThrow("write refused");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("answers a host request whose handler needs a request of its own", async () => {
    const stream = new FakeStream();
    const router = new MessagingFrameRouter({ requestTimeoutMs: 500 });
    router.attach(stream);
    const inbound = serialFrames(router);

    // The Host answers `runtime.request` only once the request frame has left,
    // which is exactly the ordering that used to deadlock: the answer arrived
    // on the one lane the unfinished request was already occupying.
    stream.onSend = (frame) => {
      if (frame.type !== "runtime.request") return;
      void inbound({
        ...messagingFence,
        ok: true,
        requestId: frame.requestId,
        result: { secrets: { botToken: "xoxb-test" } },
        type: "host.response",
      });
    };
    router.setHandler(async () => {
      const lease = await router.request("credential.resolve", { purpose: "transport" });
      return { resolved: lease };
    });

    await inbound(hostRequest("crq_aaaaaaaaaaaaaaaaaaaaaaaa"));

    const response = await stream.waitFor("runtime.response");
    expect(response).toMatchObject({
      ok: true,
      requestId: "crq_aaaaaaaaaaaaaaaaaaaaaaaa",
      result: { resolved: { secrets: { botToken: "xoxb-test" } } },
    });
  });

  it("keeps host requests in arrival order", async () => {
    const stream = new FakeStream();
    const router = new MessagingFrameRouter();
    router.attach(stream);
    const inbound = serialFrames(router);
    const handled: string[] = [];
    router.setHandler(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, handled.length === 0 ? 20 : 0));
      handled.push(request.requestId);
      return { synchronized: true };
    });

    await inbound(hostRequest("crq_bbbbbbbbbbbbbbbbbbbbbbbb"));
    await inbound(hostRequest("crq_cccccccccccccccccccccccc"));

    await vi.waitFor(() => expect(handled).toHaveLength(2));
    expect(handled).toEqual(["crq_bbbbbbbbbbbbbbbbbbbbbbbb", "crq_cccccccccccccccccccccccc"]);
  });

  it("fails every request in flight when the stream goes away", async () => {
    const stream = new FakeStream();
    const router = new MessagingFrameRouter();
    router.attach(stream);
    const pending = router.request("delivery.claim", { leaseSeconds: 30 });
    router.detach(new Error("The messaging module stream closed"));
    await expect(pending).rejects.toThrow(/stream closed/u);
  });
});

function hostRequest(requestId: string): Record<string, unknown> {
  return {
    ...messagingFence,
    operation: "connections.sync",
    payload: { connections: [] },
    requestId,
    type: "host.request",
  };
}

/** Frames arrive one at a time, the way the Runner's inbound dispatcher feeds them. */
function serialFrames(router: MessagingFrameRouter): (frame: unknown) => Promise<void> {
  const signal = new AbortController().signal;
  let tail = Promise.resolve();
  return (frame) => {
    tail = tail.then(() =>
      router.handleFrame(Buffer.from(JSON.stringify(frame), "utf8"), false, signal),
    );
    return tail;
  };
}

class FakeStream implements RunnerModuleStream {
  readonly browserAttachPublicKeys = undefined;
  readonly fence = messagingFence;
  readonly sent: { readonly [key: string]: unknown; readonly type: string }[] = [];
  onSend: ((frame: { readonly [key: string]: unknown; readonly type: string }) => void) | undefined;

  async send(frame: Buffer | string): Promise<void> {
    const parsed = JSON.parse(typeof frame === "string" ? frame : frame.toString("utf8")) as {
      readonly [key: string]: unknown;
      readonly type: string;
    };
    this.sent.push(parsed);
    this.onSend?.(parsed);
  }

  async waitFor(type: string): Promise<Record<string, unknown>> {
    await vi.waitFor(() => expect(this.sent.map((frame) => frame.type)).toContain(type));
    return this.sent.find((frame) => frame.type === type) as Record<string, unknown>;
  }
}
