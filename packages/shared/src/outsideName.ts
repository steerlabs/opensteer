const breakOrTab = /\r\n|[\n\r\t\v\f\u0085\u2028\u2029\u2800]/gu;
const invisible = /^[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]$/u;
const extendedPictographic = /^\p{Extended_Pictographic}$/u;
const letterOrMark = /^[\p{L}\p{M}]$/u;
const latinOrShared = /^[\p{scx=Latin}\p{scx=Common}\p{scx=Inherited}]$/u;
/** What the cut never separates from the character before it. */
const continuation = /^[\p{M}\u200D\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const regionalIndicator = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const keycapBase = /^[#*0-9]$/u;

function isEmojiJoinerModifier(char: string): boolean {
  const code = char.codePointAt(0);
  return code === 0xfe0f || (code !== undefined && code >= 0x1f3fb && code <= 0x1f3ff);
}
const blackFlag = "\u{1F3F4}";
const subdivisionFlags = new Set([
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}",
]);

function keepEmojiJoiner(chars: readonly string[], index: number): boolean {
  const prev = chars[index - 1];
  const next = chars[index + 1];
  if (!prev || !next || !extendedPictographic.test(next)) return false;
  if (extendedPictographic.test(prev)) return true;
  const before = chars[index - 2];
  return Boolean(before && isEmojiJoinerModifier(prev) && extendedPictographic.test(before));
}

function keepEmojiSelector(chars: readonly string[], index: number): boolean {
  const prev = chars[index - 1];
  if (!prev) return false;
  return extendedPictographic.test(prev) || (keycapBase.test(prev) && chars[index + 1] === "\u20E3");
}

function keepScriptJoiner(chars: readonly string[], index: number): boolean {
  return [chars[index - 1], chars[index + 1]].every(
    (side) =>
      side !== undefined &&
      letterOrMark.test(side) &&
      !latinOrShared.test(side) &&
      !invisible.test(side),
  );
}

/**
 * A name from outside Opensteer (a connected agent's own name, the label a person typed at
 * consent, a chat's conversation, account or sender name, a task title taken from a chat's
 * message) as the Home keeps and serves it: the one cleaner, run where the name enters the Home
 * and in `0109` for stored rows, so no answer carries it dirty and no client cleans it again.
 *
 * Line and paragraph breaks, tabs and the braille blank become one space. Every control, format,
 * lone surrogate and Default_Ignorable_Code_Point (variation selectors, Hangul fillers, the
 * combining grapheme joiner, tags, ...) is removed, unless it is part of how the name is written:
 * (a) U+200C or U+200D directly between two letters or marks (`\p{L}`/`\p{M}`), neither of them
 *     Latin, Common or Inherited;
 * (b) U+200D directly between two emoji (Extended_Pictographic, optionally followed by U+FE0F or a
 *     skin-tone modifier U+1F3FB–U+1F3FF, before; Extended_Pictographic after), and U+FE0F
 *     directly after an emoji or inside a keycap (`#`, `*` or a digit, then U+20E3);
 * (c) the three subdivision-flag sequences exactly: U+1F3F4 + tags `gbeng`, `gbsct`, or `gbwls` +
 *     U+E007F.
 * Runs of whitespace collapse to one space, the ends are trimmed, and the name is cut at `maximum`
 * UTF-16 code units only where a character starts: never inside a surrogate pair, a flag, an
 * emoji sequence, a keycap, or a letter and its marks, and never leaving a trailing joiner.
 */
export function outsideName(value: string, maximum: number): string {
  const chars = Array.from(value.replace(breakOrTab, " "));
  let cleaned = "";
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === blackFlag) {
      const flag = chars.slice(i, i + 7).join("");
      if (subdivisionFlags.has(flag)) {
        cleaned += flag;
        i += 6;
        continue;
      }
    }
    if (
      !invisible.test(ch) ||
      (ch === "\u200D" && keepEmojiJoiner(chars, i)) ||
      (ch === "\uFE0F" && keepEmojiSelector(chars, i)) ||
      ((ch === "\u200C" || ch === "\u200D") && keepScriptJoiner(chars, i))
    )
      cleaned += ch;
  }
  const flat = cleaned.replace(/\s+/gu, " ").trim();
  if (flat.length <= maximum) return flat;
  const flatChars = Array.from(flat);
  let out = "";
  let character = "";
  let regionalRun = 0;
  for (let i = 0; i < flatChars.length; i += 1) {
    const ch = flatChars[i]!;
    const regional = regionalIndicator.test(ch);
    const continues =
      i > 0 &&
      (continuation.test(ch) || flatChars[i - 1] === "\u200D" || (regional && regionalRun % 2 === 1));
    regionalRun = regional ? regionalRun + 1 : 0;
    if (!continues) {
      if (out.length + character.length > maximum) break;
      out += character;
      character = "";
    }
    character += ch;
  }
  if (out.length + character.length <= maximum) out += character;
  return out.replace(/[\u200C\u200D]+$/u, "").trimEnd();
}
