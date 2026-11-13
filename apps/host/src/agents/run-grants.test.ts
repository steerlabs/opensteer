import { describe, expect, it } from "vitest";
import { heldRunCapture } from "./run-grants.test-support.js";

describe("heldRunCapture", () => {
  const marker = "held-run-this";
  const url = (port: number) => `http://127.0.0.1:${port}/prefix-${port}/agent-tools`;
  // One shared engine process carries every conversation below.
  const engine = { captureProcessId: 7, captureRunId: "sticky-last-thread" };
  const loaded = (threadId: string, port: number) =>
    JSON.stringify({
      ...engine,
      fakeThreadConfig: { threadId, config: { "mcp_servers.opensteer.url": url(port) } },
    });
  const token = (threadId: string, value?: string) =>
    JSON.stringify({
      ...engine,
      fakeOpensteerTokens: value ? { agentTools: value, threadId } : {},
    });
  const turn = (threadId: string, text: string) =>
    JSON.stringify({ ...engine, method: "turn/start", params: { threadId, input: [{ text }] } });
  const capture = (...rows: readonly string[]) => rows.join("\n") + "\n";

  it("keeps the marked conversation's token beside a naming and an unrelated conversation", () => {
    expect(
      heldRunCapture(
        capture(
          loaded("run", 4001),
          token("run", "engine-token"),
          // A thread/start request names no thread; its URL counts for none.
          JSON.stringify({ ...engine, method: "thread/start", params: { config: url(4009) } }),
          turn("run", `Keep working ${marker}`),
          loaded("naming", 4001),
          token("naming"),
          turn("naming", `Name this: Keep working ${marker}`),
          loaded("other", 4002),
          token("other", "unrelated"),
          turn("other", "Keep working held-run-other"),
        ),
        marker,
      ),
    ).toEqual({ token: "engine-token", url: url(4001) });
  });

  it.each([
    {
      name: "an earlier Run's conversation",
      rows: [
        loaded("run", 4001),
        token("run", "earlier"),
        turn("run", "Keep working held-run-earlier"),
      ],
    },
    {
      name: "an unrelated Run whose rows arrive later",
      rows: [
        loaded("run", 4001),
        token("run", "this"),
        loaded("other", 4002),
        token("other", "unrelated"),
        turn("other", "Keep working held-run-other"),
      ],
    },
    {
      name: "a token and URL on different conversations",
      rows: [loaded("a", 4001), turn("a", marker), token("b", "split"), turn("b", marker)],
    },
    {
      name: "two conversations claiming the marked Run",
      rows: [
        loaded("a", 4001),
        token("a", "first"),
        turn("a", marker),
        loaded("b", 4002),
        token("b", "second"),
        turn("b", marker),
      ],
    },
    { name: "no conversation at all", rows: [token("a"), token("b")] },
    {
      name: "a marked conversation without a token",
      rows: [loaded("run", 4001), token("run"), turn("run", marker)],
    },
    {
      name: "a marked conversation without a URL",
      rows: [token("run", "no-url"), turn("run", marker)],
    },
    {
      name: "a marked conversation with two URLs",
      rows: [
        loaded("run", 4001),
        loaded("run", 4002),
        token("run", "two-urls"),
        turn("run", marker),
      ],
    },
  ])("refuses $name", ({ rows }) => {
    expect(heldRunCapture(capture(...rows), marker)).toBeUndefined();
  });
});
