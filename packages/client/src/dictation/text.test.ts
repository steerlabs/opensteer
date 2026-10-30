import { expect, it } from "vitest";
import { insertDictationText, joinDictationText } from "./text.js";

it.each([
  ["Hello.", "Next", "Hello. Next"],
  ["Hello", "world", "Hello world"],
  ["Hello ", "world", "Hello world"],
  ["Hello", ".", "Hello."],
  ["Hello", ", then", "Hello, then"],
  ["(", "note", "(note"],
  ["note", ")", "note)"],
  ["said", '"Hi"', 'said "Hi"'],
  ["café", "noir", "café noir"],
  ["123", "apples", "123 apples"],
  ["日本語", "です", "日本語です"],
  ["Hello", "世界", "Hello世界"],
  ["สวัสดี", "ครับ", "สวัสดีครับ"],
  ["안녕하세요", "반갑습니다", "안녕하세요 반갑습니다"],
  ["", "Hello", "Hello"],
  ["Hello", "\nworld", "Hello\nworld"],
  ["word)", "(next)", "word) (next)"],
  ["“word”", "“next”", "“word” “next”"],
  ["𐐀", "𐐁", "𐐀 𐐁"],
  ["ລາວ", "ລາວ", "ລາວລາວ"],
  ["ខ្មែរ", "ខ្មែរ", "ខ្មែរខ្មែរ"],
  ["မြန်မာ", "မြန်မာ", "မြန်မာမြန်မာ"],
])("joins %j and %j without changing segment contents", (left, right, result) => {
  expect(joinDictationText([left!, right!])).toBe(result);
});

it.each([
  ["Hi there", 2, 2, "my", "Hi my there", 5],
  ["there", 0, 0, "Hello", "Hello there", 5],
  ["a bad day", 2, 5, "good", "a good day", 6],
  ["😀there", 2, 2, "Hello", "😀Hello there", 7],
  ["😀there", 1, 1, "Hello", "Hello😀there", 5],
  ["a😀b", 1, 2, "good", "a good b", 6],
])("inserts in %j at UTF-16 range %i..%i", (draft, start, end, transcript, result, caret) => {
  expect(insertDictationText(draft, { start, end }, transcript)).toEqual({
    text: result,
    selection: { start: caret, end: caret },
  });
});
