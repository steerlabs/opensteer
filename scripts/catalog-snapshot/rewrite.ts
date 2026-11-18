/**
 * Scoped rewrite rules for a catalog snapshot. A rule file is JSON data, never code:
 *
 *   {
 *     "version": 1,
 *     "names": ["word"],                       // every remaining case-insensitive occurrence must be
 *                                              // preserved below or inside base64 data
 *     "rules": [{ "id", "scope", "from", "to", "documents"?, "files"? }],
 *     "preserve": [{ "text", "reason", "documents"? }]
 *   }
 *
 * Each rule applies only where its scope says; everything else is left as it is:
 *
 * - `package`: the index entry's `package`, the document's `package` and `package.json`'s `name`,
 *   which must stay equal.
 * - `manifest-key`: a top-level key of `package.json`, renamed in place.
 * - `markdown`: prose in `.md` files, outside fenced code blocks and inline code spans.
 * - `comments`: comments in JavaScript, TypeScript and Python files.
 * - `text`: the whole text of the named `files` in the named `documents`, for one-off edits.
 *
 * Text matching a `preserve` entry, a data URI or a long base64 run is never rewritten. After
 * rewriting, `rewriteProblems` checks that what must not change did not.
 */
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";

export type RuleScope = "package" | "manifest-key" | "markdown" | "comments" | "text";
export interface RewriteRule {
  readonly id: string;
  readonly scope: RuleScope;
  readonly from: string;
  readonly to: string;
  /** Entry ids the rule is limited to. */
  readonly documents?: readonly string[];
  /** For `text`: the exact file paths it edits. */
  readonly files?: readonly string[];
}
export interface Preserved {
  readonly text: string;
  readonly reason: string;
  readonly documents?: readonly string[];
}
export interface RewriteRules {
  readonly version: 1;
  readonly names: readonly string[];
  readonly rules: readonly RewriteRule[];
  readonly preserve: readonly Preserved[];
}

const strings = Schema.Array(Schema.NonEmptyString);
const RulesFile = Schema.Struct({
  version: Schema.Literal(1),
  names: strings,
  rules: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)),
      scope: Schema.Literals(["package", "manifest-key", "markdown", "comments", "text"]),
      from: Schema.NonEmptyString,
      to: Schema.String,
      documents: Schema.optionalKey(strings),
      files: Schema.optionalKey(strings),
    }),
  ),
  preserve: Schema.Array(
    Schema.Struct({
      text: Schema.NonEmptyString,
      reason: Schema.NonEmptyString,
      documents: Schema.optionalKey(strings),
    }),
  ),
});
const decodeRules = Schema.decodeUnknownResult(Schema.fromJsonString(RulesFile));

/** Parse a rule file's text. Unknown keys, a repeated id or a `text` rule without files are refused. */
export function parseRules(text: string): RewriteRules {
  const decoded = decodeRules(text);
  if (decoded._tag === "Failure")
    throw new Error(`Not a rewrite rule file: ${decoded.failure.message}`);
  const value = JSON.parse(text) as Record<string, unknown>;
  const allowed = {
    top: ["version", "names", "rules", "preserve"],
    rule: ["id", "scope", "from", "to", "documents", "files"],
    preserve: ["text", "reason", "documents"],
  };
  const unknown = (item: object, keys: string[]) =>
    Object.keys(item).find((k) => !keys.includes(k));
  const extra =
    unknown(value, allowed.top) ??
    (value.rules as object[]).map((rule) => unknown(rule, allowed.rule)).find(Boolean) ??
    (value.preserve as object[]).map((item) => unknown(item, allowed.preserve)).find(Boolean);
  if (extra !== undefined) throw new Error(`Not a rewrite rule file: unknown key ${extra}`);
  const rules = decoded.success;
  const ids = new Set<string>();
  for (const rule of rules.rules) {
    if (ids.has(rule.id)) throw new Error(`The rule id ${rule.id} is used twice`);
    ids.add(rule.id);
    if ((rule.scope === "text") !== (rule.files !== undefined))
      throw new Error(
        `Rule ${rule.id}: files belong to text rules, and every text rule names them`,
      );
    if (rule.scope === "text" && rule.documents === undefined)
      throw new Error(`Rule ${rule.id}: a text rule names its documents`);
  }
  return rules;
}

/* ---- Where text may change ---- */

type Range = readonly [start: number, end: number];

