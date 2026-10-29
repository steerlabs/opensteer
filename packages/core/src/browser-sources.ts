import { z } from "zod";

/** A scope names one website, never a path, wildcard, or URL containing credentials. */
export const BrowserSourceSiteSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.hostname.includes("*") &&
      url.origin !== "null"
    );
  }, "Choose an HTTP or HTTPS website without credentials.")
  .transform((value) => new URL(value).origin);

/**
 * A schemeful site such as `https://github.com`: the scope of one browser
 * sign-in. Registrable-domain normalization needs the public suffix list, so
 * `@opensteer/browser-profile/source-state` produces these values; this schema
 * checks their shape and admits everything that normalization can produce:
 * lowercase hostnames (including `_`), IPv4 addresses and bracketed IPv6.
 * Migration 0055's CHECK constraints use the same pattern.
 */
export const BrowserSiteSchema = z
  .string()
  .max(300)
  .regex(
    /^https?:\/\/(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/u,
    "Choose a website such as https://github.com.",
  )
  .refine((value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  }, "Choose a website such as https://github.com.");
export type BrowserSite = z.infer<typeof BrowserSiteSchema>;
