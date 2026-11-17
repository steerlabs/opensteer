import { createHash } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";

export const oauthReviewDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("base64url");
