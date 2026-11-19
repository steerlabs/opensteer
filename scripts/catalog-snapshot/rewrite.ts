/**
 * Scoped rewrite rules for a catalog snapshot. A rule file is JSON data, never code:
 *
 *   {
 *     "version": 1,
 *     "variables": { "contact": "value" },     // optional; `{{contact}}` in a rule's `to` is the value
 *     "names": ["word"],                       // every remaining case-insensitive occurrence must be
 *                                              // preserved below or inside base64 data
 *     "engine": [{ "id", "scope", "from", "to" }],   // `package` and `manifest-key` rules only
 *     "rules": [{ "id", "scope", "from", "to", "documents"?, "files"? }],
 *     "preserve": [{ "text", "reason", "documents"? }]
 *   }
 *
 * `engine` holds the names the engine itself reads (the package scope, the `package.json` key), apart
 * from the rest, so it can later come from the engine's own rule file. Those scopes appear nowhere
 * else; engine rules apply before the others.
 *
 * Each rule applies only where its scope says; everything else is left as it is:
 *
 * - `package`: the index entry's `package`, the document's `package` and `package.json`'s `name`,
 *   which must stay equal.
 * - `manifest-key`: a top-level key of `package.json`, renamed in place.
 * - `markdown`: prose in `.md` files, outside fenced code blocks and inline code spans.
 * - `comments`: comments in JavaScript and TypeScript files (found by the TypeScript compiler), and
 *   full-line comments in Python files.
 * - `text`: the whole text of the named `files` in the named `documents`, for one-off edits.
 *
 * Text matching a `preserve` entry, a data URI or a long base64 run is never rewritten, and SQL under
 * a `migrations/` path is never touched. A `comments` or `markdown` rule that changes anything
 * outside its scope (for scripts, the non-comment token stream) is a problem. After rewriting,
 * `rewriteProblems` checks that what must not change did not.
 */
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import type * as TypeScript from "typescript-5";

