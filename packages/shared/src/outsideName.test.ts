import { expect, it } from "vitest";
import { outsideName } from "./outsideName.js";

const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
const wales = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}";
const unknownTagFlag = "\u{1F3F4}\u{E0075}\u{E0073}\u{E0063}\u{E0061}\u{E007F}";

it.each([
  // Kept byte for byte: emoji ZWJ (plain, FE0F, skin-tone), joiner scripts, and the 3 subdivision flags.
  ["an emoji ZWJ sequence", "👩\u200D💻", "👩\u200D💻"],
  ["an emoji ZWJ sequence with FE0F", "🏳\uFE0F\u200D🌈", "🏳\uFE0F\u200D🌈"],
  ["an emoji ZWJ sequence with a skin-tone modifier", "👩🏽\u200D💻", "👩🏽\u200D💻"],
  ["Persian ZWNJ", "می\u200Cخواهم", "می\u200Cخواهم"],
  ["Sinhala ZWJ", "ශ්\u200Dරී", "ශ්\u200Dරී"],
  ["Bengali ZWJ", "র\u200D্য", "র\u200D্য"],
  [
    "an Adlam ZWJ (a joining script with no list entry)",
    "\u{1E900}‍\u{1E901}",
    "\u{1E900}‍\u{1E901}",
  ],
  ["U+FE0F after an emoji", "☺️", "☺️"],
  ["a keycap", "1️⃣", "1️⃣"],
  ["the flag of England", england, england],
  ["the flag of Scotland", scotland, scotland],
  ["the flag of Wales", wales, wales],
  // Removed: direction controls, non-exception joiners, unknown tags, other Cc/Cf.
  ["a forged agent name (U+202E)", "Helper\u202E\nDisconnected", "Helper Disconnected"],
  [
    "a forged channel name (U+202E)",
    "#ops\u202E\nOnly you can message this chat",
    "#ops Only you can message this chat",
  ],
  ["a ZWJ between Latin letters", "Team\u200DChat", "TeamChat"],
  ["a joiner at the start (emoji)", "\u200D👩", "👩"],
  ["a joiner at the start (Arabic)", "\u200Cمی", "می"],
  ["a joiner at the end (emoji)", "👩\u200D", "👩"],
  ["a joiner at the end (Arabic)", "می\u200C", "می"],
  ["a doubled joiner (emoji)", "👩\u200D\u200D💻", "👩💻"],
  ["a doubled joiner (Arabic)", "می\u200C\u200Cخواهم", "میخواهم"],
  ["a joiner between Arabic and Latin", "م\u200CA", "مA"],
  ["a joiner between Latin and Arabic", "A\u200Dم", "Aم"],
  ["a tag sequence that is not one of the three", unknownTagFlag, "\u{1F3F4}"],
  ["a tab", "Work\tOps", "Work Ops"],
  ["a soft hyphen", "evil\u00ADgoogle.com", "evilgoogle.com"],
  ["an isolate", "\u2067Alice\u2069", "Alice"],
  ["runs of space and a line separator", "  Alice \u2028  Bob  ", "Alice Bob"],
  ["Unicode whitespace only", "\u00A0\u2003\u3000", ""],
  // Removed: every other Default_Ignorable_Code_Point, and a lone surrogate.
  ["a combining grapheme joiner", "Alice͏", "Alice"],
  ["a variation selector after a letter", "Ali️ce", "Alice"],
  ["U+FE0F after a digit that is no keycap", "Bob1️", "Bob1"],
  ["an ideographic variation selector", "葛\u{E0100}", "葛"],
  ["unassigned default-ignorables", "Bob\u{E0080}⁥￰", "Bob"],
  ["a Mongolian variation selector", "Bob᠋", "Bob"],
  ["Khmer inherent vowels", "Bob឴឵", "Bob"],
  ["a name of only Hangul fillers", "ㅤᅟᅠﾠ", ""],
  ["a joiner between Hangul fillers", "ᅟ‍ᅟ", ""],
  ["a lone surrogate", "\uD800Alice\uDFFF", "Alice"],
  ["the braille blank", "⠁⠀⠃", "⠁ ⠃"],
])("cleans %s idempotently", (_what, value, cleaned) => {
  const once = outsideName(value, 160);
  expect(once).toBe(cleaned);
  expect(outsideName(once, 160)).toBe(once);
});

it("cuts a long name at its UTF-16 maximum, never inside a surrogate pair, sequence, or flag", () => {
  expect(outsideName("x".repeat(5_000), 160)).toHaveLength(160);
  const emoji = outsideName("😀".repeat(200), 160);
  expect(emoji.length).toBe(160);
  expect(Array.from(emoji)).toHaveLength(80);
  expect(emoji.isWellFormed()).toBe(true);
  const odd = outsideName(`a${"😀".repeat(200)}`, 160);
  expect(odd.length).toBe(159);
  expect(odd.isWellFormed()).toBe(true);
  expect(outsideName(`a${"😀".repeat(200)}`, 1)).toBe("a");
  expect(outsideName("😀".repeat(200), 1)).toBe("");
  // An emoji sequence, a flag, a skin tone or a keycap is kept whole or left out, never cut.
  const cutEmoji = outsideName("a\u{1F469}‍\u{1F4BB}", 4);
  expect(cutEmoji).toBe("a");
  expect(outsideName(cutEmoji, 4)).toBe(cutEmoji);
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
  expect(outsideName(`a${family}`, 6)).toBe("a");
  expect(outsideName(`a${family}b`, 9)).toBe(`a${family}`);
  const us = "\u{1F1FA}\u{1F1F8}";
  expect(outsideName(`a${us}`, 3)).toBe("a");
  expect(outsideName(`a${us}\u{1F1EB}\u{1F1F7}`, 5)).toBe(`a${us}`);
  expect(outsideName("a\u{1F44D}\u{1F3FD}", 3)).toBe("a");
  expect(outsideName("a1️⃣", 3)).toBe("a");
  expect(outsideName("aक्ष", 3)).toBe("aक्");
  // Cutting right where a ZWNJ falls leaves no trailing joiner and stays idempotent.
  const cutPersian = outsideName("می\u200Cخواهم", 3);
  expect(cutPersian).toBe("می");
  expect(outsideName(cutPersian, 3)).toBe(cutPersian);
  // Cutting mid-subdivision-flag drops the flag whole rather than corrupting it to a black flag.
  const cutFlag = outsideName(`a ${england}`, 10);
  expect(cutFlag).toBe("a");
  expect(outsideName(cutFlag, 10)).toBe(cutFlag);
});
