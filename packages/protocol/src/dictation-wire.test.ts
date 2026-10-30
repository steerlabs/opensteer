import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { DictationAvailabilitySchema, DictationEventSchema } from "./dictation.js";

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
  expect(events.filter((event) => event.type === "ended").map((event) => event.error)).toEqual([
    null,
    "recognition-failed",
  ]);
  expect(
    fixture.availability.map((value) => DictationAvailabilitySchema.parse(value).available),
  ).toEqual([false, true]);
});
