import { parse } from "@babel/parser";

type SyntaxNode = Record<string, unknown>;
const sqlKindSelector = String.raw`(?:(?:\w+\.)?(?:deployment_shape|workspace_profile)\s*(?:->>?\s*'(?:kind|mode|tenancy|ownerEstablishment)'|#>>?\s*'\{(?:kind|mode|tenancy|ownerEstablishment)\}'|\[\s*'(?:kind|mode|tenancy|ownerEstablishment)'\s*\])|jsonb_extract_path_text\(\s*(?:\w+\.)?(?:deployment_shape|workspace_profile)\s*,\s*'(?:kind|mode|tenancy|ownerEstablishment)'\s*\))`;
const sqlKindDecisionPattern = new RegExp(
  `${sqlKindSelector}\\s*\\)*\\s*(?:<>|!=|=|\\b(?:not\\s+)?in\\b)[^\\n;]*|'[^'\\n]+'\\s*(?:<>|!=|=)\\s*\\(*\\s*${sqlKindSelector}\\s*\\)*`,
  "giu",
);

function node(value: unknown): SyntaxNode | null {
  return typeof value === "object" && value !== null && "type" in value
    ? (value as SyntaxNode)
    : null;
}

function walk(value: unknown, visit: (entry: SyntaxNode) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
    return;
  }
  const entry = node(value);
  if (!entry) return;
  visit(entry);
  for (const key in entry)
    if (typeof entry[key] === "object" && !["loc", "comments", "tokens"].includes(key))
      walk(entry[key], visit);
}

export function sqlKindComparisons(source: string): string[] {
  return [...source.matchAll(sqlKindDecisionPattern)].map((match) =>
    match[0].trim().replace(/\s+/gu, " "),
  );
}

