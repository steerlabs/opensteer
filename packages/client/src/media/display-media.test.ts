import { expect, it, vi } from "vitest";
import { MediaReceiver, type MediaFrame } from "./display-media.js";
it("returns decoder credit exactly once in receive order without confusing presentation", () => {
  const ack = vi.fn();
  const receiver = new MediaReceiver(ack);
  const delivered: MediaFrame[] = [];
  const header = {
    generation: 1,
    sequence: 1,
    ptsUs: 1,
    key: true,
    codec: "avc1.420015",
    width: 128,
    height: 128,
  };
  receiver.receive(1, header, new Uint8Array(5), false, [(f) => delivered.push(f)]);
  receiver.receive(1, { ...header, sequence: 2 }, new Uint8Array(5), false, [
    (f) => delivered.push(f),
  ]);
  delivered[1]!.done();
  expect(ack).not.toHaveBeenCalled();
  delivered[0]!.done();
  delivered[0]!.done();
  expect(ack.mock.calls).toEqual([[1], [2]]);
  receiver.close();
});
