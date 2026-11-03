import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { browserPresentationRef, encodeBrowserVideoFrame } from "@opensteer/protocol";
import { browserVideoFixture, browserKeyFixture } from "./browser-video.test-support.js";
describe("certified browser media admission and fan-out", () => {
  it("uses one producer and independently credits viewers; media cannot acquire control", async () => {
    const f = await browserVideoFixture();
    try {
      const controller = await f.add(true);
      const spectator = await f.add(false);
      const source = await f.source();
      await vi.waitFor(
        () =>
          expect(
            controller.states.length + spectator.states.length,
            "both media outlets admitted",
          ).toBe(2),
        { timeout: 3000 },
      );
      source.send(1);
      await vi.waitFor(() => expect(source.acks, "Host admitted the source AU").toHaveLength(1), {
        timeout: 3000,
      });
      expect(f.operations.filter((o) => o.type === "browser.video.start")).toHaveLength(1);
      expect(controller.media).toHaveLength(1);
      expect(spectator.media).toHaveLength(1);
      const reference = browserPresentationRef(f.header(1));
      expect(await f.hub.allowsClick(controller.owner.id, f.start().streamId, reference)).toBe(
        true,
      );
      expect(await f.hub.allowsClick(spectator.owner.id, f.start().streamId, reference)).toBe(
        false,
      );
      expect(source.acks[0]).toMatchObject({
        sequence: 1,
      });
      await controller.ack(1);
      source.send(2);
      await vi.waitFor(
        () => expect(controller.media, "controller received the next reference").toHaveLength(2),
        { timeout: 3000 },
      );
      await controller.ack(2);
      f.advance(2000);
      source.send(3);
      await vi.waitFor(() => expect(controller.media).toHaveLength(3), { timeout: 3000 });
      expect(controller.socket.readyState).toBe(1);
    } finally {
      await f.close();
    }
  });
  it.each(["unauthenticated", "missing-token", "invalid-token"])(
    "refuses %s media before upgrading",
    async (reason) => {
      const authenticate = vi.fn(async () => {
        if (reason === "unauthenticated") throw new Error("No login");
      });
      const f = await browserVideoFixture(false, authenticate);
      let socket: WebSocket | null = null;
      try {
        const admitted = await f.admit(true);
        const claim = vi.spyOn(f.hub, "claimViewer");
        const protocols =
          reason === "missing-token"
            ? []
            : [
                `opensteer-video.${reason === "invalid-token" ? "x".repeat(43) : admitted.attach.mediaToken}`,
              ];
        socket = new WebSocket(`${f.origin}/v1/browser/video`, protocols);
        socket.on("error", () => undefined);
        const [, response] = await once(socket, "unexpected-response", {
          signal: AbortSignal.timeout(2000),
        });
        expect(response.statusCode).toBe(403);
        response.destroy();
        expect(socket.readyState).not.toBe(WebSocket.OPEN);
        expect(authenticate).toHaveBeenCalledOnce();
        if (reason !== "invalid-token") expect(claim).not.toHaveBeenCalled();
      } finally {
        socket?.terminate();
        await f.close();
      }
    },
  );
  it("reports viewer and producer capacity without ending admitted viewers", async () => {
    const f = await browserVideoFixture();
    try {
      const first = await f.admit(true);
      for (let n = 1; n < 8; n++) await f.admit(false);
      const messages: import("@opensteer/protocol").BrowserServerMessage[] = [];
      await expect(
        f.hub.add(f.binding, {
          ...first.owner,
          id: crypto.randomUUID(),
          send: async (m) => {
            messages.push(m);
          },
        }),
      ).resolves.toBeUndefined();
      expect(messages.at(-1)).toMatchObject({ state: "failed", reason: "capacity" });
      f.hub.state(f.binding, f.start().streamId, {
        type: "browser.video.state",
        surfaceId: first.owner.target.surfaceId,
        streamId: f.start().streamId,
        state: "live",
        capacity: { backend: "software", maxSessions: 1, maxFps: 15 },
      });
      await expect(
        f.hub.add(f.binding, {
          ...first.owner,
          id: crypto.randomUUID(),
          target: {
            ...first.owner.target,
            surfaceId: "another" as typeof first.owner.target.surfaceId,
          },
          send: async (m) => {
            messages.push(m);
          },
        }),
      ).resolves.toBeUndefined();
      expect(messages.at(-1)).toMatchObject({ state: "failed", reason: "capacity" });
      expect(f.operations.filter((o) => o.type === "browser.video.start")).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("burns source and viewer admissions and refuses tickets from another authority arm", async () => {
    const f = await browserVideoFixture();
    try {
      const viewer = await f.add(true);
      const ticket = f.start().dataTicket;
      expect(() => f.authenticator.verifyDisplayDataTicket(ticket)).toThrow();
      const claims = f.hub.claimSource(ticket);
      expect(claims.target).toEqual(viewer.owner.target);
      expect(() => f.hub.claimSource(ticket)).toThrow();
      await vi.waitFor(() => expect(viewer.states, "viewer token was consumed").toHaveLength(1), {
        timeout: 3000,
      });
      await expect(f.hub.claimViewer(viewer.attach.mediaToken)).rejects.toThrow();
      f.end();
      expect(
        await f.hub.allowsClick(
          viewer.owner.id,
          f.start().streamId,
          browserPresentationRef(f.header(1)),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("keeps the first stream through size changes and focus handover", async () => {
    const f = await browserVideoFixture();
    try {
      const first = await f.add(true);
      const second = await f.add(true);
      const stream = f.start().streamId;
      f.advance(1100);
      f.hub.update(
        second.owner.id,
        stream,
        { maxWidth: 256, maxHeight: 256, maxFps: 10, maxBitrate: 500000 },
        true,
      );
      expect(f.operations.filter((o) => o.type === "browser.video.start")).toHaveLength(1);
      expect(f.operations.filter((o) => o.type === "browser.video.budget").at(-1)).toMatchObject({
        budget: { maxWidth: 128, maxHeight: 128, maxFps: 10 },
      });
      expect(
        first.messages.some((m) => m.type === "browser.video.state" && m.state === "stopped"),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("keeps a controller live without presentation receipts and does not re-key a slow ACK", async () => {
    const f = await browserVideoFixture();
    try {
      const controller = await f.add(true);
      const source = await f.source();
      source.send(1);
      await vi.waitFor(() => expect(controller.media).toHaveLength(1), { timeout: 3000 });
      const keys = f.operations.filter((o) => o.type === "browser.video.keyframe").length;
      f.advance(1200);
      await controller.ack(1);
      expect(f.operations.filter((o) => o.type === "browser.video.keyframe")).toHaveLength(keys);
      for (let n = 2; n <= 7; n++) {
        source.send(n);
        await vi.waitFor(() => expect(controller.media).toHaveLength(n), { timeout: 3000 });
        await controller.ack(n);
      }
      expect(
        controller.messages.some(
          (m) => m.type === "browser.video.state" && ["paused", "stopped"].includes(m.state),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("keeps oversized keys and slow acknowledgements live", async () => {
    const f = await browserVideoFixture();
    try {
      const viewer = await f.add(true);
      const source = await f.source();
      const paddedKey = new Uint8Array(300000).fill(255);
      paddedKey.set(browserKeyFixture);
      source.socket.send(encodeBrowserVideoFrame(f.header(1), paddedKey));
      await vi.waitFor(() => expect(viewer.media).toHaveLength(1), { timeout: 3000 });
      f.advance(800);
      await viewer.ack(1);
      source.send(2);
      await vi.waitFor(() => expect(viewer.media).toHaveLength(2), { timeout: 3000 });
      await viewer.ack(2);
      expect(
        viewer.messages.some((m) => m.type === "browser.video.state" && m.state === "stopped"),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
  it("refuses a retired document without throwing", async () => {
    const f = await browserVideoFixture();
    try {
      const controller = await f.add(true);
      const stream = f.start().streamId;
      f.hub.retireTarget(f.binding, "tab");
      await expect(
        f.hub.allowsClick(controller.owner.id, stream, browserPresentationRef(f.header(1))),
      ).resolves.toBe(false);
    } finally {
      await f.close();
    }
  });
  it("retires a closed document and rechecks the login even while its picture is idle", async () => {
    const f = await browserVideoFixture();
    try {
      const first = await f.add(true);
      const second = await f.add(false);
      const stream = f.start().streamId;
      first.deny();
      f.advance(5100);
      await vi.waitFor(() => expect(first.socket.readyState, "revoked viewer closed").toBe(3), {
        timeout: 1000,
      });
      expect(second.socket.readyState).toBe(1);
      f.hub.retireTarget(f.binding, "tab");
      expect(second.messages).toContainEqual(
        expect.objectContaining({
          type: "browser.video.state",
          streamId: stream,
          state: "stopped",
        }),
      );
    } finally {
      await f.close();
    }
  });
});
