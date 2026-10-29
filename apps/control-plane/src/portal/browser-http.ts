import type { FastifyReply, FastifyRequest } from "fastify";
import { ControlPlaneError } from "../server/errors.js";

/**
 * Shared browser-facing primitives for the two vhosts this process serves: the
 * Account authorization host and the apex portal. Everything here is about the
 * mechanics of an HTML request — cookies, form bodies, exact-origin proof, and
 * escaping — never about what either vhost decides.
 */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Readonly<Record<string, string>> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

export function parseForm(body: unknown): Record<string, string> {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : "";
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * Browser mutations carry an exact `Origin`. The vhost that serves the form is
 * the only origin allowed to submit it, so a portal form can never be posted
 * from the Account host and the reverse holds too.
 */
export function requireExactOrigin(request: FastifyRequest, origin: string): void {
  if (request.headers.origin !== origin) {
    throw new ControlPlaneError("forbidden", "Request origin is not allowed");
  }
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(entry.slice(separator + 1).trim());
  }
  return undefined;
}

export interface CookieAttributes {
  readonly domain?: string;
  readonly httpOnly?: boolean;
  readonly maxAgeSeconds?: number;
  readonly path?: string;
  readonly sameSite?: "Lax" | "Strict";
  readonly secure?: boolean;
}

export function serializeCookie(
  name: string,
  value: string,
  attributes: CookieAttributes = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${attributes.path ?? "/"}`];
  if (attributes.domain) parts.push(`Domain=${attributes.domain}`);
  if (attributes.maxAgeSeconds !== undefined) parts.push(`Max-Age=${attributes.maxAgeSeconds}`);
  parts.push(`SameSite=${attributes.sameSite ?? "Lax"}`);
  if (attributes.secure ?? true) parts.push("Secure");
  if (attributes.httpOnly ?? true) parts.push("HttpOnly");
  return parts.join("; ");
}

export function expiredCookie(name: string, attributes: CookieAttributes = {}): string {
  return serializeCookie(name, "", { ...attributes, maxAgeSeconds: 0 });
}

/** Adds one `Set-Cookie` without discarding cookies another writer already set. */
export function appendSetCookie(reply: FastifyReply, cookie: string): void {
  void reply.header("set-cookie", [...currentSetCookies(reply), cookie]);
}

export function currentSetCookies(reply: FastifyReply): readonly string[] {
  const existing = reply.getHeader("set-cookie");
  if (existing === undefined) return [];
  return Array.isArray(existing) ? existing.map(String) : [String(existing)];
}
