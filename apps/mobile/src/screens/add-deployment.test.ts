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
      title: "Sign in with Opensteer",
    });
  });

  it("explains a native Keychain failure without exposing the Expo exception stack", () => {
    const detail =
      "FunctionCallException: getValueWithKeyAsync failed. KeychainException: A required entitlement isn't present. (at ExpoSecureStore/SecureStoreModule.swift:168)";
    expect(accountDoorPresentation(account({ available: false, detail }), false)).toEqual({
      description:
        "This app cannot access this device’s secure credential storage. Sign-in is unavailable.",
      disabled: true,
      title: "Sign in with Opensteer",
    });
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
        detail: "Checking your Account for deployments…",
        refreshDisabled: true,
        refreshLabel: "Refreshing…",
        title: "Signed in to your Account",
      });
    },
  );
});
