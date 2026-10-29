import { z } from "zod";
import { BrowserCookieSchema, type BrowserCookie } from "./snapshot.js";

const CdpCookieSchema = z.object({
  domain: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  name: z.string(),
  partitionKey: z
    .object({
      hasCrossSiteAncestor: z.boolean(),
      topLevelSite: z.url(),
    })
    .optional(),
  partitionKeyOpaque: z.boolean().optional(),
  path: z.string(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  secure: z.boolean(),
  value: z.string(),
});

export function browserCookieFromCdp(value: unknown): BrowserCookie {
  const cookie = CdpCookieSchema.parse(value);
  if (cookie.partitionKeyOpaque) throw new Error("Opaque cookie partitions cannot be saved.");
  return BrowserCookieSchema.parse({
    domain: cookie.domain,
    expires: cookie.expires,
    hostOnly: !cookie.domain.startsWith("."),
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    ...(cookie.partitionKey
      ? {
          partitionKey: cookie.partitionKey.topLevelSite,
          partitionKeyHasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor,
        }
      : {}),
    path: cookie.path,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    secure: cookie.secure,
    value: cookie.value,
  });
}

export interface BrowserCdpCookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly url?: string;
  readonly expires?: number;
  readonly httpOnly: boolean;
  readonly path: string;
  readonly sameSite?: "Strict" | "Lax" | "None";
  readonly secure: boolean;
  readonly partitionKey?: { readonly hasCrossSiteAncestor: boolean; readonly topLevelSite: string };
}

export function browserCookieToCdp(cookie: BrowserCookie): BrowserCdpCookie {
  const hostOnly = cookie.hostOnly ?? !cookie.domain.startsWith(".");
  const hostname = cookie.domain.replace(/^\./u, "");
  return {
    ...(hostOnly
      ? { url: `${cookie.secure ? "https" : "http"}://${hostname}/` }
      : { domain: `.${hostname}` }),
    ...(cookie.expires >= 0 ? { expires: cookie.expires } : {}),
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    ...(cookie.partitionKey
      ? {
          partitionKey: {
            // Previously saved snapshots carried only the site and used this value.
            // New snapshots always preserve the actual ancestor bit.
            hasCrossSiteAncestor: cookie.partitionKeyHasCrossSiteAncestor ?? true,
            topLevelSite: cookie.partitionKey,
          },
        }
      : {}),
    path: cookie.path,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    secure: cookie.secure,
    value: cookie.value,
  };
}
