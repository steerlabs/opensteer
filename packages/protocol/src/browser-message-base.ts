import { z } from "zod";
export const browserBase = {
  /** Host-issued identity; consumer input is always overwritten at the Host boundary. */
  producerId: z.uuid().optional(),
  inputSequenceStart: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  inputSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  inputGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
} as const;
