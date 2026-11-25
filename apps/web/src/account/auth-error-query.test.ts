import { describe, expect, it, vi } from "vitest";
import { authorizationErrorScreen, consumeOAuthErrorQuery } from "./auth-error-query.js";

describe("consumeOAuthErrorQuery", () => {
  it("reads the failure and removes it from browser history", () => {
    const replace = vi.fn();
    expect(
      consumeOAuthErrorQuery(
        {
          hash: "",
          pathname: "/auth/error",
          search: "?error=invalid_client&error_description=client_id+is+required",
        },
        replace,
      ),
    ).toEqual({ description: "client_id is required", error: "invalid_client" });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("reads a failure that carries no description", () => {
    const replace = vi.fn();
    expect(
      consumeOAuthErrorQuery(
        { hash: "", pathname: "/auth/error", search: "?error=access_denied" },
        replace,
      ),
    ).toEqual({ description: null, error: "access_denied" });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("drops a blank or over-long description rather than showing it", () => {
    for (const description of ["+++", "a".repeat(513)]) {
      const replace = vi.fn();
      expect(
        consumeOAuthErrorQuery(
          {
            hash: "",
            pathname: "/auth/error",
            search: `?error=server_error&error_description=${description}`,
          },
          replace,
        ),
      ).toEqual({ description: null, error: "server_error" });
    }
  });

  it("ignores other paths, missing or malformed codes, and oversized queries", () => {
    for (const location of [
      { hash: "", pathname: "/", search: "?error=invalid_client" },
      { hash: "", pathname: "/auth/error", search: "" },
      { hash: "", pathname: "/auth/error", search: "?error_description=no+code" },
      { hash: "", pathname: "/auth/error", search: "?error=invalid+client" },
      { hash: "", pathname: "/auth/error", search: `?error=${"a".repeat(65)}` },
      { hash: "", pathname: "/auth/error", search: `?error=x&padding=${"a".repeat(4_096)}` },
    ]) {
      const replace = vi.fn();
      expect(consumeOAuthErrorQuery(location, replace)).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    }
  });
});

describe("authorizationErrorScreen", () => {
  it("says a Home belongs to another Opensteer account and offers signing in as its owner", () => {
    expect(authorizationErrorScreen({ error: "another_account", description: null })).toEqual({
      action: "sign-in-as-owner",
      message: "Sign in with the Opensteer account that owns it.",
      title: "This Home belongs to another Opensteer account",
    });
  });

  it("keeps every other failure on the general sentence and its Continue", () => {
    expect(authorizationErrorScreen({ error: "access_denied", description: null })).toEqual({
      action: "continue",
      message: "This deployment turned down the authorization request.",
      title: "Sign-in couldn’t be completed",
    });
    expect(
      authorizationErrorScreen({ error: "invalid_request", description: "Bad client." }),
    ).toMatchObject({ message: "Bad client." });
  });
});
