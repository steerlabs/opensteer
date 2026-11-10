import { expect, it, vi } from "vitest";
import * as bytes from "@opensteer/browser-core/bytes";
import frames from "../../browser-core/test-vectors/frames.v1.json" with { type: "json" };
import { BrowserRelayFrameHeaderSchema, encodeBrowserRelayFrame } from "./browser-relay.js";

it("views the portable relay encoder's fresh backing memory", () => {
  const frame = Buffer.from(frames.envelopeHex, "hex");
  const header = BrowserRelayFrameHeaderSchema.parse(frames.relayHeader);
  const encoded = bytes.encodeFrameEnvelope(header, frame);
  const encode = vi.spyOn(bytes, "encodeFrameEnvelope").mockReturnValueOnce(encoded);
  try {
    const envelope = encodeBrowserRelayFrame(header, frame);
    expect(envelope.buffer === encoded.buffer).toBe(true);
    expect(envelope.byteOffset).toBe(encoded.byteOffset);
    encoded[encoded.length - 1] = 42;
    expect(envelope.at(-1)).toBe(42);
  } finally {
    encode.mockRestore();
  }
});
