import us from "./__fixtures__/electron-us.json" with { type: "json" };
import option from "./__fixtures__/electron-option-dead-key.json" with { type: "json" };
import held from "./__fixtures__/electron-held-key-no-accent-picker.json" with { type: "json" };
import androidBaseline from "./__fixtures__/android-baseline-no-suggestions.json" with { type: "json" };
import androidMissed from "./__fixtures__/android-baseline-missed-initial-key.json" with { type: "json" };
import gboardTyping from "./__fixtures__/android-gboard-typing.json" with { type: "json" };
import gboardAutocorrect from "./__fixtures__/android-gboard-autocorrect.json" with { type: "json" };
import gboardDelete from "./__fixtures__/android-gboard-swipe-delete.json" with { type: "json" };
import gboardRecomposition from "./__fixtures__/android-gboard-recomposition.json" with { type: "json" };
import gboardTypingRepeat from "./__fixtures__/android-gboard-typing-repeat.json" with { type: "json" };
import gboardAutocorrectRepeat from "./__fixtures__/android-gboard-autocorrect-repeat.json" with { type: "json" };
import gboardDeleteRepeat from "./__fixtures__/android-gboard-swipe-delete-repeat.json" with { type: "json" };
import gboardWordCandidate from "./__fixtures__/android-gboard-existing-word-candidate.json" with { type: "json" };
import thirdTyping from "./__fixtures__/android-corrected3-gboard-typing.json" with { type: "json" };
import thirdAutocorrect from "./__fixtures__/android-corrected3-gboard-autocorrect.json" with { type: "json" };
import thirdDelete from "./__fixtures__/android-corrected3-gboard-swipe-delete.json" with { type: "json" };
import thirdCandidate from "./__fixtures__/android-corrected3-gboard-recomposition.json" with { type: "json" };
import learningBefore from "./__fixtures__/android-corrected3-password-learning-before.json" with { type: "json" };
import passwordProxy from "./__fixtures__/android-corrected3-password-proxy-probe.json" with { type: "json" };
import passwordNative from "./__fixtures__/android-corrected3-password-native-probe.json" with { type: "json" };
import learningAfter from "./__fixtures__/android-corrected3-password-learning-after.json" with { type: "json" };
import confirmedTyping from "./__fixtures__/android-corrected6-gboard-typing.json" with { type: "json" };
import confirmedAutocorrect from "./__fixtures__/android-corrected6-gboard-autocorrect.json" with { type: "json" };
import failedSwipe from "./__fixtures__/android-corrected6-gboard-swipe-delete.json" with { type: "json" };
import confirmedCandidate from "./__fixtures__/android-corrected6-gboard-recomposition.json" with { type: "json" };
import nativeTextControl from "./__fixtures__/android-corrected6-native-text-recomposition-control.json" with { type: "json" };
import confirmedLearningBefore from "./__fixtures__/android-corrected6-password-learning-before.json" with { type: "json" };
import confirmedPasswordProxy from "./__fixtures__/android-corrected6-password-proxy-probe.json" with { type: "json" };
import confirmedPasswordNative from "./__fixtures__/android-corrected6-password-native-probe.json" with { type: "json" };
import confirmedLearningAfter from "./__fixtures__/android-corrected6-password-learning-after.json" with { type: "json" };
import macElectronReplacement from "./__fixtures__/macos1-electron-text-replacement.json" with { type: "json" };
import macChromeUs from "./__fixtures__/macos1-chrome-us.json" with { type: "json" };
import macChromeOption from "./__fixtures__/macos1-chrome-option.json" with { type: "json" };
import macChromeReplacement from "./__fixtures__/macos1-chrome-text-replacement.json" with { type: "json" };
import macSafariOption from "./__fixtures__/macos1-safari-option.json" with { type: "json" };
import macSafariDead from "./__fixtures__/macos1-safari-dead-key.json" with { type: "json" };
import macSafariCancel from "./__fixtures__/macos1-safari-japanese-cancel.json" with { type: "json" };
import macSafariReplacement from "./__fixtures__/macos1-safari-text-replacement.json" with { type: "json" };
import macPendingKey from "./__fixtures__/macos1-electron-japanese-convert-partial.json" with { type: "json" };
import macElectronPicker from "./__fixtures__/macos1-electron-emoji-picker.json" with { type: "json" };
import macChromePicker from "./__fixtures__/macos1-chrome-emoji-picker.json" with { type: "json" };
import macSafariPicker from "./__fixtures__/macos1-safari-emoji-picker.json" with { type: "json" };
import macSafariAutocorrect from "./__fixtures__/macos1-safari-us-autocorrect.json" with { type: "json" };
import macLatin0 from "./__fixtures__/macos1-electron-accent-hold.json" with { type: "json" };
import macLatin1 from "./__fixtures__/macos1-electron-korean-click.json" with { type: "json" };
import macLatin2 from "./__fixtures__/macos1-electron-korean-repeat-enter.json" with { type: "json" };
import macLatin3 from "./__fixtures__/macos1-electron-korean-transition-enter.json" with { type: "json" };
import macLatin4 from "./__fixtures__/macos1-electron-pinyin.json" with { type: "json" };
import macLatin5 from "./__fixtures__/macos1-chrome-accent-hold.json" with { type: "json" };
import macLatin6 from "./__fixtures__/macos1-chrome-korean-click.json" with { type: "json" };
import macLatin7 from "./__fixtures__/macos1-chrome-korean-repeat-enter.json" with { type: "json" };
import macLatin8 from "./__fixtures__/macos1-chrome-korean-transition-enter.json" with { type: "json" };
import macLatin9 from "./__fixtures__/macos1-chrome-pinyin.json" with { type: "json" };
import macLatin10 from "./__fixtures__/macos1-safari-accent-hold.json" with { type: "json" };
import macLatin11 from "./__fixtures__/macos1-safari-korean-click.json" with { type: "json" };
import macLatin12 from "./__fixtures__/macos1-safari-korean-repeat-enter.json" with { type: "json" };
import macLatin13 from "./__fixtures__/macos1-safari-korean-transition-enter.json" with { type: "json" };
import macLatin14 from "./__fixtures__/macos1-safari-pinyin.json" with { type: "json" };
import macIme0 from "./__fixtures__/macos1-chrome-dead-key.json" with { type: "json" };
import macIme1 from "./__fixtures__/macos1-chrome-japanese-convert.json" with { type: "json" };
import macIme2 from "./__fixtures__/macos1-safari-japanese-convert.json" with { type: "json" };
import macIme3 from "./__fixtures__/macos1-chrome-japanese-reconvert.json" with { type: "json" };
import macIme4 from "./__fixtures__/macos1-electron-japanese-reconvert.json" with { type: "json" };
import macIme5 from "./__fixtures__/macos1-safari-japanese-reconvert.json" with { type: "json" };
import macIme6 from "./__fixtures__/macos1-electron-japanese-cancel.json" with { type: "json" };
import macIme7 from "./__fixtures__/macos1-electron-japanese-candidate.json" with { type: "json" };
import macIme8 from "./__fixtures__/macos1-chrome-japanese-cancel.json" with { type: "json" };
import macIme9 from "./__fixtures__/macos1-chrome-japanese-candidate.json" with { type: "json" };
import macIme10 from "./__fixtures__/macos1-safari-japanese-candidate.json" with { type: "json" };
import macHold0 from "./__fixtures__/macos2-electron-accent-hold.json" with { type: "json" };
import macHold1 from "./__fixtures__/macos2-chrome-accent-hold.json" with { type: "json" };
import macHold2 from "./__fixtures__/macos2-safari-accent-hold.json" with { type: "json" };
import macSecond0 from "./__fixtures__/macos2-electron-korean-click.json" with { type: "json" };
import macSecond1 from "./__fixtures__/macos2-electron-korean-repeat-enter.json" with { type: "json" };
import macSecond2 from "./__fixtures__/macos2-electron-korean-transition-enter.json" with { type: "json" };
import macSecond3 from "./__fixtures__/macos2-electron-pinyin.json" with { type: "json" };
import macSecond4 from "./__fixtures__/macos2-electron-emoji-picker.json" with { type: "json" };
import macSecond5 from "./__fixtures__/macos2-chrome-korean-click.json" with { type: "json" };
import macSecond6 from "./__fixtures__/macos2-chrome-korean-repeat-enter.json" with { type: "json" };
import macSecond7 from "./__fixtures__/macos2-chrome-korean-transition-enter.json" with { type: "json" };
import macSecond8 from "./__fixtures__/macos2-chrome-pinyin.json" with { type: "json" };
import macSecond9 from "./__fixtures__/macos2-chrome-emoji-picker.json" with { type: "json" };
import macSecond10 from "./__fixtures__/macos2-safari-korean-click.json" with { type: "json" };
import macSecond11 from "./__fixtures__/macos2-safari-korean-repeat-enter.json" with { type: "json" };
import macSecond12 from "./__fixtures__/macos2-safari-korean-transition-enter.json" with { type: "json" };
import macSecond13 from "./__fixtures__/macos2-safari-pinyin.json" with { type: "json" };
import macSecond14 from "./__fixtures__/macos2-safari-emoji-picker.json" with { type: "json" };
import macSecond15 from "./__fixtures__/macos2-electron-japanese-convert.json" with { type: "json" };
import macSecond16 from "./__fixtures__/macos2-electron-japanese-candidate.json" with { type: "json" };
import macSecond17 from "./__fixtures__/macos2-electron-japanese-cancel.json" with { type: "json" };
import macSecond18 from "./__fixtures__/macos2-electron-japanese-reconvert.json" with { type: "json" };
import macSecond19 from "./__fixtures__/macos2-chrome-japanese-convert.json" with { type: "json" };
import macSecond20 from "./__fixtures__/macos2-chrome-japanese-candidate.json" with { type: "json" };
import macSecond21 from "./__fixtures__/macos2-chrome-japanese-cancel.json" with { type: "json" };
import macSecond22 from "./__fixtures__/macos2-chrome-japanese-reconvert.json" with { type: "json" };
import macSecond23 from "./__fixtures__/macos2-safari-japanese-convert.json" with { type: "json" };
import macSecond24 from "./__fixtures__/macos2-safari-japanese-candidate.json" with { type: "json" };
import macSecond25 from "./__fixtures__/macos2-safari-japanese-reconvert.json" with { type: "json" };
import macSecond26 from "./__fixtures__/macos2-chrome-dead-key.json" with { type: "json" };
import macSecond27 from "./__fixtures__/macos2-safari-us.json" with { type: "json" };
import macFinal0 from "./__fixtures__/macos3-electron-emoji-picker.json" with { type: "json" };
import macFinal1 from "./__fixtures__/macos3-chrome-emoji-picker.json" with { type: "json" };
import macFinal2 from "./__fixtures__/macos3-safari-emoji-picker.json" with { type: "json" };
import macFinal3 from "./__fixtures__/macos3-firefox-emoji-picker.json" with { type: "json" };
import macFinal4 from "./__fixtures__/macos3-firefox-us.json" with { type: "json" };
import macFinal5 from "./__fixtures__/macos3-firefox-option.json" with { type: "json" };
import macFinal6 from "./__fixtures__/macos3-firefox-dead-key.json" with { type: "json" };
import macFinal7 from "./__fixtures__/macos3-firefox-accent-hold.json" with { type: "json" };
import macFinal8 from "./__fixtures__/macos3-firefox-japanese-convert.json" with { type: "json" };
import macFinal9 from "./__fixtures__/macos3-firefox-japanese-candidate.json" with { type: "json" };
import macFinal10 from "./__fixtures__/macos3-firefox-japanese-cancel.json" with { type: "json" };
import macFinal11 from "./__fixtures__/macos3-firefox-japanese-reconvert.json" with { type: "json" };
import macFinal12 from "./__fixtures__/macos3-firefox-text-replacement.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EditingCompositionSchema,
  EditingKeystrokeSchema,
  type EditingComposition,
  type EditingKeystroke,
} from "@opensteer/protocol/editing";
import { createEditingState, reduceEditing } from "./reducer.js";
import type { EditingOperation, EditingProxyEvent } from "./types.js";

