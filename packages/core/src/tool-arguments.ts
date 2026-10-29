import { utf8HeadAndTail } from "./tool-output.js";

/**
 * The most of a tool call's arguments its durable record keeps, in serialized
 * JSON bytes. The engine runs the call with its whole input; the record is
 * what a reader sees of it, and leaves room in one event for everything else
 * the call's `tool.started` carries.
 */
export const toolArgumentsMaxSerializedBytes = 64 * 1_024;

/** Room for the omission marker beside a cut text's kept bytes. */
const omissionMarkerReserveBytes = 64;
/**
 * The least a cut text keeps. Arguments holding too many long texts for each
 * to keep this much are too broad to keep in shape, and a short value such as
 * a `toolRef` is never cut.
 */
const minimumKeptBytes = 512;
const encoder = new TextEncoder();

/**
 * Build the one durable, provider-neutral record of a tool call's arguments.
 * Arguments that fit are kept exactly. Larger ones keep as much of their shape
 * as fits: their longest texts are cut, all to the same length, to equal head
 * and tail windows around a marker saying how much was omitted, so short
 * values such as a path, a working directory or an integration's `toolRef`
 * stay whole. A parameter too broad to fit that way, such as a list of
 * thousands of rows, is kept as its JSON text, cut the same way, and arguments
 * too broad even for that are kept whole as cut JSON text. The Runner records
 * every engine's arguments through this.
 */
export function createToolArguments(value: unknown): unknown {
  return (
    fittedTexts(value) ??
    (typeof value === "object" && value !== null && !Array.isArray(value)
      ? fittedTexts(withParametersAsText(value))
      : undefined) ??
    fittedTexts(JSON.stringify(value))
  )?.value;
}

/**
 * `value` with its texts cut to the longest length that fits, or nothing when
 * its shape does not fit even with every text cut.
 */
function fittedTexts(value: unknown): { readonly value: unknown } | undefined {
  if (serializedBytes(value) <= toolArgumentsMaxSerializedBytes) return { value };
  // Each try cuts the same texts, which are encoded once.
  const encoded = new Map<string, Uint8Array>();
  // Keeping less of each text never makes the whole larger, so a shape too
  // large with every text at its shortest is too large however they are cut.
  if (
    serializedBytes(withTextsCut(value, minimumKeptBytes, encoded)) >
    toolArgumentsMaxSerializedBytes
  ) {
    return undefined;
  }
  // A text keeping more than the whole budget could never fit; the search
  // only ever keeps a length it saw fit.
  let low = minimumKeptBytes;
  let high = toolArgumentsMaxSerializedBytes;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(withTextsCut(value, middle, encoded)) <= toolArgumentsMaxSerializedBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { value: withTextsCut(value, low, encoded) };
}

/** Every text longer than `keptBytes` and its marker, cut to `keptBytes`. */
function withTextsCut(
  value: unknown,
  keptBytes: number,
  encoded: Map<string, Uint8Array>,
): unknown {
  if (typeof value === "string") {
    // UTF-8 takes one to three bytes per UTF-16 unit, which settles most
    // texts without encoding them.
    const limit = keptBytes + omissionMarkerReserveBytes;
    if (value.length * 3 <= limit) return value;
    const bytes = encoded.get(value) ?? encoder.encode(value);
    encoded.set(value, bytes);
    return bytes.byteLength <= limit ? value : utf8HeadAndTail(bytes, keptBytes).text;
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => withTextsCut(item, keptBytes, encoded));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, withTextsCut(item, keptBytes, encoded)]),
  );
}

/** A record whose list and record parameters are their JSON text. */
function withParametersAsText(value: object): unknown {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === "object" && item !== null ? JSON.stringify(item) : item,
    ]),
  );
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value) as string | undefined;
  return serialized === undefined ? 0 : encoder.encode(serialized).byteLength;
}
