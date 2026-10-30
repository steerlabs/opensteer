import { describe, expect, it } from "vitest";
import {
  DisplayDataTicketClaimsSchema,
  DisplayDataServerMessageSchema,
  DisplayInputEventsSchema,
  DisplayMediaFrameHeaderSchema,
  DisplayStreamIdSchema,
  DisplayViewerClientMessageSchema,
  DisplayViewerFrameHeaderSchema,
  DisplayViewerServerMessageSchema,
  decodeDisplayMediaFrame,
  decodeDisplayViewerFrame,
  displayMaxFramePayloadBytes,
  displayMaxHeaderBytes,
  encodeDisplayMediaFrame,
  encodeDisplayViewerFrame,
  DisplayViewerStateSchema,
  DisplayInputResultSchema,
  LegacyDisplayViewerControlSchema,
  displayViewerCloseCodes,
  isRetryableDisplayViewerClose,
} from "./display-stream.js";
import {
  HostToIntegrationsModuleMessageSchema,
  IntegrationsModuleEventSchema,
} from "./computer-apps.js";

// Failure cases: unknown fields or bad IDs/fences; unsafe, fractional or out-of-range
// numbers; mixed text variants; empty/oversize batches; key/codec mismatch; broken
// byte order, UTF-8 or JSON; truncated/oversize envelopes; empty/oversize payloads.
const streamId = "dsp_11111111-1111-4111-8111-111111111111";
const legacyControlId = "dcl_22222222-2222-4222-8222-222222222222";
const sessionId = "cus_33333333-3333-4333-8333-333333333333";
const fence = {
  auxiliaryStreamId: "rax_11111111-1111-4111-8111-111111111111",
  bootId: "rbt_11111111-1111-4111-8111-111111111111",
  connectionGeneration: 3,
  connectionId: "rcn_11111111-1111-4111-8111-111111111111",
  connectionLeaseId: "rls_11111111-1111-4111-8111-111111111111",
  module: "integrations",
  runnerId: "rnr_11111111-1111-4111-8111-111111111111",
};
const viewerKey = {
  generation: 1,
  sequence: 0,
  ptsUs: 123_456,
  key: true,
  codec: "avc1.42C01F",
  width: 720,
  height: 1280,
};
const mediaKey = { streamId, ...viewerKey };
const delta = { generation: 1, sequence: 1, ptsUs: 156_789, key: false, width: 720, height: 1280 };
const pointer = { kind: "pointer", phase: "down", x: 0, y: 1, t: 1.25 };
const input = { geometry: 1, sequence: 0, events: [pointer] };

function envelope(header: unknown, payload = new Uint8Array([0, 0, 0, 1, 0x41])) {
  const bytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + bytes.length + payload.length);
  new DataView(frame.buffer).setUint32(0, bytes.length, false);
  frame.set(bytes, 4);
  frame.set(payload, 4 + bytes.length);
  return frame;
}

describe("display identities and data ticket", () => {
  it("requires the complete integrations fence and distinct ticket purpose", () => {
    expect(DisplayStreamIdSchema.parse(streamId)).toBe(streamId);
    expect(DisplayStreamIdSchema.safeParse(legacyControlId).success).toBe(false);
    const claims = {
      ...fence,
      display: "main",
      streamId,
      audience: "opensteer-display-data",
      type: "opensteer.display.data-ticket",
      issuedAt: "2026-10-19T12:00:00.000Z",
      expiresAt: "2026-10-19T12:01:00.000Z",
      nonce: "A".repeat(43),
    };
    expect(DisplayDataTicketClaimsSchema.parse(claims)).toEqual(claims);
    for (const change of [
      { module: "shell" },
      { audience: "opensteer-shell-data" },
      { type: "opensteer.shell.data-ticket" },
      { connectionId: undefined },
      { streamId: undefined },
      { nonce: "short" },
      { extra: true },
    ])
      expect(DisplayDataTicketClaimsSchema.safeParse({ ...claims, ...change }).success).toBe(false);
  });
});

