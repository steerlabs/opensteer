export interface DictationSelection {
  start: number;
  end: number;
}

const mark = /\p{M}/u;
const unspaced =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const leftWord = /[\p{L}\p{N}\p{Pe}\p{Pf}.,!?;:…"']/u;
const rightWord = /[\p{L}\p{N}\p{Ps}\p{Pi}"']/u;

/** Only the boundary changes; Apple's segment text and the draft remain verbatim. */
export function joinDictationText(segments: readonly string[]): string {
  return segments.reduce((left, right) => left + dictationBoundary(left, right) + right, "");
}

function dictationBoundary(left: string, right: string): string {
  if (!left || !right || /\s$/u.test(left) || /^\s/u.test(right)) return "";
  let index = left.length;
  let last = "";
  // Inspect only the boundary, rather than allocating code points for the whole draft.
  while (index > 0) {
    const start = safeOffset(left, index - 1, false);
    last = left.slice(start, index);
    index = start;
    if (!mark.test(last)) break;
    last = "";
  }
  const first = String.fromCodePoint(right.codePointAt(0)!);
  return last &&
    first &&
    leftWord.test(last) &&
    rightWord.test(first) &&
    !unspaced.test(last) &&
    !unspaced.test(first)
    ? " "
    : "";
}

function safeOffset(text: string, offset: number, forward: boolean): number {
  const index = Math.max(0, Math.min(text.length, Math.trunc(offset)));
  // Text inputs use UTF-16; an imprecise caller must never cut an emoji in half.
  if (
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/u.test(text[index - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(text[index]!)
  )
    return index + (forward ? 1 : -1);
  return index;
}

export function insertDictationText(
  text: string,
  selection: DictationSelection,
  transcript: string,
): { text: string; selection: DictationSelection } {
  const start = safeOffset(text, Math.min(selection.start, selection.end), false);
  const end = safeOffset(
    text,
    Math.max(selection.start, selection.end),
    selection.start !== selection.end,
  );
  const left = text.slice(0, start);
  const right = text.slice(end);
  const inserted = left + dictationBoundary(left, transcript) + transcript;
  const caret = inserted.length;
  return {
    text: inserted + dictationBoundary(inserted, right) + right,
    selection: { start: caret, end: caret },
  };
}
