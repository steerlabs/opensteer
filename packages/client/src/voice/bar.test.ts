import { describe, expect, it } from "vitest";
import { callClock, heldWords, voiceBar } from "./bar.js";
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

  it("stays compact with nothing to read, and still tells assistive technology how it stands", () => {
    expect(at({ phase: "listening" })).toMatchObject({
      compact: true,
      live: false,
      status: "Listening",
      words: null,
    });
    expect(at({ phase: "listening", muted: true })).toMatchObject({
      compact: true,
      status: "Microphone muted",
      words: null,
    });
    expect(at({ phase: "thinking" })).toMatchObject({ compact: true, words: null });
    expect(at({ phase: "connecting" })).toMatchObject({ compact: false, words: "Connecting" });
  });

  it("names who is talking, not whose words are up", () => {
    expect(at({ phase: "hearing", heard: "Open Brex" }).speaker).toBe("person");
    expect(at({ phase: "speaking", spoken: "Brex is up." }).speaker).toBe("opensteer");
    // Their words stay up while it works, but nobody is talking.
    expect(at({ phase: "thinking", heard: "Open Brex" })).toMatchObject({
      compact: false,
      speaker: null,
    });
    expect(at({ phase: "hearing", heard: "Open Brex", muted: true }).speaker).toBeNull();
    expect(at({ phase: "speaking", spoken: "Brex is up.", muted: true }).speaker).toBe("opensteer");
  });
});

it("reads a call's length the way a phone does", () => {
  expect(callClock(7_000)).toBe("0:07");
  expect(callClock(760_000)).toBe("12:40");
  expect(callClock(3_729_000)).toBe("1:02:09");
});

it("lets a turn's words widen the pill, and closes it once they are gone", () => {
  expect(heldWords(25, 0, true)).toBe(25);
  expect(heldWords(47, 25, false)).toBe(47);
  expect(heldWords(30, 47, false)).toBe(47);
  expect(heldWords(30, 47, true)).toBe(30);
  // Connecting to listening is no new turn: nobody spoke, but the word went.
  expect(heldWords(0, 47, false)).toBe(0);
});