describe("display media and viewer envelopes", () => {
  it("round trips keyframes and delta frames without changing payload bytes", () => {
    const payload = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 0x88,
    ]);
    for (const header of [mediaKey, { streamId, ...delta }]) {
      const parsed = DisplayMediaFrameHeaderSchema.parse(header);
      const encoded = encodeDisplayMediaFrame(parsed, payload);
      expect(new DataView(encoded.buffer, encoded.byteOffset).getUint32(0, false)).toBe(
        new TextEncoder().encode(JSON.stringify(parsed)).length,
      );
      expect(decodeDisplayMediaFrame(encoded)).toEqual({ header: parsed, payload });
      const offset = new Uint8Array(encoded.length + 7);
      offset.set(encoded, 7);
      expect(decodeDisplayMediaFrame(offset.subarray(7))).toEqual({ header: parsed, payload });
    }
    for (const header of [viewerKey, delta]) {
      const parsed = DisplayViewerFrameHeaderSchema.parse(header);
      expect(decodeDisplayViewerFrame(encodeDisplayViewerFrame(parsed, payload))).toEqual({
        header: parsed,
        payload,
      });
    }
  });

  it("couples codec to keyframes and rejects unknown or invalid header fields", () => {
    for (const change of [
      { codec: undefined },
      { codec: "h264" },
      { codec: "avc1.12345G" },
      { generation: 0 },
      { generation: 1.5 },
      { sequence: -1 },
      { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ptsUs: -1 },
      { width: 0 },
      { height: 2.5 },
      { extra: true },
    ]) {
      expect(DisplayMediaFrameHeaderSchema.safeParse({ ...mediaKey, ...change }).success).toBe(
        false,
      );
      expect(DisplayViewerFrameHeaderSchema.safeParse({ ...viewerKey, ...change }).success).toBe(
        false,
      );
    }
    expect(
      DisplayMediaFrameHeaderSchema.safeParse({ streamId, ...delta, codec: "avc1.42C01F" }).success,
    ).toBe(false);
    expect(
      DisplayViewerFrameHeaderSchema.safeParse({ ...delta, codec: "avc1.42C01F" }).success,
    ).toBe(false);
    expect(DisplayViewerFrameHeaderSchema.safeParse(mediaKey).success).toBe(false);
  });

  it("rejects malformed framing, headers and size overflow on both sockets", () => {
    for (const [encode, decode, header] of [
      [
        encodeDisplayViewerFrame,
        decodeDisplayViewerFrame,
        DisplayViewerFrameHeaderSchema.parse(viewerKey),
      ],
    ] as const) {
      expect(() => encode(header, new Uint8Array())).toThrow();
      expect(() => encode(header, new Uint8Array(displayMaxFramePayloadBytes + 1))).toThrow();
      expect(
        decode(encode(header, new Uint8Array(displayMaxFramePayloadBytes))).payload.length,
      ).toBe(displayMaxFramePayloadBytes);
    }
    expect(() =>
      encodeDisplayMediaFrame(DisplayMediaFrameHeaderSchema.parse(mediaKey), new Uint8Array()),
    ).toThrow();
    expect(() =>
      encodeDisplayMediaFrame(
        DisplayMediaFrameHeaderSchema.parse(mediaKey),
        new Uint8Array(displayMaxFramePayloadBytes + 1),
      ),
    ).toThrow();
    for (const decode of [decodeDisplayMediaFrame, decodeDisplayViewerFrame]) {
      const hugeHeader = new Uint8Array(4 + displayMaxHeaderBytes + 1);
      new DataView(hugeHeader.buffer).setUint32(0, displayMaxHeaderBytes + 1, false);
      const badUtf8 = new Uint8Array([0, 0, 0, 3, 0x22, 0xff, 0x22, 1]);
      for (const bad of [
        new Uint8Array(),
        new Uint8Array([0, 0, 0]),
        hugeHeader,
        new Uint8Array([0, 0, 0, 100, 123, 125, 1]),
        new Uint8Array([0, 0, 0, 2, 123, 125]),
        badUtf8,
        new Uint8Array([0, 0, 0, 2, 123, 33, 1]),
        envelope({ ...viewerKey, extra: true }),
        envelope(viewerKey, new Uint8Array(displayMaxFramePayloadBytes + 1)),
      ])
        expect(() => decode(bad)).toThrow();
    }
  });
});