const producer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), text: z.string() }),
  z.object({ kind: z.literal("edit"), text: z.string(), before: z.string(), after: z.string() }),
  z.object({ kind: z.literal("command"), command: z.string() }),
]);
const schema = z.object({
  native: z.literal(true),
  engine: z.string(),
  platform: z.enum(["mac", "android"]).optional(),
  policy: z
    .enum(["baseline", "corrected", "sensitive", "native-password", "native-text", "legacy"])
    .optional(),
  intent: z.string(),
  qualification: z.enum([
    "captured",
    "baseline-captured",
    "failed-accent-picker",
    "failed-key-delivery",
    "failed-recomposition",
    "failed-keyboard-hint",
    "failed-swipe-delete",
    "failed-incomplete-composition",
    "failed-emoji-picker",
    "failed-native-intent",
    "failed-native-trust",
  ]),
  expected: z.object({
    value: z.string(),
    producers: z.array(producer),
    transactionCommits: z.array(z.union([z.literal(0), z.literal(1)])),
    transactionOpen: z.boolean().optional(),
    untrustedEvents: z
      .array(z.object({ type: z.string(), data: z.string().nullable().optional() }))
      .optional(),
    keystrokes: z.array(EditingKeystrokeSchema),
    compositions: z.array(EditingCompositionSchema),
    proxy: z.object({ value: z.string(), selectionStart: z.number(), selectionEnd: z.number() }),
    caret: z.number(),
  }),
  events: z.array(
    z.object({
      type: z.string(),
      trusted: z.boolean().optional(),
      key: z.string().optional(),
      code: z.string().optional(),
      keyCode: z.number().optional(),
      data: z.string().nullable().optional(),
      inputType: z.string().optional(),
      composing: z.boolean().optional(),
      repeat: z.boolean().optional(),
      alt: z.boolean().optional(),
      control: z.boolean().optional(),
      meta: z.boolean().optional(),
      shift: z.boolean().optional(),
      altGraph: z.boolean().optional(),
      location: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
      value: z.string(),
      selectionStart: z.number(),
      selectionEnd: z.number(),
      markedRange: z.object({ start: z.number(), end: z.number() }).nullable().optional(),
    }),
  ),
});
const contextId = "00000000-0000-4000-8000-000000000001";
function produced(operation: EditingOperation): z.infer<typeof producer> | null {
  if (operation.kind === "key")
    return operation.keystroke.action === "down" && operation.keystroke.text !== undefined
      ? { kind: "key", text: operation.keystroke.text }
      : null;
  if (operation.kind === "edit")
    return {
      kind: "edit",
      text: operation.edit.text,
      before: operation.edit.before,
      after: operation.edit.after,
    };
  if (operation.kind === "command") return operation;
  return null;
}
describe("recorded native proxy traces and independent platform controls", () => {
  const fixtures = [
    ["electron-us.json", us],
    ["electron-option-dead-key.json", option],
    ["electron-held-key-no-accent-picker.json", held],
    ["android-baseline-no-suggestions.json", androidBaseline],
    ["android-baseline-missed-initial-key.json", androidMissed],
    ["android-gboard-typing.json", gboardTyping],
    ["android-gboard-autocorrect.json", gboardAutocorrect],
    ["android-gboard-swipe-delete.json", gboardDelete],
    ["android-gboard-recomposition.json", gboardRecomposition],
    ["android-gboard-typing-repeat.json", gboardTypingRepeat],
    ["android-gboard-autocorrect-repeat.json", gboardAutocorrectRepeat],
    ["android-gboard-swipe-delete-repeat.json", gboardDeleteRepeat],
    ["android-gboard-existing-word-candidate.json", gboardWordCandidate],
    ["android-corrected3-gboard-typing.json", thirdTyping],
    ["android-corrected3-gboard-autocorrect.json", thirdAutocorrect],
    ["android-corrected3-gboard-swipe-delete.json", thirdDelete],
    ["android-corrected3-gboard-recomposition.json", thirdCandidate],
    ["android-corrected3-password-learning-before.json", learningBefore],
    ["android-corrected3-password-proxy-probe.json", passwordProxy],
    ["android-corrected3-password-native-probe.json", passwordNative],
    ["android-corrected3-password-learning-after.json", learningAfter],
    ["android-corrected6-gboard-typing.json", confirmedTyping],
    ["android-corrected6-gboard-autocorrect.json", confirmedAutocorrect],
    ["android-corrected6-gboard-swipe-delete.json", failedSwipe],
    ["android-corrected6-gboard-recomposition.json", confirmedCandidate],
    ["android-corrected6-native-text-recomposition-control.json", nativeTextControl],
    ["android-corrected6-password-learning-before.json", confirmedLearningBefore],
    ["android-corrected6-password-proxy-probe.json", confirmedPasswordProxy],
    ["android-corrected6-password-native-probe.json", confirmedPasswordNative],
    ["android-corrected6-password-learning-after.json", confirmedLearningAfter],
    ["macos1-electron-text-replacement.json", macElectronReplacement],
    ["macos1-chrome-us.json", macChromeUs],
    ["macos1-chrome-option.json", macChromeOption],
    ["macos1-chrome-text-replacement.json", macChromeReplacement],
    ["macos1-safari-option.json", macSafariOption],
    ["macos1-safari-dead-key.json", macSafariDead],
    ["macos1-safari-japanese-cancel.json", macSafariCancel],
    ["macos1-safari-text-replacement.json", macSafariReplacement],
    ["macos1-electron-japanese-convert-partial.json", macPendingKey],
    ["macos1-electron-emoji-picker.json", macElectronPicker],
    ["macos1-chrome-emoji-picker.json", macChromePicker],
    ["macos1-safari-emoji-picker.json", macSafariPicker],
    ["macos1-safari-us-autocorrect.json", macSafariAutocorrect],
    ["macos1-electron-accent-hold.json", macLatin0],
    ["macos1-electron-korean-click.json", macLatin1],
    ["macos1-electron-korean-repeat-enter.json", macLatin2],
    ["macos1-electron-korean-transition-enter.json", macLatin3],
    ["macos1-electron-pinyin.json", macLatin4],
    ["macos1-chrome-accent-hold.json", macLatin5],
    ["macos1-chrome-korean-click.json", macLatin6],
    ["macos1-chrome-korean-repeat-enter.json", macLatin7],
    ["macos1-chrome-korean-transition-enter.json", macLatin8],
    ["macos1-chrome-pinyin.json", macLatin9],
    ["macos1-safari-accent-hold.json", macLatin10],
    ["macos1-safari-korean-click.json", macLatin11],
    ["macos1-safari-korean-repeat-enter.json", macLatin12],
    ["macos1-safari-korean-transition-enter.json", macLatin13],
    ["macos1-safari-pinyin.json", macLatin14],
    ["macos1-chrome-dead-key.json", macIme0],
    ["macos1-chrome-japanese-convert.json", macIme1],
    ["macos1-safari-japanese-convert.json", macIme2],
    ["macos1-chrome-japanese-reconvert.json", macIme3],
    ["macos1-electron-japanese-reconvert.json", macIme4],
    ["macos1-safari-japanese-reconvert.json", macIme5],
    ["macos1-electron-japanese-cancel.json", macIme6],
    ["macos1-electron-japanese-candidate.json", macIme7],
    ["macos1-chrome-japanese-cancel.json", macIme8],
    ["macos1-chrome-japanese-candidate.json", macIme9],
    ["macos1-safari-japanese-candidate.json", macIme10],
    ["macos2-electron-accent-hold.json", macHold0],
    ["macos2-chrome-accent-hold.json", macHold1],
    ["macos2-safari-accent-hold.json", macHold2],
    ["macos2-electron-korean-click.json", macSecond0],
    ["macos2-electron-korean-repeat-enter.json", macSecond1],
    ["macos2-electron-korean-transition-enter.json", macSecond2],
    ["macos2-electron-pinyin.json", macSecond3],
    ["macos2-electron-emoji-picker.json", macSecond4],
    ["macos2-chrome-korean-click.json", macSecond5],
    ["macos2-chrome-korean-repeat-enter.json", macSecond6],
    ["macos2-chrome-korean-transition-enter.json", macSecond7],
    ["macos2-chrome-pinyin.json", macSecond8],
    ["macos2-chrome-emoji-picker.json", macSecond9],
    ["macos2-safari-korean-click.json", macSecond10],
    ["macos2-safari-korean-repeat-enter.json", macSecond11],
    ["macos2-safari-korean-transition-enter.json", macSecond12],
    ["macos2-safari-pinyin.json", macSecond13],
    ["macos2-safari-emoji-picker.json", macSecond14],
    ["macos2-electron-japanese-convert.json", macSecond15],
    ["macos2-electron-japanese-candidate.json", macSecond16],
    ["macos2-electron-japanese-cancel.json", macSecond17],
    ["macos2-electron-japanese-reconvert.json", macSecond18],
    ["macos2-chrome-japanese-convert.json", macSecond19],
    ["macos2-chrome-japanese-candidate.json", macSecond20],
    ["macos2-chrome-japanese-cancel.json", macSecond21],
    ["macos2-chrome-japanese-reconvert.json", macSecond22],
    ["macos2-safari-japanese-convert.json", macSecond23],
    ["macos2-safari-japanese-candidate.json", macSecond24],
    ["macos2-safari-japanese-reconvert.json", macSecond25],
    ["macos2-chrome-dead-key.json", macSecond26],
    ["macos2-safari-us.json", macSecond27],
    ["macos3-electron-emoji-picker.json", macFinal0],
    ["macos3-chrome-emoji-picker.json", macFinal1],
    ["macos3-safari-emoji-picker.json", macFinal2],
    ["macos3-firefox-emoji-picker.json", macFinal3],
    ["macos3-firefox-us.json", macFinal4],
    ["macos3-firefox-option.json", macFinal5],
    ["macos3-firefox-dead-key.json", macFinal6],
    ["macos3-firefox-accent-hold.json", macFinal7],
    ["macos3-firefox-japanese-convert.json", macFinal8],
    ["macos3-firefox-japanese-candidate.json", macFinal9],
    ["macos3-firefox-japanese-cancel.json", macFinal10],
    ["macos3-firefox-japanese-reconvert.json", macFinal11],
    ["macos3-firefox-text-replacement.json", macFinal12],
  ] as const;
  it("has native observations and independently authored intent for every replay", () => {
    for (const [, source] of fixtures) {
      const trace = schema.parse(source);
      expect(trace.events.length).toBeGreaterThan(0);
      expect(trace.intent.length).toBeGreaterThan(0);
      const untrusted = trace.events
        .filter((event) => event.trusted === false)
        .map(({ type, data }) => ({ type, data }));
      if (trace.qualification === "captured" || trace.qualification === "baseline-captured")
        expect(untrusted).toEqual([]);
      expect(untrusted).toEqual(trace.expected.untrustedEvents ?? []);
    }
  });
  for (const [name, source] of fixtures) {
    const trace = schema.parse(source);
    it(`${trace.engine}: ${name} (${trace.qualification})`, () => {
      let state = createEditingState(trace.platform ?? "mac", {
        composition: true,
        rangeEdits: true,
        commands: true,
        clipboard: "full",
      });
      state = reduceEditing(state, {
        type: "context",
        context: {
          contextId,
          field: {
            kind: "text",
            multiline: true,
            sensitive: trace.policy === "sensitive" || trace.policy === "native-password",
          },
          caret: null,
        },
      }).state;
      const producers: z.infer<typeof producer>[] = [];
      const keystrokes: EditingKeystroke[] = [];
      const compositions: EditingComposition[] = [];
      let transactionCommits = 0;
      let transactionIndex = 0;
      let transaction = false;
      let committed = "",
        preedit = "",
        takeover = 0;
      for (const recorded of trace.events) {
        const proxy = {
          value: recorded.value,
          selectionStart: recorded.selectionStart,
          selectionEnd: recorded.selectionEnd,
          ...(recorded.markedRange === undefined ? {} : { markedRange: recorded.markedRange }),
        };
        let event: EditingProxyEvent;
        if (recorded.type === "keypress" || recorded.type === "focus") continue;
        if (recorded.type === "keydown" || recorded.type === "keyup")
          event = {
            type: recorded.type,
            key: recorded.key!,
            code: recorded.code!,
            alt: recorded.alt ?? false,
            control: recorded.control ?? false,
            meta: recorded.meta ?? false,
            shift: recorded.shift ?? false,
            altGraph: recorded.altGraph ?? false,
            location: recorded.location ?? 0,
            repeat: recorded.repeat ?? false,
            composing: recorded.composing === true || recorded.keyCode === 229,
          };
        else if (recorded.type === "beforeinput")
          event = {
            type: "beforeinput",
            inputType: recorded.inputType ?? "",
            data: recorded.data ?? null,
          };
        else if (recorded.type === "input")
          event = {
            type: "input",
            inputType: recorded.inputType ?? "",
            composing: recorded.composing ?? false,
            proxy,
          };
        else if (recorded.type === "compositionstart") {
          expect(transaction).toBe(false);
          transaction = true;
          transactionCommits = 0;
          event = { type: "compositionstart", proxy };
        } else if (recorded.type === "compositionupdate" || recorded.type === "compositionend")
          event = { type: recorded.type, data: recorded.data ?? "", proxy };
        else if (recorded.type === "selection") event = { type: "selection", proxy };
        else if (recorded.type === "blur" || recorded.type === "pointerdown")
          event = { type: recorded.type };
        else throw new Error(`Unexpected recorded event: ${recorded.type}`);
        const step = reduceEditing(state, event);
        expect(step.refusal).toBeUndefined();
        if (step.instruction.set) expect(step.state.composition).toBeNull();
        state = step.state;
        for (const operation of step.operations) {
          if (operation.kind === "key") keystrokes.push(operation.keystroke);
          if (operation.kind === "compose") compositions.push(operation.composition);
          const intent = produced(operation);
          if (intent) producers.push(intent);
          if (
            operation.kind === "key" &&
            operation.keystroke.action === "down" &&
            operation.keystroke.text
          )
            committed += operation.keystroke.text;
          else if (
            operation.kind === "key" &&
            operation.keystroke.action === "down" &&
            operation.keystroke.key === "Enter" &&
            operation.keystroke.modifiers.length === 0
          )
            committed += "\n";
          else if (operation.kind === "compose") {
            if (operation.composition.before) {
              expect(committed.endsWith(operation.composition.before)).toBe(true);
              takeover = operation.composition.before.length;
            }
            preedit = operation.composition.text;
          } else if (operation.kind === "edit") {
            if (takeover) {
              committed = committed.slice(0, -takeover);
              takeover = 0;
            }
            expect(committed.endsWith(operation.edit.before)).toBe(true);
            committed =
              committed.slice(0, committed.length - operation.edit.before.length) +
              operation.edit.text;
            preedit = "";
          }
          if (transaction && operation.kind === "edit") transactionCommits++;
          if (operation.kind === "edit" || operation.kind === "compose")
            expect(
              operation.kind === "edit"
                ? operation.edit.contextId
                : operation.composition.contextId,
            ).toBe(contextId);
        }
        if (event.type === "compositionend") {
          expect(transactionCommits).toBe(trace.expected.transactionCommits[transactionIndex++]);
          transaction = false;
        }
      }
      expect(transaction).toBe(trace.expected.transactionOpen ?? false);
      expect(state.composition !== null).toBe(trace.expected.transactionOpen ?? false);
      if (transaction) expect(transactionCommits).toBe(0);
      expect(transactionIndex).toBe(trace.expected.transactionCommits.length);
      expect(state.down).toEqual([]);
      expect(producers).toEqual(trace.expected.producers);
      expect(keystrokes).toEqual(trace.expected.keystrokes);
      expect(compositions).toEqual(trace.expected.compositions);
      expect(committed.slice(0, committed.length - takeover) + preedit).toBe(trace.expected.value);
      // This independently specified value also detects an unsuccessful native journey.
      expect(trace.events.at(-1)?.value).toBe(trace.expected.value);
      expect(state.proxy).toEqual(trace.expected.proxy);
      expect(state.caret).toBe(trace.expected.caret);
    });
  }
});
