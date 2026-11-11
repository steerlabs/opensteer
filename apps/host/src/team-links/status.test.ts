import { describe, expect, it } from "vitest";
import { publicTeamStatus } from "./status.js";

describe("team status privacy", () => {
  it("projects only closed step kinds and bounded counts from private progress", () => {
    const privateProgress = {
      state: "needs_you" as const,
      steps: [
        { kind: "read_files", count: 2, path: "/private/SENTINEL", payload: "SECRET" },
        { kind: "asked_you", count: 1, question: "PRIVATE QUESTION" },
        { kind: "reasoning", count: 100, text: "PRIVATE REASONING" },
      ],
      url: "https://private.invalid/SENTINEL",
    };
    const projected = publicTeamStatus(privateProgress);
    expect(projected).toEqual({
      state: "needs_you",
      steps: [
        { kind: "read_files", count: 2 },
        { kind: "asked_you", count: 1 },
      ],
    });
    expect(JSON.stringify(projected)).not.toMatch(/SENTINEL|SECRET|PRIVATE|reasoning/);
  });
});
