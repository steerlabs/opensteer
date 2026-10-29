// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/definitions.ts (MIT).
const splitWords = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

const camel = (value: string): string => {
  const [first = "tool", ...rest] = splitWords(value).map((word) => word.toLowerCase());
  return `${first}${rest.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join("")}`;
};

const version = /^v?\d+(?:[._-]\d+)?$/iu;
const legacyVersion = /^v\d+(?:[._-]\d+)?$/iu;

function pathGroup(path: string, versionSegment: RegExp): string {
  for (const segment of path.split("/").filter(Boolean)) {
    if (segment.startsWith("{") || versionSegment.test(segment) || segment.toLowerCase() === "api")
      continue;
    return camel(segment);
  }
  return "root";
}

interface ToolNameInput {
  readonly method: string;
  readonly operationId: string;
  readonly path: string;
  readonly tag?: string;
}

/**
 * Names are ASCII words, so each part capped here, a method and any number
 * still fit a tool name's 512 bytes.
 */
const maximumNamePart = 240;

function plannedName(input: ToolNameInput, versionSegment: RegExp, partLength: number): string {
  const group = input.tag ? camel(input.tag) : pathGroup(input.path, versionSegment);
  const segments = input.operationId.split(/[/.]+/u).filter(Boolean);
  const seed =
    segments.length > 1 && camel(segments[0]!) === group
      ? segments.slice(1).join(" ")
      : input.operationId;
  const leaf = camel(seed) === group ? camel(`${input.method} operation`) : camel(seed);
  return `${group.slice(0, partLength)}.${leaf.slice(0, partLength)}`;
}

const methodWord = (method: string): string => camel(method).replace(/^./u, (c) => c.toUpperCase());

function totals(names: readonly string[]): ReadonlyMap<string, number> {
  const counted = new Map<string, number>();
  for (const name of names) counted.set(name, (counted.get(name) ?? 0) + 1);
  return counted;
}

/**
 * One distinct name per operation, for any document, that fits a tool name. A
 * name only one operation plans keeps it; the others that share one gain their
 * method, and then a number while that is taken, so no suffix can land on
 * another operation's name.
 */
export function planOpenApiToolNames(inputs: readonly ToolNameInput[]): readonly string[] {
  const names = inputs.map((input) => plannedName(input, version, maximumNamePart));
  const counted = totals(names);
  const taken = new Set(names.filter((name) => counted.get(name) === 1));
  return names.map((name, index) => {
    if (counted.get(name) === 1) return name;
    const suffixed = `${name}${methodWord(inputs[index]!.method)}`;
    let candidate = suffixed;
    for (let ordinal = 2; taken.has(candidate); ordinal++) candidate = `${suffixed}${ordinal}`;
    taken.add(candidate);
    return candidate;
  });
}

/**
 * The names tools were stored under before each tool recorded its operation,
 * as 0.1.131 planned them: only binding those tools to their operations reads it.
 */
export function planLegacyOpenApiToolNames(inputs: readonly ToolNameInput[]): readonly string[] {
  const names = inputs.map((input) => plannedName(input, legacyVersion, Infinity));
  const counted = totals(names);
  return names.map((name, index) =>
    (counted.get(name) ?? 0) > 1 ? `${name}${methodWord(inputs[index]!.method)}` : name,
  );
}
