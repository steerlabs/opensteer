import { describe, expect, it } from "vitest";
import { decodeNativeEvent, nativeInstruction } from "../src/events.js";

describe("native editing boundary", () => {
  it("decodes ordered native composition snapshots without losing UTF-16 offsets", () => {
    expect(
      decodeNativeEvent({
        id: 4,
        event: {
          type: "compositionupdate",
          data: "👩‍💻",
          proxy: { value: "a👩‍💻", selectionStart: 6, selectionEnd: 6 },
        },
      }),
    ).toEqual({
      id: 4,
      event: {
        type: "compositionupdate",
        data: "👩‍💻",
        proxy: { value: "a👩‍💻", selectionStart: 6, selectionEnd: 6 },
      },
    });
  });
  it("rejects malformed state, keys and clipboard bounds at the native boundary", () => {
    expect(() =>
      decodeNativeEvent({
        id: 1,
        event: { type: "selection", proxy: { value: "a", selectionStart: 2, selectionEnd: 2 } },
      }),
    ).toThrow();
    expect(() => decodeNativeEvent({ id: 1, event: { type: "keydown", key: "a" } })).toThrow();
    expect(() =>
      decodeNativeEvent({
        id: 1,
        event: { type: "paste", items: [{ type: "text/plain", data: "???" }] },
      }),
    ).toThrow();
  });
  it("transfers clipboard bytes and preserves formats", () => {
    expect(
      decodeNativeEvent({
        id: 1,
        event: {
          type: "paste",
          items: [
            { type: "text/plain", data: "aGk=" },
            { type: "text/html", data: "PGI+aGk8L2I+" },
          ],
        },
      }).event,
    ).toEqual({
      type: "paste",
      items: [
        { type: "text/plain", bytes: new TextEncoder().encode("hi") },
        { type: "text/html", bytes: new TextEncoder().encode("<b>hi</b>") },
      ],
    });
  });
  it("does not turn an acknowledgement into an unsolicited reset", () => {
    expect(nativeInstruction(12, { preventDefault: true })).toEqual({
      id: 12,
      preventDefault: true,
    });
    expect(
      nativeInstruction(13, { set: { value: "", selectionStart: 0, selectionEnd: 0 } }),
    ).toEqual({ id: 13, set: { value: "", selectionStart: 0, selectionEnd: 0 } });
  });
});
