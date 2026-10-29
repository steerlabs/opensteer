import { randomBytes } from "node:crypto";
import { sha256Base64Url } from "@opensteer/core/crypto";

export function createHostCredential(): string {
  return `osc_${randomBytes(32).toString("base64url")}`;
}

export function createOAuthClientSecret(): string {
  return `ocs_${randomBytes(32).toString("base64url")}`;
}

export function hashCredential(value: string): string {
  return sha256Base64Url(value);
}
