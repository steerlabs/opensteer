import { describe, expect, it } from "vitest";
import {
  BrowserSourceHostMessageV4Schema,
  negotiateWire,
  parseWireQuery,
  readClientMessage,
  readHostMessage,
} from "./index.js";

const nonce = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const sourceId = "bsr_88888888-8888-4888-8888-888888888888";
const signature = "A".repeat(86);
const frame = (value: unknown) => JSON.stringify(value);

describe("wire negotiation", () => {
  it.each([
    ["", { kind: "absent" }],
    ["wire=5", { kind: "valid", wire: 5 }],
    ["wire=9007199254740991", { kind: "valid", wire: Number.MAX_SAFE_INTEGER }],
    ["wire=9007199254740992", { kind: "invalid" }],
    ["wire=5&wire=5", { kind: "invalid" }],
    ["wire=0", { kind: "invalid" }],
    ["wire=05", { kind: "invalid" }],
    ["wire=-5", { kind: "invalid" }],
    ["wire=5.0", { kind: "invalid" }],
    ["wire=1e3", { kind: "invalid" }],
    ["wire=", { kind: "invalid" }],
    ["wire=%205", { kind: "invalid" }],
  ])("reads %j", (query, expected) => {
    expect(parseWireQuery(new URLSearchParams(query))).toEqual(expected);
  });

  it("speaks wire 4 to a peer that states none and caps a newer peer at current", () => {
    expect(negotiateWire(null)).toEqual({ kind: "negotiated", wire: 4 });
    expect(negotiateWire(5)).toEqual({ kind: "negotiated", wire: 5 });
    expect(negotiateWire(99)).toEqual({ kind: "negotiated", wire: 5 });
    expect(negotiateWire(3)).toEqual({ kind: "below-floor", supportedVersion: 4 });
  });
});

describe("tolerant readers", () => {
  it("strips unknown fields and ignores unknown types", () => {
    expect(
      readHostMessage(
        frame({ type: "source.export", operationId, site: "https://github.com", x: 1 }),
      ),
    ).toEqual({ type: "source.export", operationId, site: "https://github.com" });
    expect(readHostMessage(frame({ type: "source.future", anything: true }))).toEqual({
      type: "unknown",
    });
    expect(readClientMessage(frame({ type: "source.future" }))).toEqual({ type: "unknown" });
  });

  it("reads a v5 proof's wire, which a wire-4 peer refuses", () => {
    const proof = { type: "source.proof", nonce, signature, wire: 5 };
    expect(readHostMessage(frame(proof))).toEqual(proof);
    expect(BrowserSourceHostMessageV4Schema.safeParse(proof).success).toBe(false);
    expect(readHostMessage(frame({ ...proof, wire: 0 }))).toBeNull();
  });

  it("reads an unknown status as unsupported", () => {
    expect(
      readClientMessage(frame({ type: "source.inspect.result", operationId, status: "later" })),
    ).toEqual({ type: "source.inspect.result", operationId, status: "unsupported" });
    expect(
      readClientMessage(
        frame({ type: "source.export.result", operationId, result: { status: "later" } }),
      ),
    ).toEqual({ type: "source.export.result", operationId, result: { status: "unsupported" } });
    expect(
      readClientMessage(
        frame({ type: "source.export.result", operationId, result: { status: "available" } }),
      ),
    ).toBeNull();
  });

  it("keeps signed and scoped fields exact", () => {
    expect(readHostMessage("{")).toBeNull();
    expect(readHostMessage(frame(["ping"]))).toBeNull();
    expect(readHostMessage(frame({ type: "ping", nonce: "not-a-nonce" }))).toBeNull();
    expect(
      readHostMessage(frame({ type: "source.proof", nonce, signature: signature.slice(1) })),
    ).toBeNull();
    expect(
      readHostMessage(
        frame({ type: "source.inspect", operationId, site: "https://gist.github.com/x" }),
      ),
    ).toBeNull();
    expect(
      readClientMessage(
        frame({
          type: "source.challenge",
          origin: "http://example.com",
          routeGeneration: null,
          sourceId,
          nonce,
        }),
      ),
    ).toBeNull();
    expect(
      readClientMessage(
        frame({
          type: "source.export.result",
          operationId,
          result: { status: "exported", snapshot: { cookies: [], origins: [], extra: true } },
        }),
      ),
    ).toBeNull();
    expect(
      readClientMessage(frame({ type: "source.hello", sourceId, token: "short", version: 5 })),
    ).toBeNull();
  });
});
