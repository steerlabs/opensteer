import { expect, it, vi } from "vitest";
import {
  DisplayStreams,
  type ComputerDisplayTarget,
  type DisplayFrame,
} from "../integrations/phone-display-stream.js";
import { MockPhoneDisplaySocket } from "./mock-phone-display.js";

const target: ComputerDisplayTarget = {
  scope: "smoke",
  source: { kind: "task-session", sessionId: "bsn_00000000-0000-4000-8000-000000000001" },
};

/**
 * The wire the desktop display smoke's `mock-preview` scenario sees: the
 * picture and one view open the preview phone's stream; later views join it,
 * share input and leave. Only what the viewer sends is recorded.
 */
async function previewStream() {
  const sent: string[] = [];
  const streams = new DisplayStreams({
    connect: () => {
      const socket = new MockPhoneDisplaySocket("live");
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const message = JSON.parse(String(data)) as { type: string; sequence?: number };
        if (message.type !== "display.ack")
          sent.push(
            message.sequence === undefined ? message.type : `${message.type} ${message.sequence}`,
          );
        send(data);
      };
      return socket;
    },
    retryDelay: () => 60_000,
  });
  const picture = streams.retain(target);
  const frames: DisplayFrame[] = [];
  picture.onFrame((frame) => {
    frames.push(frame);
    frame.done();
  });
  const view = streams.retain(target);
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  expect(sent).toEqual([]);
  return {
    sent,
    streams,
    close() {
      view.release();
      picture.release();
    },
  };
}

it("asks for a picture for a joining view and resets input only for a view that holds it", async () => {
  const stream = await previewStream();
  // Two views join at once: the second rides the first one's keyframe request.
  const navigator = stream.streams.retain(target);
  const presser = stream.streams.retain(target);
  await vi.waitFor(() => expect(navigator.getSnapshot().input).toBe("available"));
  expect(navigator.input(1, [{ kind: "nav", to: "home" }])).toBe(true);
  // A Home press holds nothing, so leaving has nothing to release.
  navigator.release();
  expect(presser.input(1, [{ kind: "pointer", phase: "down", x: 0.5, y: 0.5, t: 1 }])).toBe(true);
  // A finger still down when its view leaves is released for the Host and the phone.
  presser.release();
  stream.close();
  expect(stream.sent).toEqual([
    "display.keyframe",
    "display.input 0",
    "display.input 1",
    "display.input-reset",
  ]);
});
