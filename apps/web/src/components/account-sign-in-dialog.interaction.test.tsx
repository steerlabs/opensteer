// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabId } from "@opensteer/core";
import type { AccountSignInFlow, AccountSignInState } from "@opensteer/client/host";
import { AccountSignInAside, AccountSignInDialog } from "./account-sign-in-dialog.js";

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
  homeBrowser: null,
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

function flowAt(state: AccountSignInState, tabId: TabId | null = null) {
  return {
    cancel: vi.fn(async () => undefined),
    chooseMethod: vi.fn(),
    getState: () => state,
    openHomeBrowser: vi.fn(async () => tabId),
    keepDuplicate: vi.fn(),
    removeDuplicate: vi.fn(async () => undefined),
    retry: vi.fn(),
    submit: vi.fn(async () => undefined),
    subscribe: () => () => undefined,
  } satisfies AccountSignInFlow;
}

async function mount(
  state: AccountSignInState,
  options: { readonly onShowTab?: (tabId: TabId) => void; readonly tabId?: TabId } = {},
) {
  const flow = flowAt(state, options.tabId ?? null);
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
        onShowTab={options.onShowTab}
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
      homeBrowser: null,
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

describe("a sign-in that returns to the Home's computer", () => {
  const authorizationUrl =
    "https://accounts.example.test/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Fcallback";
  const returning = (
    homeBrowser: NonNullable<Extract<AccountSignInState, { kind: "signing-in" }>["homeBrowser"]>,
  ): AccountSignInState => ({
    error: null,
    harnessInstanceId: "hin-new",
    homeBrowser,
    kind: "signing-in",
    methodId: "google",
    methods: [{ kind: "browser-code", label: "Google", methodId: "google" }],
    session: {
      userCode: "",
      view: {
        codeReplaced: false,
        inputKind: "code",
        inputPrompt: "Paste the complete address from the browser after it redirects",
        kind: "pending",
        returnsToComputer: true,
        userCode: "",
        verificationUrl: authorizationUrl,
      },
    },
  });
  const button = (label: string) => {
    const found = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (!found) throw new Error(`No ${label} button`);
    return found;
  };

  it("opens in the Home's browser and shows that tab", async () => {
    const onShowTab = vi.fn();
    const tabId = "tab_0192f4a1-1111-4000-8000-000000000001" as TabId;
    const { flow } = await mount(
      returning({ error: null, opening: false, tabId: null, url: authorizationUrl }),
      { onShowTab, tabId },
    );
    expect(document.body.textContent).toContain("This sign-in finishes on MacBook Pro");
    // Nothing opens on this device first.
    expect(document.querySelector("a.btn--primary")).toBeNull();
    await act(async () => button("Open in MacBook Pro’s browser").click());
    expect(flow.openHomeBrowser).toHaveBeenCalledTimes(1);
    expect(onShowTab).toHaveBeenCalledWith(tabId);
  });

  it("shows the tab already open without opening another", async () => {
    const onShowTab = vi.fn();
    const tabId = "tab_0192f4a1-1111-4000-8000-000000000002" as TabId;
    const { flow } = await mount(
      returning({ error: null, opening: false, tabId, url: authorizationUrl }),
      { onShowTab },
    );
    await act(async () => button("Open in MacBook Pro’s browser").click());
    expect(flow.openHomeBrowser).not.toHaveBeenCalled();
    expect(onShowTab).toHaveBeenCalledWith(tabId);
  });

  it("says why the Home's browser refused, and still offers this device", async () => {
    await mount(
      returning({
        error: "The computer this AI engine runs on has no browser to finish this sign-in in.",
        opening: false,
        tabId: null,
        url: authorizationUrl,
      }),
      { onShowTab: vi.fn() },
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("has no browser");
    await act(async () => button("Open on this device").click());
    expect(primary().getAttribute("href")).toBe(authorizationUrl);
  });
});

describe("while the person is in the Home's browser tab", () => {
  async function aside(state: AccountSignInState) {
    const handlers = { onCancel: vi.fn(), onDone: vi.fn(), onReturn: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <AccountSignInAside flow={flowAt(state)} title="Sign in to Antigravity" {...handlers} />,
      ),
    );
    return handlers;
  }
  const waiting: AccountSignInState = {
    ...deviceCode,
    homeBrowser: {
      error: null,
      opening: false,
      tabId: "tab_0192f4a1-1111-4000-8000-000000000003" as TabId,
      url: "https://accounts.example.test/auth",
    },
  };

  it("keeps the sign-in going, and can go back or cancel", async () => {
    const handlers = await aside(waiting);
    expect(document.body.textContent).toContain("finish signing in in the browser tab");
    expect(handlers.onReturn).not.toHaveBeenCalled();
    const buttons = [...document.querySelectorAll("button")];
    await act(async () => buttons.find((item) => item.textContent === "Cancel")?.click());
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("finishes the sign-in when it succeeds", async () => {
    const done = {
      accountLabel: "person@example.com",
      harnessInstanceId: "hin-new",
      kind: "done",
    } as const;
    const handlers = await aside(done);
    expect(handlers.onDone).toHaveBeenCalledWith(done);
  });

  it("hands back to the dialog for anything the person must read", async () => {
    const handlers = await aside({ ...waiting, error: "Google refused the sign-in." });
    expect(handlers.onReturn).toHaveBeenCalledTimes(1);
  });
});
