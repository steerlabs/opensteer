export interface DataPathPropertyToken {
  readonly kind: "prop";
  readonly key: string;
}

export interface DataPathIndexToken {
  readonly kind: "index";
  readonly index: number;
}

export type DataPathToken = DataPathPropertyToken | DataPathIndexToken;

export function joinDataPath(base: string, key: string): string {
  const normalizedBase = base.trim();
  const normalizedKey = key.trim();
  if (normalizedBase.length === 0) {
    return normalizedKey;
  }
  if (normalizedKey.length === 0) {
    return normalizedBase;
  }
  return `${normalizedBase}.${normalizedKey}`;
}

export function appendDataPathIndex(base: string, index: number): string {
  const normalizedBase = base.trim();
  const normalizedIndex = Math.trunc(index);
  if (normalizedBase.length === 0) {
    return `[${String(normalizedIndex)}]`;
  }
  return `${normalizedBase}[${String(normalizedIndex)}]`;
}

export function encodeDataPath(tokens: readonly DataPathToken[]): string {
  let out = "";
  for (const token of tokens) {
    if (token.kind === "prop") {
      out = out.length === 0 ? token.key : `${out}.${token.key}`;
      continue;
    }
    out += `[${String(token.index)}]`;
  }
  return out;
}

export function parseDataPath(path: string): DataPathToken[] | null {
  const input = path.trim();
  if (input.length === 0) {
    return [];
  }
  if (input.includes("..") || input.startsWith(".") || input.endsWith(".")) {
    return null;
  }

  const tokens: DataPathToken[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === ".") {
      cursor += 1;
      continue;
    }

    if (char === "[") {
      const close = input.indexOf("]", cursor + 1);
      if (close === -1) {
        return null;
      }

      const rawIndex = input.slice(cursor + 1, close).trim();
      if (!/^\d+$/.test(rawIndex)) {
        return null;
      }

      tokens.push({
        kind: "index",
        index: Number.parseInt(rawIndex, 10),
      });
      cursor = close + 1;
      continue;
    }

    let end = cursor;
    while (end < input.length && input[end] !== "." && input[end] !== "[") {
      end += 1;
    }

    const key = input.slice(cursor, end).trim();
    if (key.length === 0) {
      return null;
    }

    tokens.push({
      kind: "prop",
      key,
    });
    cursor = end;
  }

  return tokens;
}

export function inflateDataPathObject(flat: Readonly<Record<string, unknown>>): unknown {
  let root: unknown = {};
  let initialized = false;

  for (const [path, value] of Object.entries(flat)) {
    const tokens = parseDataPath(path);
    if (!tokens || tokens.length === 0) {
      continue;
    }

    if (!initialized) {
      root = tokens[0]?.kind === "index" ? [] : {};
      initialized = true;
    }

    assignDataPathValue(root, tokens, value);
  }

  return initialized ? root : {};
}

function assignDataPathValue(
  root: unknown,
  tokens: readonly DataPathToken[],
  value: unknown,
): void {
  let current: unknown = root;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    const isLast = index === tokens.length - 1;
    if (!token) {
      return;
    }

    if (token.kind === "prop") {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return;
      }

      const objectRef = current as Record<string, unknown>;
      if (isLast) {
        objectRef[token.key] = value;
        return;
      }

      if (next?.kind === "index") {
        if (!Array.isArray(objectRef[token.key])) {
          objectRef[token.key] = [];
        }
      } else if (
        !objectRef[token.key] ||
        typeof objectRef[token.key] !== "object" ||
        Array.isArray(objectRef[token.key])
      ) {
        objectRef[token.key] = {};
      }

      current = objectRef[token.key];
      continue;
    }

    if (!Array.isArray(current)) {
      return;
    }
    if (isLast) {
      current[token.index] = value;
      return;
    }

    if (next?.kind === "index") {
      if (!Array.isArray(current[token.index])) {
        current[token.index] = [];
      }
    } else if (
      !current[token.index] ||
      typeof current[token.index] !== "object" ||
      Array.isArray(current[token.index])
    ) {
      current[token.index] = {};
    }

    current = current[token.index];
  }
}
