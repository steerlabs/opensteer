import { AiSharing, type AiSharingPrompt } from "@opensteer/client/ai-sharing";
import { describe, expect, it, vi } from "vitest";
import { authorizeAiSharing } from "./ai-sharing.js";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: {},
  Platform: { OS: "ios", select: () => undefined },
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: "View",
}));
vi.mock("./primitives.js", () => ({}));
vi.mock("./sheet.js", () => ({}));

const host = {
  getSnapshot: () => ({
    deploymentId: "deployment",
    user: { id: "person" },
    environments: [],
    harnesses: [
      {
        enabled: true,
        driverKind: "claude",
        environmentId: "computer",
        id: "a",
        sourceId: "anthropic",
      },
    ],
  }),
} as never;

function gate(answers: boolean[]) {
  const asked: AiSharingPrompt[] = [];
  const sharing = new AiSharing({
    records: [],
    save: () => {},
    confirm: async (prompt) => {
      asked.push(prompt);
      return answers.shift() ?? false;
    },
    now: () => "2026-11-06T12:00:00.000Z",
  });
  return { asked, sharing };
}

describe("live voice permission", () => {
  it("asks for the computer's AI companies, then for audio going to OpenAI alone", async () => {
    const { asked, sharing } = gate([true, true]);
    expect(await authorizeAiSharing(sharing, host, "audio")).toBe(true);
    expect(asked).toEqual([
      { companies: ["Anthropic"], scope: "content" },
      { companies: ["OpenAI"], scope: "audio" },
    ]);
  });

  it("never asks about audio once content is declined", async () => {
    const { asked, sharing } = gate([false]);
    expect(await authorizeAiSharing(sharing, host, "audio")).toBe(false);
    expect(asked.map((prompt) => prompt.scope)).toEqual(["content"]);
  });
});
