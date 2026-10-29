import { describe, expect, it } from "vitest";
import type { DisplayViewerFrameHeader } from "@opensteer/protocol";
import {
  DisplayTrace,
  annexBNals,
  assertSelfContainedKeyframe,
  displayRates,
  parseDragPath,
} from "./agent-phone-display.test-support.js";

// Failure inventory before implementation: missing/mixed start codes, empty or
// forbidden NALs, truncated SPS, missing/reordered parameter sets, wrong codec;
// duplicate/regressing sequence or generation, delta-first generations, media
// during protection or after lift with the old encoder; misleading rates from
// an empty window; and unordered/reversing device-received drag samples.
const key = Uint8Array.from([
  0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e, 0x80, 0, 0, 1, 0x68, 0xce, 0x80, 0, 0, 0, 1, 0x65, 0x88, 0x80,
]);
const delta = Uint8Array.from([0, 0, 1, 0x41, 0x80]);
const header = (overrides: Partial<DisplayViewerFrameHeader> = {}): DisplayViewerFrameHeader => ({
  generation: 1,
  sequence: 0,
  ptsUs: 10,
  key: true,
  codec: "avc1.42E01E",
  width: 720,
  height: 1280,
  ...overrides,
});

describe("Annex B acceptance evidence", () => {
  it("reads mixed start codes, subarrays, trailing zeros and SPS codec bytes", () => {
    const padded = Uint8Array.from([9, ...key, 0, 0, 9]);
    expect(annexBNals(padded.subarray(1, -1)).map((nal) => nal.type)).toEqual([7, 8, 5]);
    expect(assertSelfContainedKeyframe(header(), key)).toEqual([7, 8, 5]);
    expect(assertSelfContainedKeyframe(header({ codec: "avc1.42e01e" }), key)).toEqual([7, 8, 5]);
  });
  it.each([
    [],
    [0x67, 0x42],
    [0, 0, 1],
    [1, 0, 0, 1, 0x65],
    [0, 0, 1, 0, 0, 1, 0x65],
    [0, 0, 1, 0xe7, 0x42],
    [0, 0, 1, 0x60],
  ])("rejects malformed Annex B %j", (...bytes) => {
    expect(() => annexBNals(Uint8Array.from(bytes))).toThrow();
  });
  it("rejects absent/reordered SPS, PPS, IDR, truncated SPS and mismatched codec", () => {
    for (const payload of [
      delta,
      key.subarray(9),
      key.subarray(0, 15),
      Uint8Array.from([0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x68, 0x80, 0, 0, 1, 0x65, 0x80]),
      Uint8Array.from([...key.subarray(15), ...key.subarray(0, 15)]),
    ])
      expect(() => assertSelfContainedKeyframe(header(), payload)).toThrow();
    expect(() => assertSelfContainedKeyframe(header({ codec: "avc1.640028" }), key)).toThrow(
      /codec/,
    );
    expect(() => assertSelfContainedKeyframe(header({ key: false }), key)).toThrow();
  });
});

describe("display publication audit", () => {
  it("accepts increasing sequences across resets and measures the full window", () => {
    const trace = new DisplayTrace();
    trace.frame(header(), key, 100);
    trace.frame(header({ sequence: 1, key: false, codec: undefined }), delta, 200);
    trace.frame(header({ sequence: 2, generation: 2 }), key, 300);
    expect(displayRates(trace.frames, 0, 1000)).toMatchObject({
      frames: 3,
      fps: 3,
      payloadBytesPerSecond: 2 * key.byteLength + delta.byteLength,
      bytesPerSecond: trace.frames.reduce((sum, frame) => sum + frame.wireBytes, 0),
    });
    expect(displayRates(trace.frames, 100, 200).frames).toBe(1);
    expect(displayRates([], 0, 1000)).toMatchObject({ frames: 0, fps: 0, bytesPerSecond: 0 });
    expect(() => displayRates([], 1, 1)).toThrow();
  });
  it.each([
    { sequence: 0 },
    { sequence: 1, generation: 0 },
    { sequence: 1, generation: 2, key: false, codec: undefined },
  ])("rejects invalid sequence/generation %j", (overrides) => {
    const trace = new DisplayTrace();
    trace.frame(header(), key, 0);
    expect(() =>
      trace.frame(header(overrides), overrides.key === false ? delta : key, 1),
    ).toThrow();
  });
  it("rejects a delta as the first frame", () => {
    expect(() =>
      new DisplayTrace().frame(header({ key: false, codec: undefined }), delta, 0),
    ).toThrow();
  });
  it("rejects all protected media, then requires a new keyframe after lift", () => {
    const trace = new DisplayTrace();
    trace.frame(header(), key, 0);
    const state = {
      type: "display.state",
      state: "protected",
      generation: 1,
      width: 720,
      height: 1280,
    } as const;
    trace.message(state, 1);
    expect(() => trace.frame(header({ sequence: 1, generation: 2 }), key, 2)).toThrow(/protected/);
    trace.message({ ...state, state: "live", generation: 2 }, 3);
    expect(() => trace.frame(header({ sequence: 1 }), key, 4)).toThrow(/generation/);
    trace.frame(header({ sequence: 1, generation: 2 }), key, 5);
    expect(trace.frames).toHaveLength(2);
  });
});

describe("fixture drag path evidence", () => {
  it("accepts a received path moving forward in time and toward the target", () => {
    expect(
      parseDragPath(
        JSON.stringify([
          { x: 10, y: 20, t: 1 },
          { x: 12, y: 20, t: 50 },
          { x: 20, y: 20, t: 300 },
          { x: 30, y: 20, t: 501 },
        ]),
        { x: 10, y: 20 },
        { x: 30, y: 20 },
      ),
    ).toHaveLength(4);
  });
  it("measures the moves, not the hold before Android's long press", () => {
    expect(
      parseDragPath(
        JSON.stringify([
          { x: 10, y: 20, t: 1 },
          { x: 12, y: 20, t: 1_811 },
          { x: 20, y: 20, t: 2_050 },
          { x: 30, y: 20, t: 2_313 },
        ]),
        { x: 10, y: 20 },
        { x: 30, y: 20 },
      ),
    ).toHaveLength(4);
  });
  it.each([
    [],
    [{ x: 10, y: 20, t: 1 }],
    [
      { x: 10, y: 20, t: 2 },
      { x: 15, y: 20, t: 1 },
      { x: 30, y: 20, t: 501 },
    ],
    [
      { x: 10, y: 20, t: 1 },
      { x: 30, y: 20, t: 250 },
      { x: 15, y: 20, t: 501 },
    ],
    // A jump to the target after a long hold was not streamed.
    [
      { x: 10, y: 20, t: 1 },
      { x: 29, y: 20, t: 1_800 },
      { x: 30, y: 20, t: 1_810 },
    ],
  ])("rejects incomplete, nonmonotonic or unstreamed paths %j", (...points) => {
    expect(() =>
      parseDragPath(JSON.stringify(points), { x: 10, y: 20 }, { x: 30, y: 20 }),
    ).toThrow();
  });
});
