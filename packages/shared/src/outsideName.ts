const breakOrTab = /\r\n|[\n\r\t\v\f\u0085\u2028\u2029]/gu;
const controlOrFormat = /^[\p{Cc}\p{Cf}]$/u;
const extendedPictographic = /^\p{Extended_Pictographic}$/u;
const letterOrMark = /^[\p{L}\p{M}]$/u;

function isEmojiJoinerModifier(char: string): boolean {
  const code = char.codePointAt(0);
  return code === 0xfe0f || (code !== undefined && code >= 0x1f3fb && code <= 0x1f3ff);
}
const joinerScripts = [
  /^\p{scx=Arabic}$/u,
  /^\p{scx=Syriac}$/u,
  /^\p{scx=Mongolian}$/u,
  /^\p{scx=Nko}$/u,
  /^\p{scx=Devanagari}$/u,
  /^\p{scx=Bengali}$/u,
  /^\p{scx=Gurmukhi}$/u,
  /^\p{scx=Gujarati}$/u,
  /^\p{scx=Oriya}$/u,
  /^\p{scx=Tamil}$/u,
  /^\p{scx=Telugu}$/u,
  /^\p{scx=Kannada}$/u,
  /^\p{scx=Malayalam}$/u,
  /^\p{scx=Sinhala}$/u,
  /^\p{scx=Myanmar}$/u,
  /^\p{scx=Khmer}$/u,
];
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

function keepScriptJoiner(chars: readonly string[], index: number): boolean {
  const prev = chars[index - 1];
  const next = chars[index + 1];
  if (!prev || !next || !letterOrMark.test(prev) || !letterOrMark.test(next)) return false;
  return joinerScripts.some((script) => script.test(prev) && script.test(next));
}

/**
 * A name from outside Opensteer (a connected agent's own name, the label a person typed at
 * consent, a chat's conversation, account or sender name, a task title taken from a chat's
 * message) as the Home keeps and serves it: the one cleaner, run where the name enters the Home
 * and in `0053` for stored rows, so no answer carries it dirty and no client cleans it again.
 *
 * Line and paragraph breaks and tabs become one space. A control or format character (Unicode Cc
 * and Cf) is removed unless it is part of how the name is written — three exceptions only:
 * (a) U+200D directly between two emoji (Extended_Pictographic, optionally followed by U+FE0F or a
 *     skin-tone modifier U+1F3FB–U+1F3FF, before; Extended_Pictographic after);
 * (b) U+200C or U+200D directly between two letters or marks (`\p{L}`/`\p{M}`) of a script that
 *     uses joiners (Arabic, Syriac, Mongolian, N'Ko, Devanagari, Bengali, Gurmukhi, Gujarati,
 *     Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala, Myanmar, Khmer);
 * (c) the three subdivision-flag sequences exactly: U+1F3F4 + tags `gbeng`, `gbsct`, or `gbwls` +
 *     U+E007F.
 * Runs of whitespace collapse to one space, the ends are trimmed, and the name is cut at `maximum`
 * UTF-16 code units without splitting a surrogate pair, leaving a trailing joiner, or splitting a
 * subdivision flag.
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
    if (!controlOrFormat.test(ch)) {
      cleaned += ch;
      continue;
    }
    if (ch === "\u200D" && keepEmojiJoiner(chars, i)) {
      cleaned += ch;
      continue;
    }
    if ((ch === "\u200C" || ch === "\u200D") && keepScriptJoiner(chars, i)) {
      cleaned += ch;
    }
  }
  const flat = cleaned.replace(/\s+/gu, " ").trim();
  if (flat.length <= maximum) return flat;
  const flatChars = Array.from(flat);
  let out = "";
  for (let i = 0; i < flatChars.length; i += 1) {
    let token = flatChars[i]!;
    let step = 0;
    if (token === blackFlag) {
      const flag = flatChars.slice(i, i + 7).join("");
      if (subdivisionFlags.has(flag)) {
        token = flag;
        step = 6;
      }
    }
    if (out.length + token.length > maximum) break;
    out += token;
    i += step;
  }
  return out.replace(/[\u200C\u200D]+$/u, "").trimEnd();
}
