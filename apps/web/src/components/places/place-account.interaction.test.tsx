// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SignOutDialog } from "./place-account.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

it.each(["loaded", "failed"] as const)(
  "waits for main's durable sign-out inventory: %s",
  async (outcome) => {
    const read = Promise.withResolvers<readonly { deploymentId: string; name: string }[]>();
    const bridge = { accountSignOutPreview: vi.fn(() => read.promise) };
    const confirm = vi.fn(async () => undefined);
    const close = vi.fn();
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.querySelector("#root")!);
    await act(async () =>
      root!.render(<SignOutDialog bridge={bridge} onClose={close} onConfirm={confirm} />),
    );
    const button = () =>
      [...document.querySelectorAll("button")].find((entry) => entry.textContent === "Sign out")!;
    expect(button().disabled).toBe(true);
    expect(document.body.textContent).toContain("Checking");
    expect(document.body.textContent).not.toContain("nothing is deleted");
    await act(async () => {
      if (outcome === "failed") read.reject(new Error("Membership inventory could not be read"));
      else read.resolve([{ deploymentId: "parked-deployment", name: "Studio" }]);
    });
    if (outcome === "failed") {
      expect(button().disabled).toBe(true);
      expect(document.body.textContent).toContain("Membership inventory could not be read");
      expect(document.body.textContent).not.toContain("nothing is deleted");
      expect(confirm).not.toHaveBeenCalled();
    } else {
      expect(button().disabled).toBe(false);
      expect(document.body.textContent).toContain("This Mac is removed from Studio");
      expect(document.body.textContent).toContain("Browser profiles kept on this Mac");
      await act(async () => button().click());
      expect(confirm).toHaveBeenCalledOnce();
    }
  },
);
