// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Welcome } from "./welcome.js";

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
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: ({ detail }: { detail: string }) => <span>{detail}</span>,
  PrimaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  RowGroup: ({ children }: { children: readonly ReactNode[] }) => <div>{children}</div>,
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
  it("leads with the Mac link and the scan, then the Account and an address", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const signIn = vi.fn();
    const scan = vi.fn();
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
        failure={null}
        onAccount={signIn}
        onAddress={() => undefined}
        onScan={scan}
        portalOrigin={props.portalOrigin}
        signedInAs={props.signedInAs ?? null}
        signingIn={props.signingIn ?? false}
      />
    );
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find((item) => item.textContent === text);
    const click = async (text: string) => {
      expect(button(text), `Missing ${text}`).toBeDefined();
      await act(async () => button(text)!.click());
    };
    try {
      await act(async () => root.render(render({ portalOrigin: null })));
      expect(container.textContent).toContain("Opensteer runs on your Mac");
      expect(container.textContent).toContain("Enter address");
      expect(container.textContent).not.toContain("Send me the Mac link");
      await click("Scan QR Code");
      expect(scan).toHaveBeenCalledOnce();
      await click("Sign in");
      expect(signIn).toHaveBeenCalledOnce();

      // While the browser is open, the Account row says so and cannot start a second sign-in.
      await act(async () => root.render(render({ portalOrigin: null, signingIn: true })));
      expect(button("Finish signing in in your browserLoading")?.disabled).toBe(true);

      // A build with no Account offers only the address.
      await act(async () =>
        root.render(
          render({
            account: { ...signedOut, available: false, detail: "No Account service." },
            portalOrigin: null,
          }),
        ),
      );
      expect(button("Sign in")).toBeUndefined();
      expect(container.textContent).toContain("Enter address");

      await act(async () => root.render(render({ portalOrigin: "https://portal.example.com" })));
      await click("Send me the Mac link");
      expect(share).toHaveBeenCalledWith({
        message: "https://portal.example.com/mac",
        url: "https://portal.example.com/mac",
      });

      // Signed in with no Opensteer yet: who, and no second sign-in.
      await act(async () =>
        root.render(render({ portalOrigin: null, signedInAs: "alex@example.com" })),
      );
      expect(container.textContent).toContain("alex@example.com");
      expect(button("Sign in")).toBeUndefined();
      expect(container.textContent).toContain(
        "Your Opensteer appears here as soon as your Mac has it.",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });
});
