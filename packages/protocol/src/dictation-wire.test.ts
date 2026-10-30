import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  DictationAvailabilitySchema,
  DictationEventSchema,
  DictationErrorSchema,
  DictationEndReasonSchema,
  DictationUnavailableReasonSchema,
  DictationMicrophoneSchema,
} from "./dictation.js";

// Generated from the engine's real Codable types by its Swift fixture test.
const fixture = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../apple-dictation/Tests/Fixtures/dictation-wire.json"),
    "utf8",
  ),
) as { events: unknown[]; availability: unknown[] };

it("accepts every Swift dictation wire variant", () => {
  const events = fixture.events.map((event) => DictationEventSchema.parse(event));
  expect(new Set(events.map((event) => event.type))).toEqual(
    new Set(["downloading", "listening", "text", "level", "ended"]),
  );
  const endings = events.filter((event) => event.type === "ended");
  expect(new Set(endings.map((event) => event.reason))).toEqual(
    new Set(DictationEndReasonSchema.options),
  );
  expect(new Set(endings.map((event) => event.error).filter((error) => error !== null))).toEqual(
    new Set(DictationErrorSchema.options),
  );
  const availability = fixture.availability.map((value) =>
    DictationAvailabilitySchema.parse(value),
  );
  expect(
    new Set(availability.filter((value) => !value.available).map((value) => value.reason)),
  ).toEqual(new Set(DictationUnavailableReasonSchema.options));
  const available = availability.filter((value) => value.available);
  expect(new Set(available.map((value) => value.microphone))).toEqual(
    new Set(DictationMicrophoneSchema.options),
  );
  expect(new Set(available.map((value) => value.model))).toEqual(
    new Set(["installed", "download"]),
  );
});