/** Data URIs and long base64 runs: never rewritten, and compared byte for byte afterwards. */
export function encodedRuns(text: string): string[] {
  return text.match(/data:[^\s"'`<>()]+|[A-Za-z0-9+/]{64,}={0,2}/gu) ?? [];
}
function encodedRanges(text: string): Range[] {
  return [...text.matchAll(/data:[^\s"'`<>()]+|[A-Za-z0-9+/]{64,}={0,2}/gu)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
}
function occurrences(text: string, needle: string, ignoreCase = false): Range[] {
  const haystack = ignoreCase ? text.toLowerCase() : text;
  const target = ignoreCase ? needle.toLowerCase() : needle;
  const found: Range[] = [];
  for (let at = haystack.indexOf(target); at !== -1; at = haystack.indexOf(target, at + 1))
    found.push([at, at + target.length]);
  return found;
}
const overlaps = (a: Range, b: Range) => a[0] < b[1] && b[0] < a[1];
const within = (inner: Range, outer: Range) => inner[0] >= outer[0] && inner[1] <= outer[1];

/** Prose in Markdown: everything outside fenced code blocks and inline code spans. */
export function markdownProse(text: string): Range[] {
  const prose: Range[] = [];
  let start = 0;
  let fence: string | null = null;
  let position = 0;
  const segment = (from: number, to: number) => {
    // Inline code: a run of backticks closed by a run of the same length.
    let at = from;
    let cursor = from;
    while (cursor < to) {
      const open = text.indexOf("`", cursor);
      if (open === -1 || open >= to) break;
      let length = 1;
      while (text[open + length] === "`") length++;
      const ticks = "`".repeat(length);
      let close = text.indexOf(ticks, open + length);
      while (close !== -1 && close < to && text[close + length] === "`")
        close = text.indexOf(ticks, close + length + 1);
      if (close === -1 || close >= to) {
        cursor = open + length;
        continue;
      }
      prose.push([at, open]);
      at = cursor = close + length;
    }
    prose.push([at, to]);
  };
  for (const line of text.split(/(?<=\n)/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence === null && marker !== undefined) {
      segment(start, position);
      fence = marker;
    } else if (
      fence !== null &&
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length
    ) {
      fence = null;
      start = position + line.length;
    }
    position += line.length;
  }
  if (fence === null) segment(start, text.length);
  return prose.filter(([from, to]) => to > from);
}

const regexBefore = new Set("(,=:[!&|?{};+-*%<>~^");
const regexKeywords = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/** Comments in JavaScript or TypeScript, skipping strings, templates and regular expressions. */
export function scriptComments(text: string): Range[] {
  const comments: Range[] = [];
  const templates: number[] = [];
  let depth = 0;
  let previous = "";
  let i = 0;
  const template = () => {
    // Inside a template literal: until its closing backtick or a `${`.
    while (i < text.length) {
      const c = text[i]!;
      if (c === "\\") i += 2;
      else if (c === "`") {
        i++;
        previous = "a";
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        templates.push(depth);
        depth = 0;
        i += 2;
        previous = "{";
        return;
      } else i++;
    }
  };
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      comments.push([i, end === -1 ? text.length : end]);
      i = end === -1 ? text.length : end;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      comments.push([i, end === -1 ? text.length : end + 2]);
      i = end === -1 ? text.length : end + 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++;
      previous = "a";
    } else if (c === "`") {
      i++;
      template();
    } else if (c === "/" && (previous === "" || regexBefore.has(previous))) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n" && (inClass || text[j] !== "/")) {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        j++;
      }
      // An unterminated one was division after all.
      i = text[j] === "/" ? j + 1 : i + 1;
      previous = text[j] === "/" ? "a" : "/";
    } else if (/[A-Za-z0-9_$]/u.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_$]/u.test(text[j]!)) j++;
      previous = regexKeywords.has(text.slice(i, j)) ? "(" : "a";
      i = j;
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0 && templates.length > 0) {
          depth = templates.pop()!;
          i++;
          template();
          continue;
        }
        depth--;
      }
      if (!/\s/u.test(c)) previous = c === ")" || c === "]" ? ")" : c;
      i++;
    }
  }
  return comments;
}

/** Comments in Python, skipping single, double and triple-quoted strings. */
export function pythonComments(text: string): Range[] {
  const comments: Range[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      const end = text.indexOf("\n", i);
      comments.push([i, end === -1 ? text.length : end]);
      i = end === -1 ? text.length : end;
    } else if (c === "'" || c === '"') {
      const triple = text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      i += close.length;
      while (i < text.length && !text.startsWith(close, i) && (triple || text[i] !== "\n"))
        i += text[i] === "\\" ? 2 : 1;
      i += close.length;
    } else i++;
  }
  return comments;
}

const scriptFile = /\.(?:[cm]?[jt]sx?)$/u;
const commentRanges = (path: string, text: string): Range[] =>
  scriptFile.test(path) ? scriptComments(text) : path.endsWith(".py") ? pythonComments(text) : [];

/* ---- Applying rules ---- */

export interface SourceFile {
  readonly path: string;
  readonly content?: string;
  readonly encoding?: string;
  readonly [key: string]: unknown;
}
export interface Source {
  readonly package: string;
  readonly files: readonly SourceFile[];
  readonly [key: string]: unknown;
}

