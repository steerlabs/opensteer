// @vitest-environment happy-dom
import type { AccountSignInFlow, AccountSignInState } from "@opensteer/client/host";
import * as Clipboard from "expo-clipboard";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Linking } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabId } from "@opensteer/core";
import { AccountSignInAside, AccountSignInSheet } from "./account-sign-in-sheet.js";

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (input: { default?: unknown }) => input.default },
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn(async () => undefined) },
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/primitives.js", () => {
  const button = ({
    disabled,
    label,
    onPress,
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  );
  return {
    AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Field: () => null,
    Notice: ({ detail, title }: { detail: string; title: string }) => (
      <p>
        {title}: {detail}
      </p>
    ),
    PrimaryButton: button,
    RowGroup: () => null,
    SecondaryButton: button,
    SectionLabel: () => null,
    monoFontFamily: "monospace",
  };
});
vi.mock("../ui/choice-menu.js", () => ({ ChoiceMenu: () => null }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => (
    <section>
      {children}
      {footer}
    </section>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function fakeFlow(initial: AccountSignInState, tabId: TabId | null = null) {
  let state = initial;
  const listeners = new Set<() => void>();
  const flow: AccountSignInFlow = {
    cancel: vi.fn(async () => undefined),
    chooseMethod: vi.fn(),
    getState: () => state,
    openHomeBrowser: vi.fn(async () => tabId),
    keepDuplicate: vi.fn(),
    removeDuplicate: vi.fn(async () => undefined),
    retry: vi.fn(),
    submit: vi.fn(async () => undefined),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const move = (next: AccountSignInState) =>
    act(async () => {
      state = next;
      for (const listener of listeners) listener();
    });
  return { flow, move };
}

const signingIn = (error: string | null = null): AccountSignInState => ({
  error,
  harnessInstanceId: "account",
  homeBrowser: null,
  kind: "signing-in",
  methodId: "device",
  methods: [
    { connectionSlot: "primary", kind: "device-code", label: "Sign in", methodId: "device" },
  ],
  session: {
    userCode: "ABCD-1234",
    view: {
      codeReplaced: false,
      inputKind: "code",
      kind: "pending",
      userCode: "ABCD-1234",
      verificationUrl: "https://example.test/device",
    },
  },
});

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function render(
  flow: AccountSignInFlow,
  onDone = vi.fn(),
  onShowTab: ((tabId: TabId) => void) | null = null,
) {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(
      <AccountSignInSheet
        choosing={null}
        flow={flow}
        onClose={vi.fn()}
        onDone={onDone}
        onShowTab={onShowTab}
        title="Sign in to Codex"
        whereLabel="Studio Mac"
      />,
    ),
  );
  return onDone;
}

const press = async (label: string) => {
  const target = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
};

describe("the account sign-in sheet", () => {
  it("copies the code before opening the page, then waits and finishes", async () => {
    const { flow, move } = fakeFlow(signingIn());
    const onDone = await render(flow);
    expect(document.body.textContent).toContain("Enter this code on the page that opens.");

    await press("Copy code and open browser");

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("ABCD-1234");
    expect(Linking.openURL).toHaveBeenCalledWith("https://example.test/device");
    expect(vi.mocked(Clipboard.setStringAsync).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(Linking.openURL).mock.invocationCallOrder[0]!,
    );
    expect(document.body.textContent).toContain("Waiting for you to finish in your browser…");
    expect(document.body.textContent).toContain("Open browser again");
    expect(document.body.textContent).not.toContain("Copy code and open browser");

    await move({ harnessInstanceId: "account", kind: "finishing" });
    expect(document.body.textContent).toContain("Signed in. Finishing up…");

    const done = {
      accountLabel: "person@example.test",
      harnessInstanceId: "account",
      kind: "done",
    } as const;
    await move(done);
    expect(onDone).toHaveBeenCalledExactlyOnceWith(done);
  });

  it("says a failed copy, keeps the code on screen, and still opens the page", async () => {
    vi.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(new Error("No clipboard"));
    const { flow } = fakeFlow(signingIn());
    await render(flow);

    await press("Copy code and open browser");

    expect(document.body.textContent).toContain(
      "Couldn’t copy. Select the code and copy it yourself.",
    );
    expect(document.body.textContent).toContain("ABCD-1234");
    expect(Linking.openURL).toHaveBeenCalled();
  });

  it("clears a failed copy once copying works", async () => {
    vi.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false);
    const { flow } = fakeFlow(signingIn());
    await render(flow);
    await press("Copy");
    expect(document.body.textContent).toContain("Couldn’t copy.");
    await press("Copy");
    expect(document.body.textContent).not.toContain("Couldn’t copy.");
    expect(document.body.textContent).toContain("Copied");
  });

  it("offers Try again when the wait for a code fails, rather than waiting forever", async () => {
    const { flow, move } = fakeFlow(signingIn());
    await render(flow);
    await press("Copy code and open browser");

    await move(signingIn("The connection was lost."));

    expect(document.body.textContent).toContain("The connection was lost.");
    expect(document.body.textContent).not.toContain("Waiting for you to finish");
    await press("Try again");
    expect(flow.retry).toHaveBeenCalledOnce();
  });
});

describe("a sign-in that returns to the Home's computer", () => {
  const authorizationUrl =
    "https://accounts.example.test/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Fcallback";
  const tabId = "tab_0192f4a1-1111-4000-8000-000000000001" as TabId;
  const returning = (
    error: string | null = null,
    shown: TabId | null = null,
  ): AccountSignInState => ({
    error: null,
    harnessInstanceId: "account",
    homeBrowser: { error, opening: false, tabId: shown, url: authorizationUrl },
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

  it("opens in the Home's browser and shows that tab, never on the phone", async () => {
    const onShowTab = vi.fn();
    const { flow } = fakeFlow(returning(), tabId);
    await render(flow, vi.fn(), onShowTab);
    expect(document.body.textContent).toContain("This sign-in finishes on Studio Mac");
    await press("Open in Studio Mac’s browser");
    expect(flow.openHomeBrowser).toHaveBeenCalledOnce();
    expect(onShowTab).toHaveBeenCalledWith(tabId);
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it("says why the Home's browser refused, and can still open on the phone", async () => {
    const { flow } = fakeFlow(returning("The computer this AI engine runs on has no browser."));
    await render(flow, vi.fn(), vi.fn());
    expect(document.body.textContent).toContain("has no browser");
    await press("Open on this device");
    await press("Open sign-in page");
    expect(Linking.openURL).toHaveBeenCalledWith(authorizationUrl);
  });

  it("keeps the sign-in going from the screen underneath, then finishes or hands back", async () => {
    const { flow, move } = fakeFlow(returning(null, tabId));
    const onDone = vi.fn();
    const onReturn = vi.fn();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root!.render(
        <AccountSignInAside
          flow={flow}
          onCancel={vi.fn()}
          onDone={onDone}
          onReturn={onReturn}
          title="Sign in to Antigravity"
        />,
      ),
    );
    expect(document.body.textContent).toContain("finish signing in in the browser tab");
    const done = {
      accountLabel: "person@example.test",
      harnessInstanceId: "account",
      kind: "done",
    } as const;
    await move(done);
    expect(onDone).toHaveBeenCalledExactlyOnceWith(done);
    expect(onReturn).not.toHaveBeenCalled();
  });
});