describe("display input and socket messages", () => {
  it("accepts all strict input variants and boundary values", () => {
    const events = [
      pointer,
      { ...pointer, phase: "move" },
      { ...pointer, phase: "up" },
      { ...pointer, phase: "cancel" },
      { kind: "scroll", x: 0.5, y: 0.5, dx: -1, dy: 1 },
      ...["back", "home", "recents", "notifications"].map((to) => ({ kind: "nav", to })),
      { kind: "text", insert: "x".repeat(1000) },
      { kind: "text", deleteBackward: 100 },
      { kind: "text", submit: true },
    ];
    expect(DisplayInputEventsSchema.parse(events)).toEqual(events);
    expect(DisplayInputEventsSchema.parse(Array.from({ length: 64 }, () => pointer))).toHaveLength(
      64,
    );
    expect(DisplayViewerClientMessageSchema.parse({ type: "display.input", ...input })).toEqual({
      type: "display.input",
      ...input,
    });
  });

  it("rejects mixed text, unknown fields, unbounded input and empty batches", () => {
    for (const event of [
      { ...pointer, x: -0.1 },
      { ...pointer, y: 1.01 },
      { ...pointer, t: -1 },
      { ...pointer, t: Infinity },
      { ...pointer, extra: 1 },
      { ...pointer, t: undefined },
      { kind: "scroll", x: 0, y: 0, dx: 1.01, dy: 0 },
      { kind: "scroll", x: 0, y: 0, dx: 0, dy: -1.01 },
      { kind: "text", insert: "" },
      { kind: "text", insert: "x".repeat(1001) },
      { kind: "text", deleteBackward: 0 },
      { kind: "text", deleteBackward: 101 },
      { kind: "text", deleteBackward: 1.5 },
      { kind: "text", submit: false },
      { kind: "text", insert: "x", submit: true },
      { kind: "nav", to: "quickSettings" },
    ])
      expect(DisplayInputEventsSchema.safeParse([event]).success).toBe(false);
    for (const events of [[], Array.from({ length: 65 }, () => pointer)])
      expect(DisplayInputEventsSchema.safeParse(events).success).toBe(false);
    for (const change of [
      { geometry: 0 },
      { geometry: 1.5 },
      { sequence: -1 },
      { sequence: 0.5 },
      { extra: true },
    ])
      expect(
        DisplayViewerClientMessageSchema.safeParse({ type: "display.input", ...input, ...change })
          .success,
      ).toBe(false);
  });

  it("reads a previous-release viewer's Take over traffic without applying it", () => {
    // Launch-release clients still send these; the socket must keep parsing them.
    for (const action of ["acquire", "release"])
      expect(DisplayViewerClientMessageSchema.parse({ type: "display.control", action })).toEqual({
        type: "display.control",
        action,
      });
    const legacy = { type: "display.input", ...input, controlId: legacyControlId };
    expect(DisplayViewerClientMessageSchema.parse(legacy)).toEqual(legacy);
    expect(
      DisplayViewerClientMessageSchema.safeParse({ ...legacy, controlId: "dcl_invalid" }).success,
    ).toBe(false);
    // Its one answer is a refusal whose reason that release shows no words for.
    const refusal = { type: "display.control", state: "refused", reason: "released-by-owner" };
    expect(LegacyDisplayViewerControlSchema.parse(refusal)).toEqual(refusal);
    for (const state of ["held", "released", "busy"])
      expect(LegacyDisplayViewerControlSchema.safeParse({ ...refusal, state }).success).toBe(false);
    // Current viewers never receive a control message.
    expect(DisplayViewerServerMessageSchema.safeParse(refusal).success).toBe(false);
  });

  it("accepts only a bare input reset from a viewer", () => {
    expect(DisplayViewerClientMessageSchema.parse({ type: "display.input-reset" })).toEqual({
      type: "display.input-reset",
    });
    expect(
      DisplayViewerClientMessageSchema.safeParse({ type: "display.input-reset", sequence: 1 })
        .success,
    ).toBe(false);
  });

  it("projects shared input and names why a batch was refused", () => {
    const state = { type: "display.state", state: "live", generation: 1, width: 720, height: 1280 };
    expect(DisplayViewerStateSchema.parse({ ...state, sharedInput: 1 }).sharedInput).toBe(1);
    expect(DisplayViewerStateSchema.parse(state).sharedInput).toBeUndefined();
    expect(DisplayViewerStateSchema.safeParse({ ...state, sharedInput: 2 }).success).toBe(false);
    for (const reason of ["unavailable", "contended", "stale", "unsupported", "too-large"])
      expect(
        DisplayInputResultSchema.safeParse({
          type: "display.input.result",
          sequence: 0,
          outcome: "refused",
          reason,
        }).success,
      ).toBe(true);
    expect(
      DisplayInputResultSchema.safeParse({
        type: "display.input.result",
        sequence: 0,
        outcome: "refused",
        reason: "not-held",
      }).success,
    ).toBe(false);
  });

  it("pins the data ack and viewer JSON directions", () => {
    const ack = { type: "display.ack", sequence: 0 };
    expect(DisplayDataServerMessageSchema.parse(ack)).toEqual(ack);
    expect(DisplayViewerClientMessageSchema.parse(ack)).toEqual(ack);
    expect(DisplayDataServerMessageSchema.safeParse({ type: "ack", sequence: 0 }).success).toBe(
      false,
    );
    expect(DisplayViewerClientMessageSchema.safeParse({ ...ack, extra: 1 }).success).toBe(false);
    for (const state of [
      "starting",
      "live",
      "protected",
      "screen-off",
      "stopped",
      "failed",
      "unsupported",
    ])
      expect(
        DisplayViewerServerMessageSchema.safeParse({
          type: "display.state",
          state,
          generation: 0,
          width: 0,
          height: 0,
        }).success,
      ).toBe(true);
    expect(DisplayViewerServerMessageSchema.safeParse(ack).success).toBe(false);
  });
});

