// @vitest-environment happy-dom

import type { DesktopComputerUseApprovalPresentation } from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseApprovalPanel,
  type ComputerUseApprovalPanelBridge,
} from "./computer-use-approval-panel.js";

const roots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const appRequest: DesktopComputerUseApprovalPresentation = {
  access: "read-write",
  accessLabel: "Can see and control",
  accessSummary: "Agents can see the app and click, type, scroll, press keys, and open it.",
  app: {
    bundleId: "com.apple.Notes",
    displayName: "Notes",
    iconPng: null,
    path: "/System/Applications/Notes.app",
    reason: null,
    risk: "standard",
  },
  deploymentName: "Alex's Deployment",
  kind: "app",
  machineName: "Alex's MacBook Pro",
  reason: "Copy the meeting notes into the plan.",
  threadTitle: "Plan the offsite",
  token: "token",
  workspaceName: "Research",
};

describe("ComputerUseApprovalPanel", () => {
  it("asks only the question, with the elevated note straight after the access", async () => {
    // Failure: macOS setup instructions crowd the approval; the setup guide
    // shows those steps as pictures once Allow is accepted.
    const { container } = await mount({
      ...appRequest,
      app: { ...appRequest.app, risk: "elevated" },
    });
    expect(container.textContent).not.toContain("After you allow");
    expect(container.textContent).not.toContain("System Settings");
    const access = container.querySelector(".cu-approve__access");
    expect(access?.nextElementSibling?.className).toBe("cu-approve__elevated");
  });

  it("lands the first key on Don't allow, so a stray Return or Space never approves", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { bridge } = await mount(appRequest);
    expect(document.activeElement?.textContent).toBe("Don't allow");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();

    await act(async () => {
      (document.activeElement as HTMLButtonElement).click();
    });
    expect(bridge.computerUseApprovalRespond).toHaveBeenCalledWith({
      allow: false,
      token: "token",
    });
  });

  it("names what an elevated app can reach", async () => {
    const { container } = await mount({
      ...appRequest,
      app: { ...appRequest.app, reason: "Finder reaches every file.", risk: "elevated" },
    });
    expect(container.textContent).toContain(
      "This app can reach your files, signed-in accounts or system settings. Agents can use whatever its interface offers.",
    );
  });

  it("confirms automatic approval with its whole consequence, Cancel first", async () => {
    const { bridge, container } = await mount({
      appApproval: "automatic",
      deploymentName: "Alex's Deployment",
      kind: "policy",
      machineName: "Alex's MacBook Pro",
      token: "token",
    });
    expect(container.querySelector("h1")?.textContent).toBe(
      "Allow any app automatically on this Mac?",
    );
    expect(container.textContent).toContain(
      "Agents acting for you can see and control any app on this Mac when a task needs it, including apps installed later, and including browsers, Finder, Mail and System Settings with what they are signed in to. Password managers, terminals and automation tools stay off limits. Blocked apps stay blocked.",
    );
    expect(buttons(container)).toEqual(["Cancel", "Allow any app"]);
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(
      container
        .querySelector(".cu-approve__content")
        ?.contains(container.querySelector(".cu-approve__consequence")),
    ).toBe(true);
    expect(container.querySelector(".cu-approve__content")?.getAttribute("tabindex")).toBe("0");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Allow any app")
        ?.click();
    });
    expect(bridge.computerUseApprovalRespond).toHaveBeenCalledWith({ allow: true, token: "token" });
  });

  it("offers a way out of a frameless window when the request is gone", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const bridge = {
      computerUseApprovalGet: vi.fn(async () => {
        throw new Error("That Computer use approval is no longer open.");
      }),
      computerUseApprovalRespond: vi.fn(async () => undefined),
    } satisfies ComputerUseApprovalPanelBridge;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(<ComputerUseApprovalPanel bridge={bridge} token="token" />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("That Computer use approval is no longer open.");
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(close).toHaveBeenCalledOnce();
    close.mockRestore();
  });

  it("declines on Escape", async () => {
    const { bridge } = await mount(appRequest);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(bridge.computerUseApprovalRespond).toHaveBeenCalledWith({
      allow: false,
      token: "token",
    });
  });
});

async function mount(presentation: DesktopComputerUseApprovalPresentation) {
  const bridge = {
    computerUseApprovalGet: vi.fn(async () => presentation),
    computerUseApprovalRespond: vi.fn(async () => undefined),
  } satisfies ComputerUseApprovalPanelBridge;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<ComputerUseApprovalPanel bridge={bridge} token="token" />);
    await Promise.resolve();
  });
  return { bridge, container };
}

function buttons(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll("button")].map(({ textContent }) => textContent);
}
