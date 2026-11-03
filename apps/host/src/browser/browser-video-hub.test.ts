import { describe, expect, it, vi } from "vitest";
import { browserPresentationRef } from "@opensteer/protocol";
import { browserVideoFixture } from "./browser-video.test-support.js";
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
      await f.hub.presented(controller.owner.id, f.start().streamId, reference);
      expect(await f.hub.allowsClick(controller.owner.id, f.start().streamId, reference)).toBe(
        true,
      );
      expect(await f.hub.allowsClick(spectator.owner.id, f.start().streamId, reference)).toBe(
        false,
      );
      expect(source.acks[0]).toMatchObject({
        sequence: 1,
        retainFor: [f.hub.slot(controller.owner.id, f.start().streamId)],
      });
      await controller.ack(1);
      source.send(2);
      await vi.waitFor(
        () => expect(controller.media, "controller received the next reference").toHaveLength(2),
        { timeout: 3000 },
      );
      await controller.ack(2);
      f.advance(2000);
      await vi.waitFor(
        () =>
          expect(
            spectator.messages.some(
              (m) => m.type === "browser.video.state" && m.state === "paused",
            ),
            "slow spectator was isolated",
          ).toBe(true),
        { timeout: 3000 },
      );
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
  it("keeps an admitted gesture through budget handover and releases revoked viewers independently", async () => {
    const f = await browserVideoFixture();
    try {
      const first = await f.add(true);
      const second = await f.add(true, {
        maxWidth: 256,
        maxHeight: 256,
        maxFps: 15,
        maxBitrate: 500000,
      });
      const source = await f.source();
      source.send(1);
      await vi.waitFor(() => expect(source.acks, "publication holds transferred").toHaveLength(1), {
        timeout: 3000,
      });
      const stream = f.start().streamId;
      const ref = browserPresentationRef(f.header(1));
      const gesture = "00000000-0000-4000-8000-000000000009";
      await f.hub.gesture(first.owner.id, stream, gesture, ref, "begin");
      f.advance(1100);
      f.hub.update(second.owner.id, stream, second.owner.budget, true);
      expect(f.operations.filter((o) => o.type === "browser.video.start")).toHaveLength(1);
      expect(f.hub.consumeGesture(first.owner.id, stream, gesture)).toBe(true);
      expect(f.hub.consumeGesture(first.owner.id, stream, gesture)).toBe(false);
      expect(f.hub.cancelGesture(first.owner.id, stream)).toBeNull();
      expect(f.hub.completeGesture(stream, f.hub.slot(first.owner.id, stream)!, gesture)).toBe(
        first.owner.id,
      );
      await vi.waitFor(
        () =>
          expect(
            f.operations.filter((o) => o.type === "browser.video.start"),
            "handover waited for native terminal result",
          ).toHaveLength(2),
        { timeout: 3000 },
      );
      expect(await f.hub.allowsClick(first.owner.id, stream, ref)).toBe(false);
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
      await vi.waitFor(
        () => expect(first.releases, "revoked viewer released its native slot").toHaveLength(1),
        { timeout: 1000 },
      );
      expect(second.releases).toHaveLength(0);
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
  it("replaces a rendition under ordered controller handover and retires its old stream", async () => {
    const f = await browserVideoFixture();
    try {
      const first = await f.add(true);
      const second = await f.add(true, {
        maxWidth: 256,
        maxHeight: 256,
        maxFps: 15,
        maxBitrate: 500000,
      });
      const old = f.start().streamId;
      f.advance(1100);
      f.hub.update(
        second.owner.id,
        old,
        { maxWidth: 256, maxHeight: 256, maxFps: 15, maxBitrate: 500000 },
        true,
      );
      await vi.waitFor(
        () =>
          expect(
            f.operations.filter((o) => o.type === "browser.video.start"),
            "replacement rendition started",
          ).toHaveLength(2),
        { timeout: 3000 },
      );
      expect(first.messages).toContainEqual(
        expect.objectContaining({
          type: "browser.video.state",
          streamId: old,
          state: "stopped",
          reason: "replaced",
        }),
      );
      expect(
        await f.hub.allowsClick(first.owner.id, old, browserPresentationRef(f.header(1))),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });
});
