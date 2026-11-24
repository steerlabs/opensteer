import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

/**
 * Proves a native runtime entry lives at its literal path below the canonical
 * profile root: every component exists with the expected type and none is a
 * symbolic link.
 */
export async function antigravityManagedPath(
  profileRoot: string,
  segments: readonly string[],
  kind: "file" | "directory",
): Promise<{ readonly info: Stats; readonly path: string } | undefined> {
  let current = profileRoot;
  let info: Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    info = await lstat(current).catch(() => undefined);
    const expectFile = kind === "file" && index === segments.length - 1;
    if (
      info === undefined ||
      info.isSymbolicLink() ||
      (expectFile ? !info.isFile() : !info.isDirectory())
    ) {
      return undefined;
    }
  }
  if (info === undefined) return undefined;
  return (await realpath(current).catch(() => undefined)) === current
    ? { info, path: current }
    : undefined;
}

export function antigravityProfileRoot(profileDirectory: string): Promise<string | undefined> {
  return realpath(profileDirectory).catch(() => undefined);
}

/** Extracts length-delimited protobuf fields while skipping varints and fixed values. */
export function protoFields(bytes: Uint8Array): readonly (readonly [number, Uint8Array])[] {
  const fields: (readonly [number, Uint8Array])[] = [];
  let offset = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) throw new Error("Truncated varint");
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error("Overlong varint");
  };
  while (offset < bytes.length) {
    const key = varint();
    const wire = key % 8;
    const field = Math.floor(key / 8);
    if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = varint();
      if (offset + length > bytes.length) throw new Error("Truncated field");
      fields.push([field, bytes.subarray(offset, offset + length)]);
      offset += length;
    } else {
      throw new Error("Unsupported wire type");
    }
  }
  if (offset > bytes.length) throw new Error("Truncated field");
  return fields;
}
