import { describe, expect, it } from "vitest";
import {
  DictationAvailabilitySchema,
  DictationEventSchema,
  DictationSessionInputSchema,
  dictationSegmentsMaxCount,
  dictationTextMaxLength,
} from "./dictation.js";

const session = "3f2b8c4e-9d1a-4c7e-8b6f-2a5d9e0c1b74";

describe("dictation contract", () => {
  it("describes an available language or exactly why the microphone is absent", () => {
    expect(
      DictationAvailabilitySchema.parse({
        available: true,
        locale: "en-US",
        languageName: "English",
        model: "installed",
        microphone: "undetermined",
      }),
    ).toMatchObject({ available: true, model: "installed" });
    expect(DictationAvailabilitySchema.parse({ available: false, reason: "restricted" })).toEqual({
      available: false,
      reason: "restricted",
    });
    // Policy restriction is an unavailability reason, never a microphone state to offer.
    expect(
      DictationAvailabilitySchema.safeParse({
        available: true,
        locale: "en-US",
        languageName: "English",
        model: "installed",
        microphone: "restricted",
      }).success,
    ).toBe(false);
    expect(
      DictationAvailabilitySchema.safeParse({ available: false, reason: "os", locale: "en-US" })
        .success,
    ).toBe(false);
  });

  it("accepts every event shape the native layers send", () => {
    const events = [
      { type: "downloading", session, seq: 1, progress: null },
      { type: "downloading", session, seq: 2, progress: 0.42 },
      { type: "listening", session, seq: 1 },
      { type: "text", session, seq: 2, finalized: ["Hello there."], volatile: ["how are"] },
      { type: "level", session, seq: 3, level: 0.5 },
      { type: "ended", session, seq: 4, reason: "completed", error: null },
      { type: "ended", session, seq: 4, reason: "failed", error: "permission-denied" },
    ];
    for (const event of events) expect(DictationEventSchema.parse(event)).toEqual(event);
  });

  it("ends with an error exactly when the session failed, and the error key is never omitted", () => {
    const ended = { type: "ended", session, seq: 9 };
    expect(
      DictationEventSchema.safeParse({ ...ended, reason: "failed", error: null }).success,
    ).toBe(false);
    expect(
      DictationEventSchema.safeParse({ ...ended, reason: "completed", error: "busy" }).success,
    ).toBe(false);
    expect(DictationEventSchema.safeParse({ ...ended, reason: "completed" }).success).toBe(false);
  });

  it("fences sessions by canonical id and a positive sequence", () => {
    const listening = { type: "listening", seq: 1 };
    expect(
      DictationEventSchema.safeParse({ ...listening, session: session.toUpperCase() }).success,
    ).toBe(false);
    expect(DictationEventSchema.safeParse({ ...listening, session, seq: 0 }).success).toBe(false);
    expect(DictationEventSchema.safeParse({ ...listening, session, seq: 1.5 }).success).toBe(false);
    expect(DictationSessionInputSchema.safeParse({ session, extra: true }).success).toBe(false);
  });

  it("bounds text in UTF-16 code units and segment counts, and levels and progress to 0..1", () => {
    const text = { type: "text", session, seq: 1, volatile: [] };
    expect(
      DictationEventSchema.safeParse({ ...text, finalized: ["a".repeat(dictationTextMaxLength)] })
        .success,
    ).toBe(true);
    expect(
      DictationEventSchema.safeParse({
        ...text,
        finalized: ["a".repeat(dictationTextMaxLength + 1)],
      }).success,
    ).toBe(false);
    // An emoji is one code point but two UTF-16 units; the bound counts units, as Swift does.
    const halfLimitOfEmoji = "😀".repeat(dictationTextMaxLength / 2);
    expect(DictationEventSchema.safeParse({ ...text, finalized: [halfLimitOfEmoji] }).success).toBe(
      true,
    );
    expect(
      DictationEventSchema.safeParse({ ...text, volatile: [`${halfLimitOfEmoji}a`] }).success,
    ).toBe(false);
    expect(
      DictationEventSchema.safeParse({
        ...text,
        finalized: Array.from({ length: dictationSegmentsMaxCount + 1 }, () => "a"),
      }).success,
    ).toBe(false);
    expect(
      DictationEventSchema.safeParse({ type: "level", session, seq: 1, level: 1.01 }).success,
    ).toBe(false);
    expect(
      DictationEventSchema.safeParse({ type: "downloading", session, seq: 1, progress: -0.1 })
        .success,
    ).toBe(false);
  });
});
