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
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Notice: ({ detail }: { detail: string }) => <span>{detail}</span>,
}));

describe("first-run welcome", () => {
  it("reveals alternate connections and shares the configured Mac URL", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const signIn = vi.fn();
    const account = {
      available: true,
      detail: null,
      identity: null,
      origin: "https://accounts.example.com",
      status: "signed-out" as const,
    };
    const render = (portalOrigin: string | null) => (
      <Welcome
        account={account}
        failure={null}
        onAccount={signIn}
        onPersonal={() => undefined}
        onServer={() => undefined}
        portalOrigin={portalOrigin}
        signingIn={false}
      />
    );
    const click = async (text: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (item) => item.textContent === text,
      );
      expect(button, `Missing ${text}`).toBeDefined();
      await act(async () => button!.click());
    };
    try {
      await act(async () => root.render(render(null)));
      expect(container.textContent).toContain("Opensteer runs on your computer");
      expect(container.textContent).not.toContain("Get Opensteer for Mac");
      expect(container.textContent).not.toContain("Add a server by address");
      await click("Sign in");
      expect(signIn).toHaveBeenCalledOnce();
      await click("Other ways to connect");
      expect(container.textContent).toContain("Pair a computer");
      expect(container.textContent).toContain("Add a server by address");
      await act(async () => root.render(render("https://portal.example.com")));
      await click("Get Opensteer for Mac");
      expect(share).toHaveBeenCalledWith({
        message: "https://portal.example.com/mac",
        url: "https://portal.example.com/mac",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
