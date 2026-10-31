// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  alert: null as null | { buttons: { onPress?: () => void; text: string }[]; message: string },
  hostClient: null as unknown,
}));

vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("@opensteer/client/react", () => ({
  useHostSelector: (client: { getSnapshot: () => unknown }, select: (value: unknown) => unknown) =>
    select(client.getSnapshot()),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26" },
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  Alert: {
    alert: (_title: string, message: string, buttons: { onPress?: () => void; text: string }[]) => {
      state.alert = { buttons, message };
    },
  },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
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
    Notice: ({ detail, title }: { detail: string; title: string }) => (
      <div role="note">
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    ),
    RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SecondaryButton: Button,
    SectionLabel: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    StatusDot: () => null,
  };
});

const { ChromeScreen } = await import("./chrome.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const research = "wsp_00000000-0000-4000-8000-000000000004";
const home = "wsp_00000000-0000-4000-8000-000000000005";
const mac = "bsr_00000000-0000-4000-8000-000000000001";
const laptop = "bsr_00000000-0000-4000-8000-000000000002";

function grant(site: string, workspaceId: string, lastSignedInAt: string | null = null) {
  return {
    createdAt: "2026-09-20T10:00:00.000Z",
    lastSignedInAt,
    preferredSourceId: mac,
    site,
    workspaceId,
  };
}

function host(sources: readonly object[], sites: readonly object[] = []) {
  const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
  const get = vi.fn(async () => ({ data: { sites, sources }, ok: true }));
  state.hostClient = {
    dispatch,
    getSnapshot: () => ({
      connection: "connected",
      network: "online",
      session: "authenticated",
      user: { id: "user-a" },
      workspaces: [
        { id: research, name: "Research", tone: "violet" },
        { id: home, name: "Home", tone: "teal" },
      ],
    }),
    rpc: { "browser.sources.get": get },
  };
  return { dispatch, get };
}

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  state.alert = null;
});

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await act(async () => undefined);
}

async function render(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<ChromeScreen route={{ params: { deploymentId: "deployment-a" } }} />),
  );
  await flush();
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
  await flush();
}

function text(): string {
  return document.body.textContent ?? "";
}

describe("mobile Chrome", () => {
  it("sends the person to their computer to connect, and offers no way to connect here", async () => {
    host([]);
    await render();

    expect(text()).toContain("You approve each site once.");
    expect(text()).toContain("Connect Chrome from Opensteer on your computer");
    expect(text()).not.toMatch(/invitation|Copy a login|Create/i);
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows each Chrome's presence, renames it, and disconnects only after the warning", async () => {
    const { dispatch, get } = host([
      {
        connected: true,
        createdAt: "2026-09-20T10:00:00.000Z",
        id: mac,
        lastSeenAt: null,
        name: "Chrome on Mac",
      },
      {
        connected: false,
        createdAt: "2026-09-20T10:00:00.000Z",
        id: laptop,
        lastSeenAt: "2026-09-01T10:00:00.000Z",
        name: "Work laptop",
      },
    ]);
    await render();

    expect(document.querySelector('[aria-label="Chrome on Mac, Online"]')).not.toBeNull();
    expect(text()).toContain("Offline · seen");

    await press("Rename Chrome on Mac");
    const field = document.querySelector('input[aria-label="Name"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(field, "Studio Chrome");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("Save");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Studio Chrome",
        sourceId: mac,
        type: "browser.source.rename",
      }),
    );

    await press("Disconnect Work laptop");
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "browser.source.revoke" }),
    );
    expect(state.alert?.message).toContain("Browsers already signed in stay signed in.");
    await act(async () =>
      state.alert?.buttons.find((item) => item.text === "Disconnect")?.onPress?.(),
    );
    await flush();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: laptop, type: "browser.source.revoke" }),
    );
    expect(text()).toContain("Work laptop disconnected.");
    expect(get.mock.calls.length).toBeGreaterThan(1);
  });

  it("groups allowed sites by site and removes one Workspace's permission", async () => {
    const { dispatch } = host(
      [
        {
          connected: true,
          createdAt: "2026-09-20T10:00:00.000Z",
          id: mac,
          lastSeenAt: null,
          name: "Chrome on Mac",
        },
      ],
      [
        grant("https://github.com", research, "2026-09-22T10:00:00.000Z"),
        grant("https://example.com", home),
        grant("https://github.com", home),
      ],
    );
    await render();

    const body = text();
    expect(body.indexOf("example.com")).toBeLessThan(body.indexOf("github.com"));
    expect(body.match(/github\.com/g)).toHaveLength(1);
    expect(body).toContain("Not used yet");
    expect(body).toContain("Last signed in");

    await press("Remove github.com from Home");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        site: "https://github.com",
        type: "browser.site.remove",
        workspaceId: home,
      }),
    );
    expect(text()).toContain("github.com removed from Home.");
  });
});
