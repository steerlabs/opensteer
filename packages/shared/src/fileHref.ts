export interface FileLinkTarget {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
}

/** Two leading separators can cause Windows to send credentials to a network share. */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path.trim());
}

const controls = /\p{Cc}/u;
const absolute = (path: string): boolean =>
  !controls.test(path) &&
  !isNetworkPath(path) &&
  (path.startsWith("/") || /^[a-z]:[\\/]/iu.test(path));
const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** Position syntax is split before the filename is decoded, exactly once. */
export function parseFileHref(href: string): FileLinkTarget | null {
  if (!href || controls.test(href) || /^file:/iu.test(href) || href !== href.trim()) return null;
  const position = /:(\d+)(?::(\d+)|-(\d+))$|:(\d+)$|#L(\d+)(?:C(\d+)|-L?(\d+))?$/iu.exec(href);
  const encodedPath = position ? href.slice(0, position.index) : href;
  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (!absolute(path)) return null;
  if (!position) return { path };
  const line = Number(position[1] ?? position[4] ?? position[5]);
  const column = position[2] ?? position[6];
  const endLine = position[3] ?? position[7];
  if (
    !positive(line) ||
    (column !== undefined && !positive(Number(column))) ||
    (endLine !== undefined && (!positive(Number(endLine)) || Number(endLine) < line))
  )
    return null;
  return {
    path,
    line,
    ...(column === undefined ? {} : { column: Number(column) }),
    ...(endLine === undefined ? {} : { endLine: Number(endLine) }),
  };
}

export function fileHref(target: FileLinkTarget): string {
  const { path, line, column, endLine } = target;
  if (
    !absolute(path) ||
    (line !== undefined && !positive(line)) ||
    (column !== undefined && (line === undefined || !positive(column))) ||
    (endLine !== undefined &&
      (line === undefined || !positive(endLine) || endLine < line || column !== undefined))
  )
    throw new Error("Invalid file link target");
  const encoded = path.replace(/[%?#&\\<>\s()[\]:]/gu, (character) =>
    encodeURIComponent(character).replace(
      /[()]/gu,
      (value) => "%" + value.charCodeAt(0).toString(16).toUpperCase(),
    ),
  );
  return (
    encoded +
    (line === undefined
      ? ""
      : ":" +
        line +
        (column === undefined ? (endLine === undefined ? "" : "-" + endLine) : ":" + column))
  );
}
