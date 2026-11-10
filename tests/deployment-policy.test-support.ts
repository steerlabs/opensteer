import { parse } from "@babel/parser";

type SyntaxNode = Record<string, unknown>;
const sqlKindSelector = String.raw`(?:(?:\w+\.)?deployment_shape\s*(?:->>?\s*'(?:kind|tenancy|ownerEstablishment)'|#>>?\s*'\{(?:kind|tenancy|ownerEstablishment)\}'|\[\s*'(?:kind|tenancy|ownerEstablishment)'\s*\])|jsonb_extract_path_text\(\s*(?:\w+\.)?deployment_shape\s*,\s*'(?:kind|tenancy|ownerEstablishment)'\s*\))`;
const sqlKindDecisionPattern = new RegExp(
  `${sqlKindSelector}\\s*\\)*\\s*(?:<>|!=|=|\\b(?:not\\s+)?in\\b)[^\\n;]*`,
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
  for (const [key, child] of Object.entries(entry))
    if (!["loc", "comments", "tokens"].includes(key)) walk(child, visit);
}

export function sqlKindComparisons(source: string): string[] {
  return [...source.matchAll(sqlKindDecisionPattern)].map((match) =>
    match[0].trim().replace(/\s+/gu, " "),
  );
}

export function kindComparisons(file: string, source: string): string[] {
  if (file.endsWith(".sql")) return sqlKindComparisons(source);
  if (!/["'`](?:personal|server)["'`]/u.test(source)) return [];
  const syntax = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
  const declarations = new Map<string, unknown>();
  walk(syntax, (entry) => {
    const identifier = node(entry["id"]);
    if (entry["type"] === "VariableDeclarator" && identifier?.["type"] === "Identifier")
      declarations.set(String(identifier["name"]), entry["init"]);
  });
  const hasKind = (value: unknown, seen = new Set<string>()): boolean => {
    const entry = node(value);
    if (!entry) return false;
    if (entry["type"] === "StringLiteral")
      return ["personal", "server"].includes(String(entry["value"]));
    if (entry["type"] === "Identifier") {
      const name = String(entry["name"]);
      if (seen.has(name)) return false;
      return hasKind(declarations.get(name), new Set([...seen, name]));
    }
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
  walk(syntax, (entry) => {
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
  });
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
      const name = `${scope}/${declaration?.[1] ?? declaration?.[2] ?? (declaration?.[3] ? "deployment-shape-conversion" : "unclassified")}`;
      const counts = (inventory[name] ??= {});
      counts[expression] = (counts[expression] ?? 0) + 1;
    }
  }
  return inventory;
}
