import { z } from "zod";
import { json, request, type HttpOptions } from "./http.js";

const metadataTokenUrl = new URL(
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
);
const tokenResponse = z.object({
  access_token: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[^\s]+$/u),
  expires_in: z.number().int().positive(),
  token_type: z.literal("Bearer"),
});

export interface ComputeAccessToken {
  getAccessToken(signal: AbortSignal): Promise<string | null | undefined>;
  invalidate?(token: string): void;
}

export function googleMetadataAccessToken(http: HttpOptions): ComputeAccessToken {
  let cached: { token: string; refreshAt: number } | undefined;
  return {
    async getAccessToken(signal) {
      signal.throwIfAborted();
      if (cached && Date.now() < cached.refreshAt) return cached.token;
      const now = Date.now();
      const token = await request(
        "Google metadata",
        metadataTokenUrl,
        http,
        signal,
        json(tokenResponse),
        {
          headers: { "metadata-flavor": "Google" },
        },
      );
      const lifetime = token.expires_in * 1_000;
      cached = {
        token: token.access_token,
        refreshAt: now + lifetime - Math.min(60_000, lifetime / 2),
      };
      return cached.token;
    },
    invalidate(token) {
      if (cached?.token === token) cached = undefined;
    },
  };
}
