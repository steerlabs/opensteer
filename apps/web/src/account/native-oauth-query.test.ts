import { describe, expect, it, vi } from "vitest";
import { consumeNativeOAuthQuery, withoutNativeOAuthQuery } from "./native-oauth-query.js";

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
  it("keeps the signed query opaque and removes it from the URL", () => {
    const replace = vi.fn();
    expect(
      consumeNativeOAuthQuery({ hash: "", pathname: "/", search: `?${signedQuery}` }, replace),
    ).toBe(signedQuery);
    expect(replace).toHaveBeenCalledWith("/", { nativeOAuthQuery: signedQuery });
  });

  it("restores the pending request after reload or back without putting it in the URL", () => {
    let entry: unknown = { router: "preserved" };
    let search = `?${signedQuery}`;
    const replace = (url: string, state: unknown) => {
      expect(url).toBe("/");
      search = "";
      entry = state;
    };
    expect(consumeNativeOAuthQuery({ hash: "", pathname: "/", search }, replace, entry)).toBe(
      signedQuery,
    );
    expect(entry).toMatchObject({ router: "preserved" });
    expect(consumeNativeOAuthQuery({ hash: "", pathname: "/", search }, replace, entry)).toBe(
      signedQuery,
    );
    expect(
      consumeNativeOAuthQuery({ hash: "", pathname: "/chat", search }, replace, entry),
    ).toBeNull();
    expect(consumeNativeOAuthQuery({ hash: "", pathname: "/", search }, replace, null)).toBeNull();
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

it("forgets an answered request and keeps the rest of the history entry", () => {
  expect(withoutNativeOAuthQuery({ nativeOAuthQuery: "signed", route: "home" })).toEqual({
    route: "home",
  });
  expect(withoutNativeOAuthQuery(null)).toBeNull();
});
