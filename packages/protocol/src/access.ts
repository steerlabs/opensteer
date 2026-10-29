import { z } from "zod";

const RelayHeadersSchema = z.record(
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/),
  z.union([z.string().max(65_536), z.array(z.string().max(65_536)).max(100)]),
);

export const RunEgressPlanSchema = z.strictObject({
  maxRequestBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1_024 * 1_024),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1_024 * 1_024),
  relayToken: z.string().min(1).max(32_768),
  relayUrl: z.url(),
});
export type RunEgressPlan = z.infer<typeof RunEgressPlanSchema>;

export const EgressRelayRequestSchema = z.strictObject({
  bodyBase64: z.string().max(96 * 1_024 * 1_024),
  headers: RelayHeadersSchema,
  method: z.string().regex(/^[A-Z]{1,32}$/),
  url: z.url(),
});

export const EgressRelayResponseSchema = z.strictObject({
  bodyBase64: z.string().max(96 * 1_024 * 1_024),
  headers: RelayHeadersSchema,
  status: z.number().int().min(100).max(599),
});
export type EgressRelayResponse = z.infer<typeof EgressRelayResponseSchema>;
