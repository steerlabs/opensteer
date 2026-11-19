/**
 * The one rewriter of plugin source written for upstream's framework: the rules in
 * `upstream-names.json`, the renames such source needs to build and run on Opensteer's framework.
 * The Host's rebuild of installed plugins and the catalog snapshot both use it, so the same source
 * always becomes the same bytes. Each rule applies only within its scope (the file says what each
 * scope covers); a file no rule changes keeps its exact bytes, so rewriting is idempotent and
 * rewritten source rewrites to itself. Prose and comments are not touched.
 */
import { renameReservedTables } from "apps/contracts";
import upstreamNames from "../../../upstream-names.json" with { type: "json" };

interface Rule {
  readonly scope: string;
  readonly from: string;
  readonly to: string;
}
const rules: readonly Rule[] = upstreamNames.rules;
const scoped = (...scopes: string[]) => rules.filter((rule) => scopes.includes(rule.scope));

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const literal = (text: string, rule: Rule, flags = "gu") =>
  text.replace(new RegExp(escape(rule.from), flags), () => rule.to);
const word = (text: string, rule: Rule) =>
  text.replace(new RegExp(`(?<![\\w$])${escape(rule.from)}(?![\\w$])`, "giu"), () => rule.to);

const codeFile = /\.(?:[cm]?[jt]sx?|html?|css|py|sh)$/u;
const migration = /^migrations\/[^/]+\.sql$/u;

const signingSecret = (text: string) =>
  scoped("signing-secret").reduce(
    (current, rule) =>
      current.replace(
        new RegExp(`(\\bsigningSecret\\s*:\\s*)(["'\`])${escape(rule.from)}\\2`, "gu"),
        (_match, key: string, quote: string) => `${key}${quote}${rule.to}${quote}`,
      ),
    text,
  );

/**
 * A reserved route only where it is one of the plugin's own routes: a root-relative path literal,
 * a string that starts with the route. Absolute and protocol-relative URLs, which name another
 * site's paths, comments and other strings keep their bytes.
 */
const route = (text: string, rule: Rule) =>
  text.replace(new RegExp(`(?<=["'\`])${escape(rule.from)}`, "gu"), () => rule.to);

const code = (text: string) => {
  let current = scoped("route-path").reduce((value, rule) => route(value, rule), text);
  current = scoped("element-id", "event", "ui-marker", "error-code").reduce(
    (value, rule) => literal(value, rule),
    current,
  );
  current = scoped("header").reduce((value, rule) => literal(value, rule, "giu"), current);
  current = scoped("reserved-table").reduce((value, rule) => word(value, rule), current);
  return signingSecret(current);
};

/** A package name with the package rule applied. */
export const rewriteUpstreamPackage = (name: string): string => {
  const rule = scoped("package").find((candidate) => name.startsWith(candidate.from));
  return rule === undefined ? name : rule.to + name.slice(rule.from.length);
};

/** JSON text with object keys sorted, to compare values whatever their keys' order. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

/**
 * The members of a JSON document's top-level object, in order, with where each key's string and
 * each value sit in the text. The text has parsed as an object.
 */
const topLevelMembers = (text: string) => {
  const members: {
    key: string;
    keyStart: number;
    keyEnd: number;
    valueStart: number;
    valueEnd: number;
  }[] = [];
  let depth = 0;
  let expectKey = false;
  let current: (typeof members)[number] | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (depth === 1 && expectKey) {
        current = {
          key: JSON.parse(text.slice(index, end + 1)) as string,
          keyStart: index,
          keyEnd: end + 1,
          valueStart: -1,
          valueEnd: -1,
        };
        expectKey = false;
      }
      index = end;
    } else if (char === ":" && depth === 1 && current !== undefined && current.valueStart < 0) {
      current.valueStart = index + 1;
      while (/\s/u.test(text[current.valueStart]!)) current.valueStart++;
    } else if (char === "{" || char === "[") {
      depth++;
      if (depth === 1) expectKey = true;
    } else if (char === "}" || char === "]" || (char === "," && depth === 1)) {
      if (depth === 1 && current !== undefined) {
        let end = index;
        while (/\s/u.test(text[end - 1]!)) end--;
        members.push({ ...current, valueEnd: end });
        current = undefined;
      }
      if (char === ",") expectKey = true;
      else depth--;
    }
  }
  return members;
};

/**
 * package.json, edited in place: the name's prefix and the renamed top-level keys, every other byte
 * kept. A problem when it holds a key under both names, or an edit would change anything else.
 */
const manifest = (text: string): string | { readonly problem: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text;
  const expected: Record<string, unknown> = { ...parsed };
  let output = text;
  // Edits run from the end of the text, so each member's offsets stay where they were read.
  const edits: { start: number; end: number; text: string }[] = [];
  const members = topLevelMembers(text);
  const member = (key: string) => members.filter((candidate) => candidate.key === key);
  if (typeof expected.name === "string") {
    const name = rewriteUpstreamPackage(expected.name);
    const [token] = member("name");
    if (name !== expected.name && token !== undefined) {
      edits.push({ start: token.valueStart, end: token.valueEnd, text: JSON.stringify(name) });
      expected.name = name;
    }
  }
  for (const { from, to } of scoped("manifest-key")) {
    if (!Object.hasOwn(expected, from)) continue;
    if (Object.hasOwn(expected, to))
      return { problem: `package.json has both "${from}" and "${to}"; keep only "${to}".` };
    const found = member(from);
    if (found.length !== 1) return { problem: `package.json's "${from}" could not be renamed.` };
    edits.push({ start: found[0]!.keyStart, end: found[0]!.keyEnd, text: JSON.stringify(to) });
    expected[to] = expected[from];
    delete expected[from];
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  if (output === text) return text;
  let result: unknown;
  try {
    result = JSON.parse(output);
  } catch {
    return { problem: "package.json does not parse after its names were rewritten." };
  }
  return canonical(result) === canonical(expected)
    ? output
    : { problem: "package.json changed beyond its name and renamed keys." };
};

/** One source file's new text, or its own text when no rule in scope applies. */
export const rewriteUpstreamFile = (
  path: string,
  text: string,
): string | { readonly problem: string } => {
  if (path === "package.json") return manifest(text);
  if (migration.test(path)) return renameReservedTables(text);
  if (codeFile.test(path)) return code(text);
  return text;
};

/**
 * Rewrite every text file of a plugin's source; base64 and stored files are kept as they are.
 * `problems` lists what could not be rewritten exactly, by path; a file with one keeps its bytes.
 */
export const rewriteUpstreamSource = <
  File extends { readonly path: string } & ({ readonly content: string } | object),
>(
  files: ReadonlyArray<File>,
): { readonly files: File[]; readonly changed: boolean; readonly problems: string[] } => {
  let changed = false;
  const problems: string[] = [];
  const rewritten = files.map((file) => {
    if (!("content" in file) || typeof file.content !== "string" || "encoding" in file) return file;
    const content = rewriteUpstreamFile(file.path, file.content);
    if (typeof content !== "string") {
      problems.push(`${file.path}: ${content.problem}`);
      return file;
    }
    if (content === file.content) return file;
    changed = true;
    return { ...file, content };
  });
  return { files: rewritten, changed, problems };
};
