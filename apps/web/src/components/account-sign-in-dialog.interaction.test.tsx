// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSignInFlow, AccountSignInState } from "@opensteer/client/host";
import { AccountSignInDialog } from "./account-sign-in-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const deviceCode: AccountSignInState = {
  error: null,
  harnessInstanceId: "hin-new",
  kind: "signing-in",
  methodId: "subscription",
  methods: [
    { kind: "device-code", label: "ChatGPT subscription", methodId: "subscription" },
    { inputLabel: "OpenAI API key", kind: "secret-input", label: "API key", methodId: "key" },
  ],
  session: {
    userCode: "7K2M-QX84T",
    view: {
      codeReplaced: false,
      inputKind: "code",
      kind: "pending",
      userCode: "7K2M-QX84T",
      verificationUrl: "https://auth.example.test/device",
    },
  },
};

function flowAt(state: AccountSignInState) {
  return {
    cancel: vi.fn(async () => undefined),
    chooseMethod: vi.fn(),
    getState: () => state,
    keepDuplicate: vi.fn(),
    removeDuplicate: vi.fn(async () => undefined),
    retry: vi.fn(),
    submit: vi.fn(async () => undefined),
    subscribe: () => () => undefined,
  } satisfies AccountSignInFlow;
}

async function mount(state: AccountSignInState) {
  const flow = flowAt(state);
  const onClose = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <AccountSignInDialog
        flow={flow}
        onClose={onClose}
        onDone={vi.fn()}
        title="Add Codex account"
        whereLabel="MacBook Pro"
      />,
    ),
  );
  return { flow, onClose };
}

function primary(): HTMLAnchorElement {
  const link = document.querySelector<HTMLAnchorElement>("a.btn--primary");
  if (!link) throw new Error("The main action is missing");
  return link;
}

describe("the one-time code", () => {
  it("copies and opens in one press, then says it is waiting", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mount(deviceCode);
    expect(primary().getAttribute("href")).toBe("https://auth.example.test/device");
    document.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await act(async () => primary().click());
    expect(writeText).toHaveBeenCalledWith("7K2M-QX84T");
    expect(document.body.textContent).toContain("Waiting for you to finish in your browser");
    expect(document.body.textContent).toContain("Copied");
    expect(document.querySelector("a.btn--primary")).toBeNull();
  });

  it("says so when the copy is refused, and the person can still continue", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("Write permission denied.", "NotAllowedError");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    vi.stubGlobal("document", Object.assign(document, { execCommand: () => false }));
    await mount(deviceCode);
    const copy = document.querySelector<HTMLButtonElement>(".account-sign-in__copy");
    await act(async () => copy?.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t copy");
    expect(document.body.textContent).not.toContain("Copied");
    expect(primary()).not.toBeNull();
  });
});

describe("when sign-in stops working", () => {
  it("offers Try again after a key is refused, rather than a dead form", async () => {
    const { flow } = await mount({
      error: "That key was refused.",
      harnessInstanceId: "hin-new",
      kind: "signing-in",
      methodId: "key",
      methods: [{ inputLabel: "API key", kind: "secret-input", label: "API key", methodId: "key" }],
      session: { userCode: null, view: { detail: "That key was refused.", kind: "failed" } },
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("refused");
    const again = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    await act(async () => again?.click());
    expect(flow.retry).toHaveBeenCalledTimes(1);
  });

  it("stops saying it is waiting once the code can no longer be watched", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
    const { flow } = await mount({ ...deviceCode, error: "The connection dropped." });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("connection dropped");
    expect(document.body.textContent).not.toContain("Waiting for you");
    const again = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    await act(async () => again?.click());
    expect(flow.retry).toHaveBeenCalledTimes(1);
  });
});

describe("a way out", () => {
  it("cancels nothing by itself when an account is already here, and asks instead", async () => {
    const { flow } = await mount({
      accountLabel: "you@personal.dev",
      harnessInstanceId: "hin-new",
      kind: "duplicate",
    });
    expect(document.body.textContent).toContain("you@personal.dev is already added");
    expect(flow.removeDuplicate).not.toHaveBeenCalled();
    expect(flow.keepDuplicate).not.toHaveBeenCalled();
  });
});