export interface Occurrence {
  readonly name: string;
  /** `<document>#<file>:<line>`, or `index.json#/apps/<n>/<field>`. */
  readonly location: string;
  readonly excerpt: string;
  /** The preserve entry's reason, `base64`, or null when nothing accounts for it. */
  readonly reason: string | null;
}

const isText = (file: SourceFile) =>
  typeof file.content === "string" && file.encoding === undefined;

/** Applies a rule set and accounts for every remaining name. */
export class Rewriter {
  readonly rules: RewriteRules;
  readonly counts = new Map<string, number>();
  readonly remaining: Occurrence[] = [];
  constructor(rules: RewriteRules) {
    this.rules = rules;
    for (const rule of rules.rules) this.counts.set(rule.id, 0);
  }

  #applies(rule: RewriteRule, document: string, scope: RuleScope) {
    return (
      rule.scope === scope && (rule.documents === undefined || rule.documents.includes(document))
    );
  }
  #protected(text: string, document: string): Range[] {
    return [
      ...encodedRanges(text),
      ...this.rules.preserve
        .filter((item) => item.documents === undefined || item.documents.includes(document))
        .flatMap((item) => occurrences(text, item.text)),
    ];
  }
  /** Replace `from` inside `editable`, outside protected text, counting for the rule. */
  #replace(text: string, rule: RewriteRule, document: string, editable: Range[]): string {
    const locked = this.#protected(text, document);
    let output = "";
    let last = 0;
    let count = 0;
    for (const range of occurrences(text, rule.from)) {
      if (range[0] < last) continue;
      if (!editable.some((outer) => within(range, outer))) continue;
      if (locked.some((lock) => overlaps(range, lock))) continue;
      output += text.slice(last, range[0]) + rule.to;
      last = range[1];
      count++;
    }
    this.counts.set(rule.id, this.counts.get(rule.id)! + count);
    return output + text.slice(last);
  }
  #packageName(name: string, document: string): string {
    return this.rules.rules
      .filter((rule) => this.#applies(rule, document, "package"))
      .reduce((value, rule) => this.#replace(value, rule, document, [[0, value.length]]), name);
  }

  /** An index entry: only its `package` changes. */
  entry<T extends { id: string; package: string }>(entry: T): T {
    return { ...entry, package: this.#packageName(entry.package, entry.id) };
  }

  /** A source document. Problems are edits that could not be made exactly. */
  document(id: string, source: Source): { source: Source; problems: string[] } {
    const problems: string[] = [];
    const files = source.files.map((file): SourceFile => {
      if (!isText(file)) return file;
      let content = file.content!;
      for (const rule of this.rules.rules) {
        if (rule.documents !== undefined && !rule.documents.includes(id)) continue;
        if (rule.scope === "text" && rule.files!.includes(file.path))
          content = this.#replace(content, rule, id, [[0, content.length]]);
        else if (rule.scope === "markdown" && /\.md$/iu.test(file.path))
          content = this.#replace(content, rule, id, markdownProse(content));
        else if (rule.scope === "comments")
          content = this.#replace(content, rule, id, commentRanges(file.path, content));
      }
      if (file.path === "package.json") {
        const edited = this.#manifest(id, content);
        if (typeof edited === "string") content = edited;
        else problems.push(edited.problem);
      }
      return content === file.content ? file : { ...file, content };
    });
    return {
      source: { ...source, package: this.#packageName(source.package, id), files },
      problems,
    };
  }

  /** `package.json`: its name and renamed top-level keys, edited in place. */
  #manifest(id: string, text: string): string | { problem: string } {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return text;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return text;
    let output = text;
    const expected = { ...parsed };
    if (typeof parsed.name === "string") {
      const name = this.#packageName(parsed.name, id);
      if (name !== parsed.name) {
        const token = /("name"\s*:\s*)"(?:[^"\\]|\\.)*"/u.exec(output);
        if (token === null) return { problem: "package.json's name could not be edited in place" };
        output =
          output.slice(0, token.index) +
          token[1] +
          JSON.stringify(name) +
          output.slice(token.index + token[0].length);
        expected.name = name;
      }
    }
    for (const rule of this.rules.rules) {
      if (!this.#applies(rule, id, "manifest-key") || !Object.hasOwn(parsed, rule.from)) continue;
      const tokens = occurrences(output, `${JSON.stringify(rule.from)}`).filter(([, end]) =>
        /^\s*:/u.test(output.slice(end)),
      );
      if (tokens.length !== 1 || Object.hasOwn(parsed, rule.to))
        return { problem: `package.json's key for rule ${rule.id} could not be renamed in place` };
      const [start, end] = tokens[0]!;
      output = output.slice(0, start) + JSON.stringify(rule.to) + output.slice(end);
      expected[rule.to] = expected[rule.from];
      delete expected[rule.from];
      this.counts.set(rule.id, this.counts.get(rule.id)! + 1);
    }
    let result: unknown;
    try {
      result = JSON.parse(output);
    } catch {
      return { problem: "package.json does not parse after rewriting" };
    }
    return isDeepStrictEqual(result, expected)
      ? output
      : { problem: "package.json changed beyond its name and renamed keys" };
  }

  /** Record every remaining name in one string, and why it stays. */
  account(document: string, location: string, text: string) {
    if (this.rules.names.length === 0) return;
    const preserved = this.rules.preserve
      .filter((item) => item.documents === undefined || item.documents.includes(document))
      .flatMap((item) => occurrences(text, item.text).map((range) => ({ range, item })));
    const encoded = encodedRanges(text);
    for (const name of this.rules.names)
      for (const range of occurrences(text, name, true)) {
        const kept = preserved.find(({ range: span }) => within(range, span));
        const line = text.slice(0, range[0]).split("\n").length;
        const lineStart = text.lastIndexOf("\n", range[0]) + 1;
        this.remaining.push({
          name,
          location: `${location}:${line}`,
          excerpt: text.slice(Math.max(lineStart, range[0] - 60), range[1] + 60).split("\n")[0]!,
          reason:
            kept?.item.reason ?? (encoded.some((span) => within(range, span)) ? "base64" : null),
        });
      }
  }
  /** Every string of a document, for `account`. */
  accountSource(id: string, document: string, source: Source) {
    this.account(id, `${document}#package`, source.package);
    for (const file of source.files) {
      this.account(id, `${document}#${file.path} (path)`, file.path);
      if (isText(file)) this.account(id, `${document}#${file.path}`, file.content!);
    }
  }
}

