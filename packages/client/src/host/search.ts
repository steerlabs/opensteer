/**
 * Finding tasks, tabs and apps by what a person types. One matcher serves the
 * sidebar, the start page and the phone, so a word finds the same things
 * everywhere and ranks them the same way.
 *
 * Text is prepared once (`searchText`) and a keystroke only scans it: every
 * typed word must start a word somewhere in the item, or, from three letters,
 * sit inside one in a field that allows it (a name, where a person remembers
 * part of a word). A word in the item's name counts most, a word in the
 * fields beside it by their weight, and the given order breaks ties.
 */

export interface SearchRange {
  readonly start: number;
  readonly end: number;
}

/** Text prepared for any number of queries. */
export interface SearchText {
  /** The text as given, which ranges point into. */
  readonly source: string;
  /** The text with case and Latin, Greek and Cyrillic accents folded away. */
  readonly folded: string;
  /** Where each unit of `folded` came from in the source: its character's start… */
  readonly from: readonly number[];
  /** …and its end, the accents after it included. */
  readonly to: readonly number[];
  /** 1 where a word starts in `folded`. */
  readonly starts: Uint8Array;
  /** `folded` trimmed, its runs of space one space, to compare with a whole query. */
  readonly phrase: string;
}

/** One field of an item: its prepared text and how much a word found in it counts. */
export interface SearchField {
  readonly text: SearchText;
  readonly weight: number;
  /** A typed word may sit inside one of its words, not only at a word's start. */
  readonly inside?: boolean;
  /** What the field is ("site", "profile"), for saying why an item matched. */
  readonly name?: string;
}

/** The folded words of a query; none when there is nothing to find. */
export type SearchQuery = readonly string[];

export interface SearchMatch {
  /** Higher is better. */
  readonly score: number;
  /** Where the query's words are in the first field, the item's name, in its source text. */
  readonly ranges: readonly SearchRange[];
  /**
   * The field that shows what the name does not: the heaviest one holding a
   * word the name lacks, and where. Null when the name holds every word.
   */
  readonly hint: { readonly field: number; readonly ranges: readonly SearchRange[] } | null;
}

/** A word inside another word counts from this many letters: "del" finds "model", "de" does not. */
const insideFrom = 3;
/** What a word found inside another word is worth beside one found at its start. */
const insideWorth = 0.4;
/** What the name equal to the query, or starting with it, adds. */
const wholeName = 1;
const nameStart = 0.5;

export function searchText(text: string): SearchText {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  const starts: number[] = [];
  let previous: Kind = Kind.None;
  for (let index = 0; index < text.length;) {
    const point = text.codePointAt(index)!;
    const end = index + (point > 0xffff ? 2 : 1);
    const plain = foldPoint(point, text.slice(index, end));
    if (plain === "") {
      // An accent belongs to the letter before it, and lights with it.
      if (to.length > 0) to[to.length - 1] = end;
      index = end;
      continue;
    }
    const kind = kindOf(point);
    const start =
      kind !== Kind.None &&
      (previous === Kind.None ||
        (kind === Kind.Upper && previous === Kind.Lower) ||
        (kind === Kind.Digit) !== (previous === Kind.Digit) ||
        cjk(point));
    for (let unit = 0; unit < plain.length; unit++) {
      from.push(index);
      to.push(end);
      starts.push(unit === 0 && start ? 1 : 0);
    }
    folded += plain;
    previous = kind;
    index = end;
  }
  return {
    source: text,
    folded,
    from,
    to,
    starts: Uint8Array.from(starts),
    phrase: folded.trim().replace(/\s+/gu, " "),
  };
}

export function searchQuery(query: string): SearchQuery {
  return searchText(query.normalize("NFC"))
    .folded.split(/\s+/u)
    .filter((word) => word.length > 0);
}

