// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Welcome } from "./welcome.js";
import { addressWords } from "../ui/address-words.js";

const share = vi.hoisted(() => vi.fn().mockResolvedValue({ action: "sharedAction" }));
vi.mock("react-native", () => ({
  Platform: { select: (input: { default?: unknown }) => input.default },
  Share: { share },
  StyleSheet: { create: <T,>(value: T) => value },
  ActivityIndicator: () => <span>Loading</span>,
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
vi.mock("../ui/primitives.js", () => ({
  DisplayTitle: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: ({ detail }: { detail: string }) => <span>{detail}</span>,
  PrimaryButton: ({
    busy,
    disabled,
    label,
    onPress,
  }: {
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button disabled={disabled === true || busy === true} onClick={onPress}>
      {label}
    </button>
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

const signedOut = {
  available: true,
  detail: null,
  identity: null,
  origin: "https://accounts.example.com",
  status: "signed-out" as const,
};

describe("first-run welcome", () => {
  const container = document.createElement("div");
  const signIn = vi.fn();
  const scan = vi.fn();
  const address = vi.fn();
  const copy = vi.fn();
  const render = (props: {
    readonly account?:
      | typeof signedOut
      | (Omit<typeof signedOut, "available" | "detail"> & {
          readonly available: false;
          readonly detail: string;
        });
    readonly portalOrigin: string | null;
    readonly signedInAs?: string;
    readonly signingIn?: boolean;
  }) => (
    <Welcome
      account={props.account ?? signedOut}
      cloudAddress={props.portalOrigin ? `${props.portalOrigin}/cloud-computer/checkout` : null}
      cloudPrice="$20.00 a month"
      failure={null}
      onAccount={signIn}
      onAddress={address}
      onCopyCloudAddress={copy}
      onScan={scan}
      portalOrigin={props.portalOrigin}
      signedInAs={props.signedInAs ?? null}
      signingIn={props.signingIn ?? false}
    />
  );
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith(text));
  const click = async (text: string) => {
    expect(button(text), `Missing ${text}`).toBeDefined();
    await act(async () => button(text)!.click());
  };

  it("leads with the Opensteer account, with a code and an address behind Other ways in", async () => {
    const root = createRoot(container);
    try {
      await act(async () => root.render(render({ portalOrigin: "https://portal.example.com" })));
      expect(container.textContent).toMatch(
        /Sign in with your Opensteer account, and this \w+ will find your Opensteer, on your Mac or on a Cloud Computer\./u,
      );
      expect(container.querySelector("button")?.textContent).toBe("Sign in");
      // The other ways in are one small link, not doors beside the account.
      expect(button("Scan")).toBeUndefined();
      expect(button("Enter")).toBeUndefined();
      expect(button("Send me the Mac link")).toBeUndefined();
      expect(container.textContent).not.toMatch(/buy|checkout|price|subscribe|\$/iu);
      await click("Other ways in");
      expect(container.textContent).toContain("From Opensteer on your Mac, for a private network.");
      await click("Scan a code");
      expect(scan).toHaveBeenCalledOnce();
      await click("Enter an address");
      expect(address).toHaveBeenCalledOnce();
      await click("Sign in");
      expect(signIn).toHaveBeenCalledOnce();

      // While the browser is open, the Account row says so and cannot start a second sign-in.
      await act(async () => root.render(render({ portalOrigin: null, signingIn: true })));
      expect(button("Finish signing in in your browser")?.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps a build with no Opensteer account as it always was", async () => {
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          render({
            account: { ...signedOut, available: false, detail: "No Account service." },
            portalOrigin: "https://portal.example.com",
          }),
        ),
      );
      expect(button("Sign in")).toBeUndefined();
      expect(container.textContent).toContain("Install it on your Mac");
      expect(button("Scan QR Code")).toBeDefined();
      expect(button("Enter address")).toBeDefined();
      expect(container.textContent).toContain("Use an address for Tailscale or your own server.");
      await click("Send me the Mac link");
      expect(share).toHaveBeenCalledWith({
        message: "https://portal.example.com/mac",
        url: "https://portal.example.com/mac",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("asks where a signed-in account with no Opensteer should have it, with no price and nothing to buy", async () => {
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          render({ portalOrigin: "https://portal.example.com", signedInAs: "alex@example.com" }),
        ),
      );
      expect(container.textContent).toContain("Where should your Opensteer live?");
      expect(container.textContent).toContain(addressWords("alex@example.com"));
      expect(button("Sign in")).toBeUndefined();
      expect(container.textContent).toContain("On your Mac");
      expect(container.textContent).toContain("Free. Works while your Mac is awake.");
      expect(container.textContent).toContain("On an Opensteer Cloud Computer");
      expect(container.textContent).toContain(
        "Always on. Set it up on the Opensteer website, then come back here.",
      );
      // The website's address is text to copy, never a link or a purchase, and no price shows.
      expect(container.textContent).toContain(
        addressWords("https://portal.example.com/cloud-computer/checkout"),
      );
      expect(container.querySelector("a")).toBeNull();
      expect(container.textContent).not.toContain("$20.00");
      expect(container.textContent).not.toMatch(/buy|price|subscribe|continue to checkout/iu);
      await click("Copy");
      expect(copy).toHaveBeenCalledWith("https://portal.example.com/cloud-computer/checkout");
      share.mockClear();
      await click("Send me the Mac link");
      expect(share).toHaveBeenCalledOnce();
      expect(container.textContent).toContain("Your Opensteer appears here as soon as it’s ready.");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
