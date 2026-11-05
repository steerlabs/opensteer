import { describe, expect, it } from "vitest";
import { voiceBar } from "./bar.js";
import { idleVoiceSnapshot, type VoiceSnapshot } from "./contract.js";

const at = (patch: Partial<VoiceSnapshot>) => voiceBar({ ...idleVoiceSnapshot, ...patch });

describe("voiceBar", () => {
  it("shows the person's words while they talk and while the agent works on them", () => {
    expect(at({ phase: "hearing", heard: "Open Brex" })).toMatchObject({
      live: true,
      tone: "default",
      words: "Open Brex",
    });
    expect(at({ phase: "thinking", heard: "Open Brex" })).toMatchObject({
      live: true,
      status: "Working",
      tone: "muted",
      words: "Open Brex",
    });
  });

  it("shows what the voice is saying while it speaks", () => {
    expect(at({ phase: "speaking", spoken: "Brex is up." })).toMatchObject({
      tone: "soft",
      words: "Brex is up.",
    });
  });

  it("falls back to one word, and muted wins over it", () => {
    expect(at({ phase: "listening" })).toMatchObject({ live: false, words: "Listening" });
    expect(at({ phase: "listening", muted: true })).toMatchObject({
      status: "Microphone muted",
      words: "Muted",
    });
    expect(at({ phase: "thinking" }).words).toBeNull();
  });
});