export function kindComparisons(file: string, source: string): string[] {
  if (file.endsWith(".sql")) return sqlKindComparisons(source);
  const literalText = /["'`](?:personal|server)["'`]/u.test(source)
    ? source
    : source.replace(
        /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2}))/giu,
        (
          _escape,
          codePoint: string | undefined,
          unicode: string | undefined,
          hex: string | undefined,
        ) => String.fromCodePoint(Number.parseInt(codePoint ?? unicode ?? hex!, 16)),
      );
  if (
    !/["'`](?:personal|server)["'`]/u.test(literalText) ||
    !/(?:[!=]={1,2}|\bswitch\s*\(|\b(?:includes|has|indexOf|is\w*|has\w*|matches\w*)\s*\()/u.test(
      source,
    )
  )
    return [];
  const syntax = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
    attachComment: false,
  });
  const declarations = new Map<string, unknown>();
  const decisions: SyntaxNode[] = [];
  walk(syntax, (entry) => {
    const identifier = node(entry["id"]);
    if (entry["type"] === "VariableDeclarator" && identifier?.["type"] === "Identifier")
      declarations.set(String(identifier["name"]), entry["init"]);
    if (
      ["BinaryExpression", "SwitchStatement", "CallExpression", "OptionalCallExpression"].includes(
        String(entry["type"]),
      )
    )
      decisions.push(entry);
  });
  const constantValue = (value: unknown, seen: Set<string>): SyntaxNode | null => {
    const entry = node(value);
    if (!entry) return null;
    const identity = `node:${String(entry["type"])}:${String(entry["start"])}:${String(entry["end"])}`;
    if (seen.has(identity)) return null;
    seen = new Set([...seen, identity]);
    if (
      [
        "TSAsExpression",
        "TSSatisfiesExpression",
        "TSNonNullExpression",
        "ParenthesizedExpression",
      ].includes(String(entry["type"]))
    )
      return constantValue(entry["expression"], seen);
    if (entry["type"] === "Identifier") {
      const name = String(entry["name"]);
      return seen.has(name)
        ? null
        : constantValue(declarations.get(name), new Set([...seen, name]));
    }
    if (["MemberExpression", "OptionalMemberExpression"].includes(String(entry["type"]))) {
      const object = constantValue(entry["object"], seen);
      const property = node(entry["property"]);
      if (object?.["type"] !== "ObjectExpression") return null;
      const member = (object["properties"] as SyntaxNode[]).find((candidate) => {
        const key = node(candidate["key"]);
        return (
          String(key?.["name"] ?? key?.["value"]) ===
          String(property?.["name"] ?? property?.["value"])
        );
      });
      return constantValue(member?.["value"], seen);
    }
    return entry;
  };
  const hasKind = (value: unknown, seen = new Set<string>()): boolean => {
    const entry = constantValue(value, seen);
    if (!entry) return false;
    if (entry["type"] === "StringLiteral")
      return ["personal", "server"].includes(String(entry["value"]));
    if (entry["type"] === "TemplateLiteral" && !(entry["expressions"] as unknown[]).length)
      return (entry["quasis"] as SyntaxNode[]).some((quasi) =>
        ["personal", "server"].includes(String((quasi["value"] as SyntaxNode)["cooked"])),
      );
    if (entry["type"] === "ArrayExpression")
      return (entry["elements"] as unknown[]).some((element) => hasKind(element, seen));
    if (entry["type"] === "NewExpression")
      return (entry["arguments"] as unknown[]).some((argument) => hasKind(argument, seen));
    return false;
  };
  const expression = (value: unknown): string => {
    const entry = node(value)!;
    return source.slice(Number(entry["start"]), Number(entry["end"])).replace(/\s+/gu, "");
  };
  const comparisons: string[] = [];
  for (const entry of decisions) {
    if (
      entry["type"] === "BinaryExpression" &&
      ["===", "==", "!==", "!="].includes(String(entry["operator"]))
    ) {
      if (hasKind(entry["right"])) comparisons.push(expression(entry["left"]));
      else if (hasKind(entry["left"])) comparisons.push(expression(entry["right"]));
    }
    if (entry["type"] === "SwitchStatement") {
      for (const branch of entry["cases"] as SyntaxNode[])
        if (hasKind(branch["test"])) comparisons.push(expression(entry["discriminant"]));
    }
    if (["CallExpression", "OptionalCallExpression"].includes(String(entry["type"]))) {
      const callee = node(entry["callee"]);
      const property = node(callee?.["property"]);
      const method = String(property?.["name"] ?? property?.["value"] ?? callee?.["name"]);
      const argumentsList = entry["arguments"] as unknown[];
      if (
        ["includes", "has", "indexOf", "is", "isOneOf", "isIn"].includes(method) ||
        /^(?:is|has|matches).*(?:Kind|Deployment)$/u.test(method)
      ) {
        if (hasKind(callee?.["object"])) comparisons.push(expression(argumentsList[0]));
        else if (argumentsList.some((argument) => hasKind(argument)))
          comparisons.push(
            expression(argumentsList.find((argument) => !hasKind(argument)) ?? argumentsList[0]),
          );
      }
    }
  }
  return comparisons;
}

export function comparisonCounts(comparisons: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const expression of comparisons) counts[expression] = (counts[expression] ?? 0) + 1;
  return counts;
}

export function sqlKindDecisionInventory(source: string): Record<string, Record<string, number>> {
  const sections = source.split(/(?=export const \w+Migration\s*:)/gu);
  const inventory: Record<string, Record<string, number>> = {};
  for (const section of sections) {
    const expressions = sqlKindComparisons(section);
    if (!expressions.length) continue;
    const scope = /^export const (\w+Migration)/u.exec(section)?.[1] ?? "baseline";
    for (const match of section.matchAll(sqlKindDecisionPattern)) {
      const expression = match[0].trim().replace(/\s+/gu, " ");
      const prefix = section.slice(0, match.index);
      const declarations = [
        ...prefix.matchAll(
          /\b(?:function\s+([\w.]+)\s*\(|constraint\s+(\w+)\s+check\b|(update\s+(?:public\.)?deployments)\b)/giu,
        ),
      ];
      const declaration = declarations.at(-1);
      const name = `${scope}/${expression.startsWith("workspace_profile") ? "legacy-cloud-refusal" : (declaration?.[1] ?? declaration?.[2] ?? (declaration?.[3] ? "deployment-shape-conversion" : "unclassified"))}`;
      const counts = (inventory[name] ??= {});
      counts[expression] = (counts[expression] ?? 0) + 1;
    }
  }
  return inventory;
}
