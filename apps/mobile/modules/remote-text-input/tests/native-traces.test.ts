import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  createEditingState,
  reduceEditing,
  type EditingOperation,
} from "@opensteer/client/editing";
import { EditingContextSchema } from "@opensteer/protocol/editing";
import fixture from "../../../../../packages/client/src/editing/__fixtures__/expo-android-us-context-plain.json" with { type: "json" };
import emojiFixture from "../../../../../packages/client/src/editing/__fixtures__/expo-android-us-emoji-prediction.json" with { type: "json" };
import autocorrectFixture from "../../../../../packages/client/src/editing/__fixtures__/expo-android-autocorrect.json" with { type: "json" };
import { decodeNativeEvent } from "../src/events.js";

it("replays real Gboard plain commits across native context resets without claiming composition coverage", () => {
  expect(fixture.native).toBe(true);
  expect(fixture.source.driver).toContain("ADB touch");
  expect(fixture.scope).toContain("not marked composition");
  const raw = readFileSync(
    new URL(
      "../../../../../packages/client/src/editing/__fixtures__/expo-android-us-context-plain.jsonl",
      import.meta.url,
    ),
  );
  expect(createHash("sha256").update(raw).digest("hex")).toBe(fixture.provenance.rawSha256);
  const control = z.object({ context: EditingContextSchema });
  let state = createEditingState("android", {
    composition: true,
    rangeEdits: true,
    commands: true,
    clipboard: "full",
  });
  const operations: EditingOperation[] = [];
  const textByContext: Record<string, string> = {};
  let id = 0;
  let compositionEvents = 0;
  for (const line of raw.toString("utf8").trimEnd().split("\n")) {
    const recorded: unknown = JSON.parse(line);
    const context = control.safeParse(recorded);
    if (context.success) {
      const result = reduceEditing(state, { type: "context", context: context.data.context });
      state = result.state;
      operations.push(...result.operations);
    } else {
      const packet = decodeNativeEvent(recorded);
      expect(packet.id).toBe(++id);
      expect(packet.contextId).toBe(state.context?.contextId);
      if (packet.event.type.startsWith("composition")) compositionEvents++;
      const result = reduceEditing(state, packet.event);
      state = result.state;
      operations.push(...result.operations);
      if (state.composition) expect(result.instruction.set).toBeUndefined();
    }
  }
  expect(id).toBe(10);
  expect(compositionEvents).toBe(fixture.expected.compositionEvents);
  expect(operations).toEqual(fixture.expected.operations);
  for (const operation of operations) {
    if (operation.kind !== "edit")
      throw new Error("This captured plain-commit case has no other text producer");
    expect(operation.edit.before).toBe("");
    expect(operation.edit.after).toBe("");
    const key = operation.edit.contextId;
    textByContext[key] = (textByContext[key] ?? "") + operation.edit.text;
  }
  expect(textByContext).toEqual(fixture.expected.contexts);
  expect(state.proxy.value).toBe(fixture.expected.lastProxy);
  expect(state.composition).toBeNull();
  expect(state.down).toEqual([]);
});

// Captured native acceptance: the oracle is the actual keys and visible suggestion.
it.each([
  { name: "US typing and emoji prediction", fixture: emojiFixture },
  { name: "verified autocorrect replacement", fixture: autocorrectFixture },
])("replays native Gboard $name exactly once", ({ fixture: recordedFixture }) => {
  const raw = readFileSync(
    new URL(
      "../../../../../packages/client/src/editing/__fixtures__/" +
        recordedFixture.provenance.rawFile,
      import.meta.url,
    ),
  );
  expect(recordedFixture.native).toBe(true);
  expect(createHash("sha256").update(raw).digest("hex")).toBe(recordedFixture.provenance.rawSha256);
  const control = z.object({ context: EditingContextSchema });
  let state = createEditingState("android", {
    composition: true,
    rangeEdits: true,
    commands: true,
    clipboard: "full",
  });
  const operations: EditingOperation[] = [];
  let id = 0;
  let compositions = 0;
  for (const line of raw.toString("utf8").trimEnd().split("\n")) {
    const recorded: unknown = JSON.parse(line);
    const context = control.safeParse(recorded);
    const event = context.success
      ? { type: "context" as const, context: context.data.context }
      : (() => {
          const packet = decodeNativeEvent(recorded);
          expect(packet.id).toBe(++id);
          expect(packet.contextId).toBe(state.context?.contextId);
          if (packet.event.type.startsWith("composition")) compositions++;
          return packet.event;
        })();
    const result = reduceEditing(state, event);
    state = result.state;
    operations.push(...result.operations);
  }
  expect(id).toBe(recordedFixture.expected.packetCount);
  expect(compositions).toBe(recordedFixture.expected.compositionEvents);
  expect(operations).toEqual(recordedFixture.expected.operations);
  expect(state.proxy.value).toBe(recordedFixture.expected.lastProxy);
  expect(state.composition).toBeNull();
  expect(state.down).toEqual([]);
});
