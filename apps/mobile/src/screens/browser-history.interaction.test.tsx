// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  alert: null as null | {
    buttons: { onPress?: () => void; text: string }[];
    message: string;
    title: string;
  },
  hostClient: null as unknown,
}));

vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    children,
    actions,
    onPressAction,
  }: {
    children?: ReactNode;
    actions: { id: string; title: string; attributes?: { disabled?: boolean } }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {children}
      {actions.map((action) => (
        <button
          key={action.id}
          aria-label={action.title}
          disabled={action.attributes?.disabled}
          onClick={() => onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock("@opensteer/client/react", () => ({
  useHostSelector: (client: { getSnapshot: () => unknown }, select: (value: unknown) => unknown) =>
    select(client.getSnapshot()),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  Alert: {
    alert: (_title: string, message: string, buttons: { onPress?: () => void; text: string }[]) => {
      state.alert = { buttons, message, title: _title };
    },
  },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  Pressable: ({
    accessibilityLabel,
    children,
    onPress,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  Image: ({ source }: { source: { uri: string } }) => <img src={source.uri} />,
  FlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    data: readonly { url: string; title: string }[];
    renderItem: (props: { item: { url: string; title: string } }) => ReactNode;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.length === 0
        ? ListEmptyComponent
        : data.map((item) => <div key={item.url}>{renderItem({ item })}</div>)}
    </div>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({
    accessibilityLabel,
    children,
  }: {
    accessibilityLabel?: string;
    children?: ReactNode;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../theme.js", () => ({ color: {}, radius: {}, space: {}, touchTarget: 44 }));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/workspace-mark.js", () => ({ WorkspaceDot: () => null }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({ openDeployment: vi.fn() }),
  useMobileState: () => ({
    rows: [{ deploymentId: "deployment-a", name: "Home", signIn: null }],
    selection: { deploymentId: "deployment-a", hostClient: state.hostClient },
  }),
}));
vi.mock("../ui/primitives.js", () => {
  const Button = ({
    accessibilityLabel,
    busy,
    disabled,
    label,
    onPress,
  }: {
    accessibilityLabel?: string;
    busy?: boolean;
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel ?? label} disabled={disabled || busy} onClick={onPress}>
      {busy ? "Working…" : label}
    </button>
  );
  return {
    AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Field: ({
      input,
      label,
    }: {
      input: { value?: string; onChangeText?: (value: string) => void };
      label: string;
    }) => (
      <input
        aria-label={label}
        onChange={(event) => input.onChangeText?.(event.target.value)}
        value={input.value ?? ""}
      />
    ),
    Notice: ({
      action,
      detail,
      title,
    }: {
      action?: { label: string; onPress: () => void };
      detail: string;
      title: string;
    }) => (
      <div role="note">
        <strong>{title}</strong>
        <p>{detail}</p>
        {action ? (
          <button aria-label={action.label} onClick={action.onPress} type="button">
            {action.label}
          </button>
        ) : null}
      </div>
    ),
    RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SecondaryButton: Button,
    SectionLabel: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    StatusDot: () => null,
    SwitchRow: ({
      label,
      value,
      disabled,
      onChange,
    }: {
      label: string;
      value: boolean;
      disabled?: boolean;
      onChange: (value: boolean) => void;
    }) => (
      <button aria-label={label} disabled={disabled} onClick={() => onChange(!value)}>
        {value ? "Allowed" : "Not allowed"}
      </button>
    ),
  };
});

const { BrowserHistoryScreen } = await import("./browser-history.js");
const { BrowserHistoryClient } = await import("@opensteer/client/host");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  state.alert = null;
});

async function render(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <BrowserHistoryScreen
        route={{ params: { deploymentId: "deployment-a", profileId: "bpr_work" } }}
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`No button ${label}: ${text()}`);
  return found;
}

async function press(label: string): Promise<void> {
  await act(async () => button(label).click());
}

function text(): string {
  return document.body.textContent ?? "";
}

function entry(url: string, title: string, lastVisitAt = "2026-10-31T12:00:00.000Z") {
  return { url, title, lastVisitAt, visitCount: 1, typedCount: 1 };
}

function host(online = true, owned = true) {
  let entries = [
    entry("https://new.example/page", "Newest"),
    entry("https://old.example/", "", "2026-10-30T12:00:00.000Z"),
  ];
  const get = vi.fn(async () => ({
    entries,
    icons: [{ origin: "https://new.example", iconRef: "icon-new" }],
  }));
  const remove = vi.fn(async (_profileId: string, url: string) => {
    entries = entries.filter((entry) => entry.url !== url);
  });
  const clear = vi.fn(async () => {
    entries = [];
  });
  const icons = vi.fn(async () => ({
    icons: [{ iconRef: "icon-new", favicon: "data:image/png;base64,AAAA" }],
  }));
  const history = new BrowserHistoryClient({ get, remove, clear, icons });
  history.setScope({ deploymentId: "deployment-a", userId: "user-a" });
  const snapshot = {
    connection: online ? "connected" : "disconnected",
    network: online ? "online" : "offline",
    session: "authenticated",
    user: { id: "user-a" },
    browserProfiles: owned ? [{ id: "bpr_work", name: "Work", revision: 1 }] : [],
  };
  state.hostClient = { browserHistory: history, getSnapshot: () => snapshot };
  return {
    get,
    remove,
    clear,
    icons,
    history,
    snapshot,
    update: () => {
      entries = [entry("https://live.example/", "Live visit")];
    },
  };
}

describe("mobile browsing history", () => {
  it("loads newest-first with title/host and cached site icons, removes, confirms clear, and updates live", async () => {
    const { get, remove, clear, icons, history, update } = host();
    await render();
    expect(get).toHaveBeenCalledWith("bpr_work");
    expect(text().indexOf("Newest")).toBeLessThan(text().indexOf("old.example"));
    expect(text()).toContain("new.example");
    expect(icons).toHaveBeenCalledWith("bpr_work", ["icon-new"]);
    expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    await press("Remove from history");
    expect(remove).toHaveBeenCalledWith("bpr_work", "https://new.example/page");
    expect(text()).not.toContain("Newest");
    await press("Clear browsing history");
    expect(clear).not.toHaveBeenCalled();
    expect(state.alert?.title).toBe("Clear browsing history?");
    await act(async () =>
      state.alert?.buttons.find((button) => button.text === "Cancel")?.onPress?.(),
    );
    expect(clear).not.toHaveBeenCalled();
    await press("Clear browsing history");
    await act(async () =>
      state.alert?.buttons.find((button) => button.text === "Clear browsing history")?.onPress?.(),
    );
    expect(clear).toHaveBeenCalledWith("bpr_work");
    expect(text()).toContain("No browsing history yet.");
    expect(button("Clear browsing history").disabled).toBe(true);
    update();
    await act(async () => history.changed("bpr_work"));
    expect(text()).toContain("Live visit");
    expect(text()).not.toContain("No browsing history yet.");
  });

  it("disables mutations while disconnected and does not fetch", async () => {
    const { get, history, icons } = host(false);
    history.ports.get = async () => ({
      entries: [entry("https://cached.example/", "Cached")],
      icons: [],
    });
    await history.load("bpr_work");
    await render();
    expect(text()).toContain("Not connected");
    expect(get).not.toHaveBeenCalled();
    expect(icons).not.toHaveBeenCalled();
    expect(button("Clear browsing history").disabled).toBe(true);
    expect(button("Remove from history").disabled).toBe(true);
  });

  it("does not load a Guest or granted profile absent from the owner catalog", async () => {
    const { get } = host(true, false);
    await render();
    expect(text()).toContain("Only the profile’s owner");
    expect(get).not.toHaveBeenCalled();
    expect(text()).not.toContain("Clear browsing history");
  });

  it("says a failed read is a failure, not empty history, and retries on request", async () => {
    const { get } = host();
    get.mockRejectedValueOnce(new Error("Host unreachable"));
    await render();
    expect(text()).toContain("Browsing history couldn’t be loaded");
    expect(text()).not.toContain("No browsing history yet.");
    await press("Try again");
    expect(get).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Newest");
    expect(text()).not.toContain("couldn’t be loaded");
  });

  it("keeps a failed refresh visible over rows already shown", async () => {
    const { get, history } = host();
    await render();
    expect(text()).toContain("Newest");
    get.mockRejectedValueOnce(new Error("Host unreachable"));
    await act(async () => history.changed("bpr_work"));
    expect(text()).toContain("Newest");
    expect(text()).toContain("Browsing history couldn’t be loaded");
    await press("Try again");
    expect(text()).not.toContain("couldn’t be loaded");
  });

  it("tells apart pages that share a title, in the row and its remove control", async () => {
    const { get } = host();
    get.mockResolvedValue({
      entries: [
        entry("https://bank.example/one", "Account"),
        entry("https://bank.example/two?tab=2", "Account"),
      ],
      icons: [],
    });
    await render();
    expect(text()).toContain("bank.example/one");
    expect(text()).toContain("bank.example/two?tab=2");
    const labels = [...document.querySelectorAll("[aria-label^='History actions for']")].map(
      (control) => control.getAttribute("aria-label"),
    );
    expect(new Set(labels).size).toBe(2);
  });

  it("reports mutation errors", async () => {
    const { remove } = host();
    remove.mockRejectedValueOnce(new Error("Try again later"));
    await render();
    await press("Remove from history");
    expect(text()).toContain("Try again later");
  });
});
