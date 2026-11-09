// @vitest-environment happy-dom
import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Alert } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiAccounts } from "./settings-ai-accounts.js";
import type { AiAccountsForm } from "./settings-form.types.js";

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => undefined) }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (input: { default?: unknown }) => input.default },
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn(async () => undefined) },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/primitives.js", () => {
  const button = ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  );
  return {
    AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Field: ({ label }: { label: string }) => <label>{label}</label>,
    Notice: ({ detail }: { detail: string }) => <p>{detail}</p>,
    PrimaryButton: button,
    RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SecondaryButton: button,
    SectionLabel: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    monoFontFamily: "monospace",
  };
});
vi.mock("../ui/choice-menu.js", () => ({ ChoiceMenu: () => null }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({
    children,
    footer,
    onClose,
    title,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    onClose: () => void;
    title: string;
  }) => (
    <section aria-label={title}>
      <button onClick={onClose}>Close</button>
      {children}
      {footer}
    </section>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let client: MockHostClient;
let form: AiAccountsForm;

function Page(props: { readonly host: HostClient }): ReactNode {
  const accounts = useAiAccounts(props.host);
  form = accounts.form;
  return accounts.sheet;
}

beforeEach(async () => {
  vi.useFakeTimers();
  client = new MockHostClient({ latencyMs: 0, now: () => new Date(Date.now()) });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Page host={client} />));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  client.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function signedOutAccount(driverKind: string, name: string) {
  const account = client.getSnapshot().harnesses.find((item) => item.driverKind === driverKind)!;
  const created = await act(async () =>
    client.dispatch({
      driverKind,
      environmentId: account.environmentId,
      idempotencyKey: `create-${name}`,
      name,
      sourceId: account.sourceId,
      stateKind: "isolated",
      type: "harness.create",
    }),
  );
  if (created.type !== "harness.create") throw new Error("Create command mismatch.");
  await act(async () => vi.advanceTimersByTimeAsync(0));
  const row = form.groups
    .find((group) => group.driverKind === driverKind)
    ?.rows.find((candidate) => candidate.id === created.harness.id);
  expect(row, `${name} never reached the page`).toBeDefined();
  return row!;
}

const press = async (label: string) => {
  const target = [...document.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
};

describe("accounts on the AI settings page", () => {
  it("signs a signed-out account in from its row and says who it is", async () => {
    const row = await signedOutAccount("codex", "Codex signed out");
    expect(row.primary?.label).toBe("Sign in");
    expect(row.line).toBeNull();

    await act(async () => form.onAction(row.id, row.primary!));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(document.querySelector('[aria-label="Sign in to Codex"]')).not.toBeNull();
    expect(document.body.textContent).toContain("DEMO-1234");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(
      () =>
        expect(form.confirmation, "the finished sign-in was never confirmed").toBe(
          "Signed in as demo@opensteer.test",
        ),
      { timeout: 1_000 },
    );
    expect(document.querySelector("section")).toBeNull();
  });

  it("checks again for an account that signs in on its computer", async () => {
    const cursor = client.getSnapshot().harnesses.find((item) => item.driverKind === "cursor")!;
    await act(async () =>
      client.dispatch({
        environmentId: cursor.environmentId,
        harnessInstanceId: cursor.id,
        idempotencyKey: "cursor-signed-out",
        type: "harness.authentication.logout",
      }),
    );
    const row = form.groups
      .find((group) => group.driverKind === "cursor")
      ?.rows.find((candidate) => candidate.id === cursor.id);
    expect(row?.primary?.label).toBe("Check again");
    expect(row?.line).toBe("Sign in required");
    const { rpc } = client;
    const refresh = vi.fn(rpc["harness.catalog.refresh"]);
    Object.defineProperty(client, "rpc", {
      value: new Proxy(rpc, {
        get: (target, key) =>
          key === "harness.catalog.refresh" ? refresh : Reflect.get(target, key),
      }),
    });

    await act(async () => form.onAction(cursor.id, row!.primary!));

    expect(refresh).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ harnessInstanceId: cursor.id }),
    );
    expect(document.querySelector("section")).toBeNull();
  });

  it("removes an account only after the person confirms", async () => {
    const row = await signedOutAccount("codex", "Codex to remove");
    const remove = row.menu.find((action) => action.id === "remove")!;

    await act(async () => form.onAction(row.id, remove));
    expect(client.getSnapshot().harnesses.some((item) => item.id === row.id)).toBe(true);

    const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2];
    await act(async () => buttons?.find((button) => button.text === "Remove")?.onPress?.());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(client.getSnapshot().harnesses.some((item) => item.id === row.id)).toBe(false);
  });

  it("asks for a source first, then removes the new account if its sheet closes", async () => {
    const before = client.getSnapshot().harnesses.length;
    await act(async () => form.onAdd("claude"));
    expect(document.body.textContent).toContain("Who should this account talk to?");
    expect(client.getSnapshot().harnesses).toHaveLength(before);

    await press("Continue");
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(client.getSnapshot().harnesses).toHaveLength(before + 1);

    await press("Close");
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(document.querySelector("section")).toBeNull();
    expect(client.getSnapshot().harnesses).toHaveLength(before);
  });
});