const ts = createRequire(import.meta.url)("typescript-5") as typeof TypeScript;

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
const Rule = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)),
  scope: Schema.Literals(["package", "manifest-key", "markdown", "comments", "text"]),
  from: Schema.NonEmptyString,
  to: Schema.String,
  documents: Schema.optionalKey(strings),
  files: Schema.optionalKey(strings),
});
/** The scopes of the names the engine reads, which only the `engine` section holds. */
const engineScopes: readonly RuleScope[] = ["package", "manifest-key"];
const RulesFile = Schema.Struct({
  version: Schema.Literal(1),
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.NonEmptyString)),
  names: strings,
  engine: Schema.optionalKey(Schema.Array(Rule)),
  rules: Schema.Array(Rule),
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
    top: ["version", "variables", "names", "engine", "rules", "preserve"],
    rule: ["id", "scope", "from", "to", "documents", "files"],
    preserve: ["text", "reason", "documents"],
  };
  const unknown = (item: object, keys: string[]) =>
    Object.keys(item).find((k) => !keys.includes(k));
  const extra =
    unknown(value, allowed.top) ??
    [...((value.engine as object[] | undefined) ?? []), ...(value.rules as object[])]
      .map((rule) => unknown(rule, allowed.rule))
      .find(Boolean) ??
    (value.preserve as object[]).map((item) => unknown(item, allowed.preserve)).find(Boolean);
  if (extra !== undefined) throw new Error(`Not a rewrite rule file: unknown key ${extra}`);
  const { variables = {}, engine = [], ...rest } = decoded.success;
  for (const rule of engine)
    if (!engineScopes.includes(rule.scope) || rule.documents !== undefined)
      throw new Error(
        `Rule ${rule.id}: the engine section holds only package and manifest-key rules, for every document`,
      );
  for (const rule of rest.rules)
    if (engineScopes.includes(rule.scope))
      throw new Error(`Rule ${rule.id}: ${rule.scope} rules belong in the engine section`);
  // A rule's `to` may name a variable, so one value (a contact address) is set in one place.
  const rules: RewriteRules = {
    ...rest,
    rules: [...engine, ...rest.rules].map((rule) => ({
      ...rule,
      to: rule.to.replace(/\{\{([A-Za-z0-9_-]+)\}\}/gu, (_, name: string) => {
        if (!Object.hasOwn(variables, name))
          throw new Error(`Rule ${rule.id} names the variable ${name}, which is not set`);
        return variables[name]!;
      }),
    })),
  };
  const ids = new Set<string>();
  for (const rule of rules.rules) {
    if (ids.has(rule.id)) throw new Error(`The rule id ${rule.id} is used twice`);
    ids.add(rule.id);
    // A line break added to or removed from a comment can change the code after it (a `return`
    // followed by a line break returns nothing), and in prose can start a code block.
    if (
      (rule.scope === "comments" || rule.scope === "markdown") &&
      !isDeepStrictEqual(lineBreaks(rule.from), lineBreaks(rule.to))
    )
      throw new Error(
        `Rule ${rule.id}: a ${rule.scope} rule's replacement must have the same line breaks as what it replaces`,
      );
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

/** The line terminators in `text`, in order, as JavaScript counts them. */
const lineBreaks = (text: string) => text.match(/\r\n|[\n\r\u2028\u2029]/gu) ?? [];

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

/**
 * A JavaScript or TypeScript file as the TypeScript compiler reads it: its comments, and its
 * other tokens (kind, whether a line terminator precedes it, and text) in order. The parser decides
 * what a `/` or a `}` starts, so a regular expression or template is never mistaken for a comment
 * or the other way round. A preceding line terminator is part of a token because automatic
 * semicolon insertion depends on it: `return`, a block comment and `42` return 42 while the
 * comment stays on one line, and nothing once the comment holds a line break.
 */
export function scriptTokens(path: string, text: string) {
  const kind = /\.[cm]?tsx$/u.test(path)
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/u.test(path)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const comments: Range[] = [];
  const tokens: string[] = [];
  const found = new Set<number>();
  const visit = (node: TypeScript.Node) => {
    // JSDoc nodes describe comment text; the comment itself is trivia, found below.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const children = node.getChildren(file);
    if (children.length > 0) return children.forEach(visit);
    // A token: the trivia before it holds the comments, on its line and the lines before.
    for (const range of [
      ...(ts.getTrailingCommentRanges(text, node.pos) ?? []),
      ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
    ])
      if (!found.has(range.pos)) {
        found.add(range.pos);
        comments.push([range.pos, range.end]);
      }
    if (node.end > node.pos) {
      // What the scanner reports as a preceding line break: one in the trivia before the token,
      // including inside a multi-line comment.
      const start = node.getStart(file);
      const broken = lineBreaks(text.slice(node.pos, start)).length > 0;
      tokens.push(`${node.kind}:${broken ? "\n" : ""}:${text.slice(start, node.end)}`);
    }
  };
  visit(file);
  return { comments: comments.sort((a, b) => a[0] - b[0]), tokens };
}

/** Comments in JavaScript or TypeScript, found by the TypeScript compiler. */
export const scriptComments = (text: string, path = "file.ts") => scriptTokens(path, text).comments;

/**
 * Full-line comments in Python: a `#` with only indentation before it on its line, outside
 * strings. A comment after code on its line is left alone.
 */
export function pythonComments(text: string): Range[] {
  const comments: Range[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      const end = text.indexOf("\n", i);
      const lineStart = text.lastIndexOf("\n", i - 1) + 1;
      if (/^[ \t]*$/u.test(text.slice(lineStart, i)))
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
  scriptFile.test(path)
    ? scriptComments(text, path)
    : path.endsWith(".py")
      ? pythonComments(text)
      : [];
/** How many line terminators each comment holds. */
const commentBreaks = (path: string, text: string) =>
  commentRanges(path, text).map(([from, to]) => lineBreaks(text.slice(from, to)).length);
/** SQL migrations: the engine records each one's hash, so no rule may touch them. */
const migration = /(?:^|\/)migrations\/.*\.sql$/iu;

/** Text outside `ranges`, each range marked, for checking that only those ranges changed. */
const outside = (text: string, ranges: readonly Range[]) => {
  let rest = "";
  let last = 0;
  for (const [from, to] of ranges) {
    rest += text.slice(last, from) + "\u0000";
    last = to;
  }
  return rest + text.slice(last);
};
/** Whether a comments-only or prose-only edit left everything else exactly as it was. */
function onlyScopeChanged(path: string, scope: "comments" | "markdown", was: string, now: string) {
  if (scope === "markdown")
    return outside(was, markdownProse(was)) === outside(now, markdownProse(now));
  if (scriptFile.test(path))
    return isDeepStrictEqual(scriptTokens(path, was).tokens, scriptTokens(path, now).tokens);
  return outside(was, commentRanges(path, was)) === outside(now, commentRanges(path, now));
}

/** A top-level member of a JSON object's text: its key, and where its key and value are. */
interface Member {
  readonly key: string;
  readonly keyRange: Range;
  readonly valueRange: Range;
}
/**
 * The top-level members of a JSON object's text, by position, tracking depth and strings so a
 * nested key is never taken for a top-level one. The text must already parse as a JSON object.
 */
export function topLevelMembers(text: string): Member[] {
  const members: Member[] = [];
  let depth = 0;
  let key: { key: string; range: Range } | undefined;
  let valueStart = -1;
  let valueEnd = -1;
  const end = () => {
    if (key !== undefined)
      members.push({ key: key.key, keyRange: key.range, valueRange: [valueStart, valueEnd] });
    key = undefined;
    valueStart = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/u.test(c) || c === ":") continue;
    const start = i;
    if (c === '"') for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
    if (depth === 1 && c === ",") {
      end();
      continue;
    }
    if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        end();
        continue;
      }
    }
    if (depth === 1 && c === '"' && key === undefined)
      key = { key: JSON.parse(text.slice(start, i + 1)) as string, range: [start, i + 1] };
    else {
      if (depth === 1 && valueStart === -1) valueStart = start;
      valueEnd = i + 1;
    }
    if (c === "{" || c === "[") depth++;
  }
  return members;
}

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
      if (!isText(file) || migration.test(file.path)) return file;
      let content = file.content!;
      for (const rule of this.rules.rules) {
        if (rule.documents !== undefined && !rule.documents.includes(id)) continue;
        const was = content;
        if (rule.scope === "text" && rule.files!.includes(file.path))
          content = this.#replace(content, rule, id, [[0, content.length]]);
        else if (rule.scope === "markdown" && /\.md$/iu.test(file.path))
          content = this.#replace(content, rule, id, markdownProse(content));
        else if (rule.scope === "comments")
          content = this.#replace(content, rule, id, commentRanges(file.path, content));
        if (
          (rule.scope === "markdown" || rule.scope === "comments") &&
          content !== was &&
          !onlyScopeChanged(file.path, rule.scope, was, content)
        )
          problems.push(`${file.path}: rule ${rule.id} changed text outside its scope`);
        else if (
          rule.scope === "comments" &&
          content !== was &&
          !isDeepStrictEqual(commentBreaks(file.path, was), commentBreaks(file.path, content))
        )
          problems.push(`${file.path}: rule ${rule.id} changed the line breaks in a comment`);
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
        const found = topLevelMembers(output).filter((member) => member.key === "name");
        if (found.length !== 1)
          return { problem: "package.json's name could not be edited in place" };
        const [start, end] = found[0]!.valueRange;
        output = output.slice(0, start) + JSON.stringify(name) + output.slice(end);
        expected.name = name;
      }
    }
    for (const rule of this.rules.rules) {
      if (!this.#applies(rule, id, "manifest-key") || !Object.hasOwn(parsed, rule.from)) continue;
      const found = topLevelMembers(output).filter((member) => member.key === rule.from);
      if (found.length !== 1 || Object.hasOwn(parsed, rule.to))
        return { problem: `package.json's key for rule ${rule.id} could not be renamed in place` };
      const [start, end] = found[0]!.keyRange;
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
    if (migration.test(before.path)) problems.push(`${before.path}: a migration changed`);
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