/* ---- What must not change ---- */

const relativeImports = (text: string) =>
  [
    ...text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\1/gu,
    ),
  ].map((match) => match[2]!);

/** Whether a relative import from `from` names a file in the document, as a bundler resolves it. */
export function resolvesIn(paths: ReadonlySet<string>, from: string, specifier: string): boolean {
  const base = new URL(from, "file:///document/");
  const target = new URL(specifier, base).pathname;
  if (!target.startsWith("/document/")) return false;
  const path = decodeURIComponent(target.slice("/document/".length));
  const stem = path.replace(/\.[cm]?js$/u, "");
  const candidates = [
    path,
    ...["", "/index"].flatMap((suffix) =>
      [".ts", ".tsx", ".mts", ".js", ".mjs", ".json"].map((ext) => `${stem}${suffix}${ext}`),
    ),
  ];
  return candidates.some((candidate) => paths.has(candidate.replace(/^\/+/u, "")));
}

/**
 * What changed that a rewrite must never change: the file list, non-text files, data URIs and
 * base64 runs, JSON that parsed, and relative imports, each of which must still name a file.
 */
export function rewriteProblems(original: Source, output: Source): string[] {
  const problems: string[] = [];
  const paths = new Set(output.files.map((file) => file.path));
  if (
    !isDeepStrictEqual(
      original.files.map((file) => file.path),
      output.files.map((file) => file.path),
    )
  )
    return ["the file list changed"];
  for (const [index, before] of original.files.entries()) {
    const after = output.files[index]!;
    if (!isText(before)) {
      if (!isDeepStrictEqual(before, after))
        problems.push(`${before.path}: a non-text file changed`);
      continue;
    }
    const was = before.content!;
    const now = after.content!;
    if (was === now) continue;
    if (!isDeepStrictEqual(encodedRuns(was), encodedRuns(now)))
      problems.push(`${before.path}: a data URI or base64 run changed`);
    if (before.path.endsWith(".json")) {
      const parses = (text: string) => {
        try {
          JSON.parse(text);
          return true;
        } catch {
          return false;
        }
      };
      if (parses(was) && !parses(now)) problems.push(`${before.path}: no longer parses as JSON`);
    }
    if (scriptFile.test(before.path)) {
      const imports = relativeImports(now);
      if (!isDeepStrictEqual(relativeImports(was), imports))
        problems.push(`${before.path}: a relative import changed`);
    }
  }
  // An import that named a file before must still name one; some test files import helpers
  // from upstream's repository that no document carries, and those stay as they were.
  const before = new Set(original.files.map((file) => file.path));
  for (const [index, file] of output.files.entries())
    if (isText(file) && scriptFile.test(file.path))
      for (const specifier of relativeImports(file.content!))
        if (
          resolvesIn(before, original.files[index]!.path, specifier) &&
          !resolvesIn(paths, file.path, specifier)
        )
          problems.push(`${file.path}: ${specifier} names no file in the document`);
  return problems;
}
