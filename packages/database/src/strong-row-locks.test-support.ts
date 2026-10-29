/** Keep offsets and newlines intact so every finding points to the original source. */
function withoutSqlComments(source: string): string {
  let depth = 0;
  let lineComment = false;
  let quote: string | null = null;
  let dollarQuote: string | null = null;
  let masked = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const pair = source.slice(index, index + 2);
    if (dollarQuote !== null) {
      if (source.startsWith(dollarQuote, index)) {
        masked += dollarQuote;
        index += dollarQuote.length - 1;
        dollarQuote = null;
      } else masked += char;
      continue;
    }
    if (depth === 0 && !lineComment && quote === null && char === "$") {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u.exec(source.slice(index))?.[0];
      if (delimiter) {
        dollarQuote = delimiter;
        masked += delimiter;
        index += delimiter.length - 1;
        continue;
      }
    }
    if (quote !== null) {
      masked += char;
      if (char === "\\" || (char === quote && source[index + 1] === quote)) {
        masked += source[++index] ?? "";
      } else if (char === quote) quote = null;
      continue;
    }
    if (depth === 0 && !lineComment && (char === "'" || char === '"')) {
      quote = char;
      masked += char;
      continue;
    }
    if (!lineComment && pair === "/*") {
      depth += 1;
      masked += "  ";
      index += 1;
      continue;
    }
    if (depth > 0 && pair === "*/") {
      depth -= 1;
      masked += "  ";
      index += 1;
      continue;
    }
    if (depth === 0 && pair === "--") lineComment = true;
    if (char === "\n" || char === "\r") {
      lineComment = false;
      masked += char;
    } else masked += depth > 0 || lineComment ? " " : char;
  }
  return masked;
}

/** Shared by the source inventory and the installed PostgreSQL function audit. */
export function strongRowLockViolations(
  source: string,
  syntax: "source" | "sql" = "source",
): readonly number[] {
  let executable = source;
  const offsets: number[] = [];
  const append = (text: string, start: number) => {
    for (let index = 0; index < text.length; index += 1) offsets.push(start + index);
    return text;
  };
  if (syntax === "sql") {
    executable = withoutSqlComments(source);
  } else {
    const chunks: string[] = [];
    for (let index = 0; index < source.length;) {
      const start = index;
      const char = source[index]!;
      const pair = source.slice(index, index + 2);
      if (pair === "//") {
        while (index < source.length && source[index] !== "\n") index += 1;
        chunks.push(append(source.slice(start, index).replace(/[^\r\n]/gu, " "), start));
      } else if (pair === "/*") {
        let depth = 1;
        index += 2;
        while (index < source.length && depth > 0) {
          const next = source.slice(index, index + 2);
          if (next === "/*") {
            depth += 1;
            index += 2;
          } else if (next === "*/") {
            depth -= 1;
            index += 2;
          } else index += 1;
        }
        chunks.push(append(source.slice(start, index).replace(/[^\r\n]/gu, " "), start));
      } else if (char === '"' || char === "'" || char === "`") {
        index += 1;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
            continue;
          }
          if (source[index++] === char) break;
        }
        const literal = source.slice(start, index);
        let decoded = "";
        const literalOffsets: number[] = [];
        const escapes = /\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([\s\S]))/giu;
        let previous = 0;
        for (const match of literal.matchAll(escapes)) {
          for (let cursor = previous; cursor < match.index; cursor += 1) {
            decoded += literal[cursor];
            literalOffsets.push(start + cursor);
          }
          const hex = match[1] ?? match[2] ?? match[3];
          const simple: Readonly<Record<string, string>> = {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
            v: "\v",
            "0": "\0",
            "\n": "",
            "\r": "",
          };
          const value = hex
            ? String.fromCodePoint(Number.parseInt(hex, 16))
            : (simple[match[4]!] ?? match[4]!);
          decoded += value;
          for (let cursor = 0; cursor < value.length; cursor += 1)
            literalOffsets.push(start + match.index);
          previous = match.index + match[0].length;
        }
        for (let cursor = previous; cursor < literal.length; cursor += 1) {
          decoded += literal[cursor];
          literalOffsets.push(start + cursor);
        }
        offsets.push(...literalOffsets);
        chunks.push(decoded[0]! + withoutSqlComments(decoded.slice(1, -1)) + decoded.slice(-1));
      } else {
        chunks.push(append(char, index));
        index += 1;
      }
    }
    executable = chunks.join("");
  }
  const lines = source.split("\n");
  const violations: number[] = [];
  // The identifier also catches computed access, destructuring and method aliases.
  for (const match of executable.matchAll(
    /\bforUpdate\b|\bfor(?:\s|\/\*[\s\S]*?\*\/|--[^\n]*(?:\n|$))+update\b/giu,
  )) {
    const lineIndex =
      source.slice(0, syntax === "sql" ? match.index : offsets[match.index]).split("\n").length - 1;
    if (
      ![lines[lineIndex] ?? "", lines[lineIndex - 1] ?? ""].some((text) =>
        /(?:\/\/|--|\/\*)\s*FOR UPDATE:\s*\S/u.test(text),
      )
    ) {
      violations.push(lineIndex + 1);
    }
  }
  return violations;
}