describe("display integrations frames and capability", () => {
  it("parses every new frame with the existing fence and rejects unknown fields", () => {
    const common = { ...fence, streamId };
    const frames = [
      {
        ...common,
        streamId,
        type: "host.integrations.display.start",
        display: "main",
        revision: 0,
        sources: [{ kind: "task-session", sessionId }],
        dataTicket: "eyJhbGciOiJFZERTQSJ9.eyJ4IjoxfQ.c2ln",
        maxLongSide: 1280,
        maxFps: 30,
      },
      { ...common, display: "main", type: "host.integrations.display.stop" },
      { ...common, display: "main", type: "host.integrations.display.refresh" },
      { ...common, sessionId, ...input, type: "host.integrations.display.input" },
      { ...common, sessionId, type: "host.integrations.display.input-reset" },
    ];
    for (const frame of frames) {
      expect(HostToIntegrationsModuleMessageSchema.parse(frame)).toEqual(frame);
      expect(
        HostToIntegrationsModuleMessageSchema.safeParse({ ...frame, extra: true }).success,
      ).toBe(false);
      expect(
        HostToIntegrationsModuleMessageSchema.safeParse({ ...frame, module: "shell" }).success,
      ).toBe(false);
    }
    expect(
      HostToIntegrationsModuleMessageSchema.parse({ ...frames[0], sharedInput: 1 }),
    ).toMatchObject({ sharedInput: 1 });
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({ ...frames[0], sharedInput: 2 }).success,
    ).toBe(false);
    // Input names no control: the Host never issues one.
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({
        ...frames[3],
        controlId: legacyControlId,
      }).success,
    ).toBe(false);
    for (const type of ["host.integrations.display.control", "host.integrations.mac-owner.control"])
      expect(
        HostToIntegrationsModuleMessageSchema.safeParse({
          ...common,
          sessionId,
          controlId: legacyControlId,
          type,
          action: "acquire",
        }).success,
      ).toBe(false);
    for (const change of [
      { maxLongSide: 319 },
      { maxLongSide: 1921 },
      { maxFps: 0 },
      { maxFps: 61 },
      { maxFps: 2.5 },
    ])
      expect(
        HostToIntegrationsModuleMessageSchema.safeParse({ ...frames[0], ...change }).success,
      ).toBe(false);
    const state = {
      ...common,
      streamId,
      type: "runner.integrations.display.state",
      display: "main",
      state: "live",
      generation: 1,
      width: 720,
      height: 1280,
      rotation: 0,
    };
    const result = {
      ...common,
      sessionId,
      geometry: 1,
      sequence: 4,
      outcome: "dispatched",
      type: "runner.integrations.display.input-result",
    };
    for (const frame of [state, result]) {
      expect(IntegrationsModuleEventSchema.parse(frame)).toEqual(frame);
      expect(IntegrationsModuleEventSchema.safeParse({ ...frame, extra: true }).success).toBe(
        false,
      );
      expect(
        IntegrationsModuleEventSchema.safeParse({ ...frame, streamId: undefined }).success,
      ).toBe(false);
      expect(
        IntegrationsModuleEventSchema.safeParse({ ...frame, reason: "anything" }).success,
      ).toBe(false);
    }
    expect(
      IntegrationsModuleEventSchema.safeParse({ ...state, state: "unsupported" }).success,
    ).toBe(false);
    expect(IntegrationsModuleEventSchema.safeParse({ ...state, rotation: 45 }).success).toBe(false);
    expect(
      IntegrationsModuleEventSchema.safeParse({ ...result, controlId: legacyControlId }).success,
    ).toBe(false);
    expect(
      IntegrationsModuleEventSchema.safeParse({
        ...common,
        controlId: legacyControlId,
        type: "runner.integrations.display.control-state",
        sessionId,
        state: "held",
      }).success,
    ).toBe(false);
  });
});

