// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { NativeOAuthIdentity } from "@opensteer/client/auth";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import {
  opensteerMobileAccountOAuthCallback,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
} from "@opensteer/core";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { describe, expect, it, vi } from "vitest";
import { createMockHostPort } from "../client/mock-host-port.js";
import { MobileClient } from "../client/mobile-client.js";
import { MemorySecureStore } from "../platform/memory-secure-store.js";
import { createSecureRecordStore } from "../platform/secure-record-store.js";
import { signInStorage } from "../platform/sign-in-storage.js";

/*
 * An unsigned build signs in: the browser comes back, the account's token exchange succeeds, and
 * saving the sign-in to the Keychain is refused, the way the entitlement-less simulator refuses
 * it: on the write, not on the read. The first screen says why, not that signing in failed.
 */

vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (input: { default?: unknown }) => input.default },
  Share: { share: vi.fn() },
  StyleSheet: { create: <T,>(value: T) => value },
  ActivityIndicator: () => <span>Loading</span>,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
vi.mock("../ui/primitives.js", () => ({
  DisplayTitle: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: ({ detail }: { detail: string }) => <span>{detail}</span>,
  PrimaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  RowGroup: ({ children }: { children: readonly ReactNode[] }) => <div>{children}</div>,
  SecondaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  SectionLabel: ({ children }: { children: string }) => <span>{children}</span>,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));

const { Welcome } = await import("./welcome.js");
const { accountSignInFailureText } = await import("./account-door.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const accountOrigin = "https://accounts.opensteer.test";
const oauthIdentity: NativeOAuthIdentity = {
  accountCallback: opensteerMobileAccountOAuthCallback,
  application: "mobile",
  clientId: opensteerMobileOAuthClientId,
  hostCallback: opensteerMobileHostOAuthCallback,
};
const subject = ControlPlaneAccountIdSchema.parse("acct_0192f4a1-7777-4000-8000-000000000007");

function idToken(): string {
  const encode = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1_000);
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({
    aud: opensteerMobileOAuthClientId,
    auth_time: now - 60,
    email: "mobile@opensteer.test",
    exp: now + 3_600,
    iss: accountOrigin,
    sub: subject,
  })}.${"s".repeat(86)}`;
}

/** The account service: the code is exchanged for tokens, every time, as a working one does. */
const exchanges: string[] = [];
const accountService = async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
  if (!url.endsWith("/token")) return new Response("{}");
  exchanges.push(new URLSearchParams(String(init?.body ?? "")).get("grant_type") ?? "");
  return Response.json({
    access_token: `account-access-${"a".repeat(24)}`,
    expires_in: 3_600,
    id_token: idToken(),
    refresh_token: `account-refresh-${"r".repeat(24)}`,
    token_type: "Bearer",
  });
};

/** The Keychain of a build without its entitlement: it reads, and refuses every write. */
function keychainRefusingWrites(): MemorySecureStore {
  const keychain = new MemorySecureStore();
  keychain.setItemAsync = async () => {
    throw new Error(
      "Calling the 'setValueWithKeyAsync' function has failed → Caused by: A required entitlement is not present.",
    );
  };
  return keychain;
}

describe("signing in on a phone that can't save the sign-in", () => {
  it("says the sign-in couldn't be saved, not that signing in failed", async () => {
    let client: MobileClient | undefined = undefined;
    client = new MobileClient({
      accountOrigin,
      catalogFilePath: "/private/deployments.json",
      draftsFilePath: "/private/drafts.json",
      fetch: accountService,
      hostPort: createMockHostPort(),
      oauthIdentity,
      // The system sheet returns to the app with the code, as it does on a phone.
      openAuthorization: async (url) => {
        const callback = new URL(opensteerMobileAccountOAuthCallback);
        callback.searchParams.set("code", "account-code");
        callback.searchParams.set("iss", accountOrigin);
        callback.searchParams.set("state", new URL(url).searchParams.get("state")!);
        await client!.oauth.handleCallback(callback.toString());
      },
      openIntegrationAuthorization: async () => {
        throw new Error("No integration sign-in here.");
      },
      privateFiles: new MemoryPrivateFilesystem(),
      quietSeenFilePath: "/private/quiet-seen.json",
      randomBytes: (size) => new Uint8Array(size).fill(7),
      records: createSecureRecordStore({
        keyPrefix: "test",
        secureStore: signInStorage(keychainRefusingWrites(), "iPhone", () => undefined),
      }),
      selectionFilePath: "/private/selection.json",
      signedOutFilePath: "/private/signed-out.json",
      usageNoticesFilePath: "/private/usage-notices.json",
    });
    await client.initialize();
    const refused = await client.signInAccount().then(
      () => null,
      (error: unknown) => error,
    );
    // The account answered; only saving what it answered failed.
    expect(exchanges).toContain("authorization_code");
    expect(refused).not.toBeNull();

    // The first screen, as the Homes screen hands it the outcome.
    const account = client.getSnapshot().account.account;
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <Welcome
          account={account}
          failure={accountSignInFailureText(refused)}
          onAccount={() => undefined}
          onAddress={() => undefined}
          onScan={() => undefined}
          portalOrigin={null}
          signingIn={false}
        />,
      ),
    );
    expect(container.textContent).toContain(
      "Opensteer couldn't save your sign-in on this iPhone. Try again.",
    );
    expect(container.textContent).not.toContain("Couldn't sign in");
    expect(container.textContent).not.toContain("setValueWithKeyAsync");
    act(() => root.unmount());
    client.dispose();
  });
});
