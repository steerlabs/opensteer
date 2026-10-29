import { describe, expect, it } from "vitest";
import { heldRunCapture } from "./run-grants.test-support.js";

describe("heldRunCapture", () => {
  const marker = "held-run-this";
  const url = (port: number) => `http://127.0.0.1:${port}/prefix-${port}/agent-tools`;
  const engineProcess = (pid: number, port: number) =>
    JSON.stringify({
      captureProcessId: pid,
      fakeCodexProcess: { argv: [`-c url="${url(port)}"`] },
    });
  const token = (pid: number, value?: string) =>
    JSON.stringify({
      captureProcessId: pid,
      fakeOpensteerTokens: value ? { agentTools: value } : {},
    });
  const turn = (pid: number, text: string) =>
    JSON.stringify({ captureProcessId: pid, method: "turn/start", params: { input: [{ text }] } });
  const capture = (...rows: readonly string[]) => rows.join("\n") + "\n";

  it("keeps the marked engine's token after a later title process and an unrelated Run", () => {
    expect(
      heldRunCapture(
        capture(
          token(1),
          token(2),
          engineProcess(3, 4001),
          token(3, "engine-token"),
          turn(3, `Keep working ${marker}`),
          engineProcess(4, 4001),
          token(4),
          turn(4, `Name this: Keep working ${marker}`),
          engineProcess(5, 4002),
          token(5, "unrelated"),
          turn(5, "Keep working held-run-other"),
        ),
        marker,
      ),
    ).toEqual({ token: "engine-token", url: url(4001) });
  });

  it.each([
    {
      name: "an earlier Run's engine",
      rows: [engineProcess(3, 4001), token(3, "earlier"), turn(3, "Keep working held-run-earlier")],
    },
    {
      name: "an unrelated Run whose rows arrive later",
      rows: [
        engineProcess(3, 4001),
        token(3, "this"),
        engineProcess(5, 4002),
        token(5, "unrelated"),
        turn(5, "Keep working held-run-other"),
      ],
    },
    {
      name: "a token and URL on different processes",
      rows: [engineProcess(3, 4001), turn(3, marker), token(4, "split"), turn(4, marker)],
    },
    {
      name: "two engines claiming the marked Run",
      rows: [
        engineProcess(3, 4001),
        token(3, "first"),
        turn(3, marker),
        engineProcess(4, 4002),
        token(4, "second"),
        turn(4, marker),
      ],
    },
    { name: "no engine at all", rows: [token(1), token(2)] },
    {
      name: "a marked engine without a token",
      rows: [engineProcess(3, 4001), token(3), turn(3, marker)],
    },
    {
      name: "a marked engine without a URL",
      rows: [JSON.stringify({ captureProcessId: 3 }), token(3, "no-url"), turn(3, marker)],
    },
    {
      name: "a marked engine with two URLs",
      rows: [engineProcess(3, 4001), engineProcess(3, 4002), token(3, "two-urls"), turn(3, marker)],
    },
  ])("refuses $name", ({ rows }) => {
    expect(heldRunCapture(capture(...rows), marker)).toBeUndefined();
  });
});
