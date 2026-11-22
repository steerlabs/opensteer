import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { describe, expect, it } from "vitest";
import { accountDoorPresentation, signedInDirectoryPresentation } from "./account-door.js";

function account(
  input: Partial<DesktopAccountAuthState["account"]> = {},
): DesktopAccountAuthState["account"] {
  return {
    available: true,
    detail: null,
    identity: null,
    status: "signed-out",
    ...input,
  };
}

describe("accountDoorPresentation", () => {
  it("keeps unavailable Account sign-in disabled and explains the actual failure", () => {
    expect(
      accountDoorPresentation(
        account({ available: false, detail: "Credential storage is locked." }),
        false,
      ),
    ).toEqual({
      description: "Credential storage is locked.",
      disabled: true,
      title: "Sign in",
    });
  });

  it("explains a native Keychain failure without exposing the Expo exception stack", () => {
    const detail =
      "FunctionCallException: getValueWithKeyAsync failed. KeychainException: A required entitlement isn't present. (at ExpoSecureStore/SecureStoreModule.swift:168)";
    expect(accountDoorPresentation(account({ available: false, detail }), false)).toEqual({
      description: "Opensteer couldn't save your sign-in on this phone. Try again.",
      disabled: true,
      title: "Sign in",
    });
  });

  it("says the same plain sentence for the exception an unsigned build's sign-in meets", () => {
    // What Expo says when the Keychain entitlement is missing, with no Keychain in its words.
    const detail =
      "Calling the 'setValueWithKeyAsync' function has failed → Caused by: A required entitlement isn't present.";
    expect(accountDoorPresentation(account({ detail, status: "error" }), false).description).toBe(
      "Opensteer couldn't save your sign-in on this phone. Try again.",
    );
  });

  it("offers a retry after a sign-in that failed", () => {
    expect(
      accountDoorPresentation(
        account({ detail: "The browser was closed.", status: "error" }),
        false,
      ).title,
    ).toBe("Try signing in again");
  });

  it("shows browser authorization as pending", () => {
    expect(
      accountDoorPresentation(
        account({ detail: "Complete authorization in your browser.", status: "authorizing" }),
        false,
      ),
    ).toEqual({
      description: "Complete authorization in your browser.",
      disabled: true,
      title: "Finish signing in in your browser",
    });
  });
});

describe("signed-in Account presentation", () => {
  it.each(["idle", "loading"] as const)(
    "does not claim the directory is empty while it is %s",
    (status) => {
      expect(signedInDirectoryPresentation({ detail: null, status, unavailableCount: 0 })).toEqual({
        detail: "Checking your Opensteer account…",
        refreshDisabled: true,
        refreshLabel: "Refreshing…",
        title: "Signed in to your Account",
      });
    },
  );
});
