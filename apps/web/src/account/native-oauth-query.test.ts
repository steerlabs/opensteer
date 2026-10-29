import { describe, expect, it, vi } from "vitest";
import { consumeNativeOAuthQuery } from "./native-oauth-query.js";

const signedQuery = new URLSearchParams([
  ["response_type", "code"],
  ["client_id", "opensteer-desktop"],
  ["redirect_uri", "com.opensteer.opensteer:/oauth/callback"],
  ["code_challenge", "a".repeat(43)],
  ["code_challenge_method", "S256"],
  ["ba_iat", "1786499200000"],
  ["ba_param", "client_id"],
  ["ba_param", "sig"],
  ["sig", "signed-value"],
]).toString();

describe("consumeNativeOAuthQuery", () => {
  it("keeps the signed query opaque in memory and removes it from browser history", () => {
    const replace = vi.fn();
    expect(
      consumeNativeOAuthQuery({ hash: "", pathname: "/", search: `?${signedQuery}` }, replace),
    ).toBe(signedQuery);
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("does not consume unrelated, incomplete, or oversized query strings", () => {
    for (const location of [
      { hash: "", pathname: "/", search: "?integration=connected&provider=github" },
      { hash: "", pathname: "/", search: "?client_id=opensteer-desktop&sig=incomplete" },
      { hash: "", pathname: "/invite/selector", search: `?${signedQuery}` },
      { hash: "", pathname: "/", search: `?${"a".repeat(32_769)}` },
    ]) {
      const replace = vi.fn();
      expect(consumeNativeOAuthQuery(location, replace)).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    }
  });
});
