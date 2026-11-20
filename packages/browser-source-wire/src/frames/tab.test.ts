import { expect, it } from "vitest";
import {
  BrowserSourceClientMessageV4Schema,
  BrowserSourceHostMessageV4Schema,
  BrowserSourceTabAssembly,
  browserSourceTabFrameBytes,
  browserSourceTabMessageBytes,
  browserSourceTabParts,
  browserSourceTabWire,
  maxBrowserSourceFrameBytes,
  negotiateWire,
  readClientMessage,
  readHostMessage,
} from "./index.js";

it("negotiates live-tab traffic only on wire 6 while wire 4 stays frozen", () => {
  const shared = JSON.stringify({
    type: "tab.shared",
    shareId: crypto.randomUUID(),
    targetId: "chrome-target",
    title: "Fixture",
    url: "https://example.com/",
  });
  const command = JSON.stringify({ type: "tab.command", offset: 0, data: "e30=", last: true });
  const oldHomeWire = Math.min(browserSourceTabWire, 5);
  expect(readClientMessage(shared, oldHomeWire)).toEqual({ type: "unknown" });
  expect(readHostMessage(command, oldHomeWire)).toEqual({ type: "unknown" });
  expect(BrowserSourceClientMessageV4Schema.safeParse(JSON.parse(shared)).success).toBe(false);
  expect(BrowserSourceHostMessageV4Schema.safeParse(JSON.parse(command)).success).toBe(false);
  expect(negotiateWire(5)).toEqual({ kind: "negotiated", wire: 5 });
  expect(negotiateWire(6)).toEqual({ kind: "negotiated", wire: 6 });
  expect(readHostMessage(command, 6)).toMatchObject({ type: "tab.command" });
  expect(readClientMessage(shared, 6)).toMatchObject({ type: "tab.shared" });
});

it("reassembles exact large UTF-8 messages under the existing outer frame cap", () => {
  const message = { result: { value: "aa🙂".repeat(450_000) } };
  const frames = [...browserSourceTabParts("tab.result", Buffer.from(JSON.stringify(message)))];
  expect(frames.length).toBeGreaterThan(2);
  const assembly = new BrowserSourceTabAssembly();
  for (const part of frames.slice(0, -1)) {
    expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThan(browserSourceTabFrameBytes);
    expect(assembly.read(part)).toBeUndefined();
  }
  expect(browserSourceTabFrameBytes).toBeLessThan(maxBrowserSourceFrameBytes);
  expect(assembly.read(frames.at(-1)!)).toEqual(message);
  expect(() => [
    ...browserSourceTabParts("tab.result", new Uint8Array(browserSourceTabMessageBytes + 1)),
  ]).toThrow("limit");
  expect(() => new BrowserSourceTabAssembly().read(frames[1]!)).toThrow("parts");
});