describe("display viewer recovery and close contract", () => {
  it("accepts only a bare keyframe request from a viewer", () => {
    expect(DisplayViewerClientMessageSchema.parse({ type: "display.keyframe" })).toEqual({
      type: "display.keyframe",
    });
    expect(() =>
      DisplayViewerClientMessageSchema.parse({ type: "display.keyframe", sequence: 3 }),
    ).toThrow();
  });

  it("bounds the replay marker to a stream sequence", () => {
    const state = { type: "display.state", state: "live", generation: 2, width: 592, height: 1280 };
    expect(DisplayViewerStateSchema.parse({ ...state, replayThrough: 41 }).replayThrough).toBe(41);
    expect(DisplayViewerStateSchema.parse(state).replayThrough).toBeUndefined();
    expect(() => DisplayViewerStateSchema.parse({ ...state, replayThrough: -1 })).toThrow();
    expect(() => DisplayViewerStateSchema.parse({ ...state, replayThrough: 1.5 })).toThrow();
  });

  it("retries only transient closes", () => {
    const retryable = Object.entries(displayViewerCloseCodes)
      .filter(([, code]) => isRetryableDisplayViewerClose(code))
      .map(([name]) => name)
      .sort();
    expect(retryable).toEqual(["hostShutdown", "loginEnded", "tryAgain"]);
    for (const transport of [1005, 1006, 1011, 1012]) {
      expect(isRetryableDisplayViewerClose(transport)).toBe(true);
    }
    expect(isRetryableDisplayViewerClose(4999)).toBe(false);
  });
});
