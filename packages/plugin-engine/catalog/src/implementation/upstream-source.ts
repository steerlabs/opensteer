/**
 * Rewrite plugin source written for upstream's names with the rules in `upstream-names.json`. Each
 * rule applies only within its scope (the file says what each scope covers); a file no rule
 * changes keeps its exact bytes, so rewriting is idempotent and rewritten source rewrites to
 * itself. Migrations get only the reserved-table rule, on complete SQL identifiers (see
 * `renameReservedTables` in the framework's contracts).
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
  text.replace(new RegExp(`(?<![\\w$])${escape(rule.from)}(?![\\w$])`, "gu"), () => rule.to);

const codeFile = /\.(?:[cm]?[jt]sx?|html?|css|py|sh)$/u;
const hashComments = /\.(?:py|sh)$/u;
const migration = /^migrations\/[^/]+\.sql$/u;

/** Apply `rewrite` to the text of each comment in `source`, leaving strings and code alone. */
const inComments = (source: string, hashes: boolean, rewrite: (comment: string) => string) => {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    const lineComment = (char === "/" && next === "/") || (hashes && char === "#");
    if (lineComment || (char === "/" && next === "*")) {
      const close = source.indexOf(lineComment ? "\n" : "*/", index + (lineComment ? 1 : 2));
      const end = close === -1 ? source.length : lineComment ? close : close + 2;
      output += rewrite(source.slice(index, end));
      index = end;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < source.length && source[end] !== char && (char === "`" || source[end] !== "\n"))
        end += source[end] === "\\" ? 2 : 1;
      output += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const step = char === "\\" ? 2 : 1;
    output += source.slice(index, index + step);
    index += step;
  }
  return output;
};

const signingSecret = (text: string) =>
  scoped("signing-secret").reduce(
    (current, rule) =>
      current.replace(
        new RegExp(`(\\bsigningSecret\\s*:\\s*)(["'\`])${escape(rule.from)}\\2`, "gu"),
        (_match, key: string, quote: string) => `${key}${quote}${rule.to}${quote}`,
      ),
    text,
  );

const code = (path: string, text: string) => {
  let current = scoped("route-path", "element-id", "event", "ui-marker", "error-code").reduce(
    (value, rule) => literal(value, rule),
    text,
  );
  current = scoped("header").reduce((value, rule) => literal(value, rule, "giu"), current);
  current = scoped("reserved-table").reduce((value, rule) => literal(value, rule), current);
  current = signingSecret(current);
  const comments = scoped("code-comment");
  return inComments(current, hashComments.test(path), (comment) =>
    comments.reduce((value, rule) => word(value, rule), comment),
  );
};

/** package.json: the name's prefix and upstream-named keys; other bytes are kept when unchanged. */
const manifest = (text: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text;
  const keys = scoped("manifest-key");
  const names = scoped("manifest-name");
  let changed = false;
  const entries = Object.entries(parsed).map(([key, value]): [string, unknown] => {
    const renamed = keys.find((rule) => rule.from === key)?.to;
    if (key === "name" && typeof value === "string") {
      const rule = names.find((candidate) => value.startsWith(candidate.from));
      if (rule !== undefined) {
        changed = true;
        return [key, rule.to + value.slice(rule.from.length)];
      }
    }
    if (renamed === undefined) return [key, value];
    changed = true;
    return [renamed, value];
  });
  if (!changed) return text;
  const indent = /^[{[]\r?\n([ \t]+)/u.exec(text)?.[1] ?? "  ";
  return (
    JSON.stringify(Object.fromEntries(entries), null, indent) + (text.endsWith("\n") ? "\n" : "")
  );
};

/** One source file's new text, or its own text when no rule in scope applies. */
export const rewriteUpstreamFile = (path: string, text: string): string => {
  if (path === "package.json") return manifest(text);
  if (migration.test(path)) return renameReservedTables(text);
  if (path.endsWith(".md"))
    return scoped("readme-prose").reduce((value, rule) => word(value, rule), text);
  if (codeFile.test(path)) return code(path, text);
  return text;
};

/** Rewrite every text file; base64 and stored files are kept as they are. */
export const rewriteUpstreamSource = <
  File extends { readonly path: string } & ({ readonly content: string } | object),
>(
  files: ReadonlyArray<File>,
): { readonly files: File[]; readonly changed: boolean } => {
  let changed = false;
  const rewritten = files.map((file) => {
    if (!("content" in file) || typeof file.content !== "string" || "encoding" in file) return file;
    const content = rewriteUpstreamFile(file.path, file.content);
    if (content === file.content) return file;
    changed = true;
    return { ...file, content };
  });
  return { files: rewritten, changed };
};

/** A package name with the package-scope rule of `scope` applied. */
export const rewriteUpstreamPackage = (
  scope: "index-package" | "document-package",
  name: string,
): string => {
  const rule = scoped(scope).find((candidate) => name.startsWith(candidate.from));
  return rule === undefined ? name : rule.to + name.slice(rule.from.length);
};