/** How well `query` matches an item's fields, the first its name; null unless every word is found. */
export function matchSearch(
  fields: readonly SearchField[],
  query: SearchQuery,
): SearchMatch | null {
  if (query.length === 0) return null;
  let total = 0;
  const ranges: SearchRange[] = [];
  // The words the name lacks, by the field that holds each best.
  const elsewhere = new Map<number, SearchRange[]>();
  for (const word of query) {
    let best = 0;
    let bestField = -1;
    let bestHit: SearchRange | null = null;
    let named = false;
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]!;
      const hit = find(field.text, word, field.inside === true);
      if (!hit) continue;
      const range = { start: field.text.from[hit.start]!, end: field.text.to[hit.end - 1]! };
      if (index === 0) {
        named = true;
        ranges.push(range);
      }
      const score = (hit.atStart ? 1 : insideWorth) * field.weight;
      if (score > best) {
        best = score;
        bestField = index;
        bestHit = range;
      }
    }
    if (!bestHit) return null;
    total += best;
    if (!named) elsewhere.set(bestField, [...(elsewhere.get(bestField) ?? []), bestHit]);
  }
  const name = fields[0]?.text.phrase ?? "";
  const phrase = query.join(" ");
  const bonus = name === phrase ? wholeName : name.startsWith(phrase) ? nameStart : 0;
  let hint: SearchMatch["hint"] = null;
  for (const [field, found] of elsewhere)
    if (!hint || fields[field]!.weight > fields[hint.field]!.weight)
      hint = { field, ranges: merged(found) };
  return { score: total / query.length + bonus, ranges: merged(ranges), hint };
}

/** The items that match, best first; equal matches keep the order given. */
export function rankSearch<T>(
  items: readonly T[],
  match: (item: T) => SearchMatch | null,
): Array<{ readonly item: T; readonly match: SearchMatch }> {
  const found: Array<{ readonly item: T; readonly match: SearchMatch }> = [];
  for (const item of items) {
    const result = match(item);
    if (result) found.push({ item, match: result });
  }
  return found.sort((a, b) => b.match.score - a.match.score);
}

/** The word's first place at a word's start, else, where allowed and long enough, inside one; in `folded`. */
function find(
  text: SearchText,
  word: string,
  inside: boolean,
): { readonly start: number; readonly end: number; readonly atStart: boolean } | null {
  let at = text.folded.indexOf(word);
  let within = -1;
  while (at !== -1) {
    // Typed punctuation starts where it stands: "(draft" or ".so".
    if (text.starts[at] === 1 || kindOf(text.folded.charCodeAt(at)) === Kind.None)
      return { start: at, end: at + word.length, atStart: true };
    if (within === -1) within = at;
    at = text.folded.indexOf(word, at + 1);
  }
  return inside && within !== -1 && word.length >= insideFrom
    ? { start: within, end: within + word.length, atStart: false }
    : null;
}

function merged(ranges: readonly SearchRange[]): SearchRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: SearchRange[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range.start <= last.end)
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    else out.push({ start: range.start, end: range.end });
  }
  return out;
}

const marks = /\p{M}/gu;
const lowercase = /\p{Ll}/u;
const uppercase = /\p{Lu}/u;
const digit = /\p{N}/u;
const letter = /\p{L}/u;

/**
 * One character, lowercased, a Latin, Greek or Cyrillic letter without its
 * accents ("é", "ﬁ" and "Ａ" read as "e", "fi" and "a"); an accent on its own
 * folds to nothing. Other scripts keep their marks: a kana's voicing changes
 * the word.
 */
function foldPoint(point: number, character: string): string {
  if (point < 0x80) return point >= 65 && point <= 90 ? String.fromCharCode(point + 32) : character;
  const decomposed = character.normalize("NFKD");
  const plain = decomposed.codePointAt(0)! < 0x0530 ? decomposed.replace(marks, "") : character;
  // A word's final sigma is still a sigma, and a phone's curly apostrophe a straight one.
  return plain.toLowerCase().replace("ς", "σ").replace(/[‘’]/u, "'");
}

/** What a character is, for where words start. */
const Kind = { None: 0, Lower: 1, Upper: 2, Digit: 3, Letter: 4 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

function kindOf(point: number): Kind {
  if (point < 0x80) {
    if (point >= 97 && point <= 122) return Kind.Lower;
    if (point >= 65 && point <= 90) return Kind.Upper;
    if (point >= 48 && point <= 57) return Kind.Digit;
    return Kind.None;
  }
  const character = String.fromCodePoint(point);
  if (lowercase.test(character)) return Kind.Lower;
  if (uppercase.test(character)) return Kind.Upper;
  if (digit.test(character)) return Kind.Digit;
  return letter.test(character) ? Kind.Letter : Kind.None;
}

/** Chinese and Japanese have no spaces, so each of their characters starts a word. */
function cjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}
