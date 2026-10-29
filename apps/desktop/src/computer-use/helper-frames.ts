import { computerUseHelperMaxFrameBytes } from "@opensteer/protocol";
import {
  encodeLengthPrefixedJson,
  LengthPrefixedJsonReader,
} from "@opensteer/shared/lengthPrefixedJson";

/** One helper frame, bounded by the helper protocol's own budget. */
export function encodeComputerUseFrame(value: unknown): Buffer {
  return encodeLengthPrefixedJson(value, computerUseHelperMaxFrameBytes);
}

/** A reader for the helper socket, which refuses a header past the same budget. */
export function computerUseFrameReader(): LengthPrefixedJsonReader {
  return new LengthPrefixedJsonReader(computerUseHelperMaxFrameBytes);
}
