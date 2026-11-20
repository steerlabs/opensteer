import { z } from "zod";

export const standardCdpPath = "/v1/browser/cdp";
export {
  standardCdpMessageMaxBytes,
  standardCdpBufferedMaxBytes,
  standardCdpMaxPending,
} from "@opensteer/browser-core/standard-cdp-limits";
export const standardCdpChunkBytes = 192 * 1024;

export const StandardCdpChunkSchema = z.strictObject({
  type: z.literal("cdp.raw"),
  data: z
    .string()
    .min(1)
    .max((standardCdpChunkBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  last: z.boolean(),
});
export type StandardCdpChunk = z.infer<typeof StandardCdpChunkSchema>;

export const StandardCdpModeSchema = z.enum(["session", "whole-context"]);
export type StandardCdpMode = z.infer<typeof StandardCdpModeSchema>;
