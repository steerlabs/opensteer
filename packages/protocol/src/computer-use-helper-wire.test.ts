import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ComputerUseHelloResultSchema,
  ComputerUseHelperErrorSchema,
  ComputerUseHelperEventSchema,
  ComputerUseHelperMethodSchema,
  ComputerUseHelperRequestSchema,
  computerUseHelperProtocolVersion,
  computerUseHelperResults,
} from "./computer-use.js";

/**
 * The helper's side of the wire, as the helper itself encodes it.
 *
 * `helper-wire.json` is written by the Swift package's own test from its real
 * result types, so this test is the two ends of the socket agreeing: the Swift
 * side that the file is what it sends, this side that every entry is what the
 * schemas accept. A shape change on either end fails exactly one of the two.
 */
const fixturePath = path.resolve(
  import.meta.dirname,
  "../../../apps/desktop/native/computer-use/Tests/Fixtures/helper-wire.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  readonly error: unknown;
  readonly events: Readonly<Record<string, unknown>>;
  readonly requests: Readonly<Record<string, unknown>>;
  readonly results: Readonly<Record<string, unknown>>;
};

describe("helper wire fixture", () => {
  it("covers every method the helper answers", () => {
    const methods = ComputerUseHelperMethodSchema.options;
    expect(Object.keys(fixture.results).sort()).toEqual([...methods].sort());
  });

  it.each(Object.entries(fixture.results))("%s result matches its schema", (method, result) => {
    const schema = computerUseHelperResults[method as keyof typeof computerUseHelperResults];
    const parsed = schema.safeParse(result);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("speaks the protocol version this package declares", () => {
    const hello = ComputerUseHelloResultSchema.parse(fixture.results.hello);
    expect(hello.protocolVersion).toBe(computerUseHelperProtocolVersion);
    expect(hello.minProtocolVersion).toBe(10);
    expect(hello.routes?.windowGroups).toBe(true);
  });

  it("parses every request the helper reads, each under its own method", () => {
    expect(Object.keys(fixture.requests).sort()).toEqual([
      "data.invoke",
      "data.request",
      "display.attach",
      "display.control",
      "display.demand",
      "display.input",
      "display.refresh",
      "display.resolve",
      "display.start",
      "display.stop",
      "imessage.poll",
      "imessage.send",
      "permissions.request",
      "session.act",
      "session.bind",
      "session.observe",
      "session.open",
      "session.windows",
      "view.open",
      "view.windows",
    ]);
    for (const [method, request] of Object.entries(fixture.requests)) {
      const parsed = ComputerUseHelperRequestSchema.safeParse(request);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.data?.method).toBe(method);
    }
    const act = ComputerUseHelperRequestSchema.parse(fixture.requests["session.act"]);
    if (act.method !== "session.act") throw new Error("expected session.act");
    expect(act.timeoutMs).toEqual(expect.any(Number));
    expect(act.params.app.access).toBe("read-write");
    expect(act.params.actions[0]).toMatchObject({ target: { index: 4 }, type: "type" });
  });

  it("covers every event, and each matches the event schema", () => {
    expect(Object.keys(fixture.events).sort()).toEqual([
      "display.owner-input",
      "display.source-changed",
      "display.source-ended",
      "display.state",
      "session.stopped",
    ]);
    // The fixture keeps each event's params under its name; the envelope on
    // the wire is `{event, params}`.
    for (const [event, params] of Object.entries(fixture.events)) {
      const parsed = ComputerUseHelperEventSchema.safeParse({ event, params });
      expect(parsed.error?.issues ?? []).toEqual([]);
    }
  });

  it("uses the error envelope", () => {
    const parsed = ComputerUseHelperErrorSchema.safeParse(fixture.error);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });
});
