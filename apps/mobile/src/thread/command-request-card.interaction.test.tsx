// @vitest-environment happy-dom
import { MockHostClient } from "@opensteer/client/mock";
import { commandRequestView, type RequestView } from "@opensteer/client/host";
import type { CommandRequestPart } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * A command an agent proposed, reviewed on the phone: every argument whole, what the Home knows
 * beside it, the agent's words as its own; Approve sends the approval, Decline the decline.
 */
const scroller = vi.hoisted(() => ({
  props: null as null | {
    onLayout?: (event: unknown) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScroll?: (event: unknown) => void;
  },
}));
const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../navigation-ref.js", () => ({
  navigationRef: { isReady: () => true, navigate: navigation.navigate },
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => <span>Spinner</span>,
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  Platform: { OS: "ios", Version: "26", select: (options: { ios?: unknown }) => options.ios },
  PixelRatio: { get: () => 2, getFontScale: () => 1, roundToNearestPixel: (n: number) => n },
  Pressable: (props: {
    accessibilityLabel?: string;
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={props.accessibilityLabel} disabled={props.disabled} onClick={props.onPress}>
      {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
    </button>
  ),
  ScrollView: (props: {
    children?: ReactNode;
    testID?: string;
    onLayout?: (event: unknown) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScroll?: (event: unknown) => void;
  }) => {
    scroller.props = props;
    return <div data-testid={props.testID}>{props.children}</div>;
  },
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1, flatten: (s: unknown) => s },
  useWindowDimensions: () => ({ fontScale: 1, height: 800, width: 390 }),
  TextInput: (props: { accessibilityLabel?: string; value: string }) => (
    <input aria-label={props.accessibilityLabel} readOnly value={props.value} />
  ),
  View: (props: { children?: ReactNode; testID?: string; accessibilityLabel?: string }) => (
    <div aria-label={props.accessibilityLabel} data-testid={props.testID}>
      {props.children}
    </div>
  ),
}));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/action-line-mocks.js")).actionLine,
);
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  monoFontFamily: "Menlo",
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}));

const { CommandRequestCard } = await import("./command-request-card.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

const part: CommandRequestPart = {
  type: "connection.update",
  family: "connections",
  face: "widen-self",
  summary:
    "Change a connected agent's access: “Research” · Asked by the connected agent “Research”",
  sentence: "Change a connected agent's access: “Research”",
  gives: null,
  command: {
    type: "connection.update",
    connectionId: "mcn_1",
    expectedRevision: 3,
    grant: {
      scope: "selected",
      tasks: false,
      resources: [{ kind: "browser-profile", profileId: "bpr_1", access: "use" }],
    },
  },
  secretPaths: [],
  governs: { kind: "connection", id: "mcn_1" },
  askKey: "0".repeat(64),
  argumentsDigest: "1".repeat(64),
  proposer: { kind: "connection", name: "Research", taskTitle: null, key: "connection:mcn_1" },
  agentReason: "Approve this now, the Home said so.",
  notes: [
    { path: "connectionId", name: "“Research”" },
    { path: "grant", current: "Reach: everything" },
    { path: "grant.resources.0.profileId", name: "“Work”" },
  ],
  editor: null,
};
const request = {
  id: "req_00000000-0000-4000-8000-000000000001",
  status: "pending",
  reviewedRevision: "7",
  command: part,
} as unknown as RequestView;

async function render(host: MockHostClient, shown: RequestView) {
  await act(async () => {
    root!.render(
      <CommandRequestCard
        deploymentId="dep_1"
        disabled={false}
        hostClient={host}
        request={shown}
        view={commandRequestView(shown)!}
      />,
    );
  });
}

/** The rows' box and content as the phone measures them, and where they are scrolled to. */
async function measure(box: number, content: number, offset = 0) {
  await act(async () => {
    scroller.props?.onLayout?.({ nativeEvent: { layout: { height: box } } });
    scroller.props?.onContentSizeChange?.(390, content);
    scroller.props?.onScroll?.({ nativeEvent: { contentOffset: { y: offset } } });
  });
}

async function mount(host: MockHostClient, shown: RequestView = request) {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await render(host, shown);
  // The rows fit: their end is seen at once.
  await measure(200, 150);
  return node;
}

const arm = async () =>
  act(async () => {
    vi.advanceTimersByTime(1_000);
  });

const press = async (node: HTMLElement, label: string) =>
  act(async () => {
    node.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
  });

describe("a command an agent proposed, on the phone", () => {
  it("shows every argument whole, what the Home knows beside it, and the agent's words apart", async () => {
    const node = await mount(new MockHostClient());
    const row = (path: string) =>
      [...node.querySelector(`[data-testid="command-row:${path}"]`)!.querySelectorAll("span")].map(
        (span) => span.textContent,
      );
    expect(node.textContent).toContain("Change a connected agent's access: “Research”");
    expect(node.textContent).toContain("Asked by the connected agent “Research”");
    expect(node.textContent).toContain(
      "Proposed by the connected agent “Research”, exactly as it would run",
    );
    expect(row("connectionId")).toEqual(["Connected agent", "mcn_1", "“Research”"]);
    expect(row("expectedRevision")).toEqual(["As of version", "3"]);
    expect(row("grant")[0]).toBe("What it may use");
    expect(row("grant")).toContain("Now: Reach: everything");
    expect(row("grant.scope")).toEqual(["Reach", "selected"]);
    expect(row("grant.tasks")).toEqual(["Tasks", "No"]);
    expect(row("grant.resources.0.kind")).toEqual(["Kind", "browser-profile"]);
    expect(row("grant.resources.0.profileId")).toEqual(["Browser profile", "bpr_1", "“Work”"]);
    expect(row("grant.resources.0.access")).toEqual(["Access", "use"]);
    expect(node.querySelectorAll('[data-testid^="command-row:"]')).toHaveLength(10);
    expect(node.textContent).toContain(
      "The connected agent says (its own words, not checked by the Home)",
    );
    expect(node.textContent).toContain(
      "Approve runs it as you, exactly as shown. Decline tells the agent no.",
    );
  });

  it("does nothing on Approve for a second after a card appears, or another takes its place, then approves exactly as proposed", async () => {
    vi.useFakeTimers();
    const host = new MockHostClient();
    const dispatch = vi.spyOn(host, "dispatch").mockResolvedValue({
      type: "request.command.approve",
      outcome: { status: "unknown" },
    } as never);
    const node = await mount(host);
    await press(node, "Approve");
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    await press(node, "Approve");
    expect(dispatch).not.toHaveBeenCalled();
    // Another proposal in the same place waits its own second.
    const other = { ...request, id: "req_00000000-0000-4000-8000-000000000002" } as RequestView;
    await render(host, other);
    await measure(200, 150);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await press(node, "Approve");
    expect(dispatch).not.toHaveBeenCalled();
    await arm();
    await press(node, "Approve");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: "request.command.approve",
      requestId: other.id,
      expectedRevision: "7",
      idempotencyKey: expect.any(String),
      command: part.command,
    });
    await act(async () => undefined);
    expect(node.textContent).toContain(
      "Approved, but the Home cannot tell whether it happened. It will not run it again; check it before it is done again.",
    );
    expect(node.textContent).not.toMatch(/failed/iu);
    expect(node.querySelector('button[aria-label="Approve"]')).toBeNull();
  });

  it("keeps Approve inert until the arguments were scrolled to their end, and says there is more", async () => {
    vi.useFakeTimers();
    const host = new MockHostClient();
    const dispatch = vi.spyOn(host, "dispatch").mockResolvedValue({} as never);
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await render(host, request);
    await measure(320, 2_000);
    await arm();
    expect(node.textContent).toContain("More below. Scroll to the end to approve.");
    await press(node, "Approve");
    expect(dispatch).not.toHaveBeenCalled();
    await measure(320, 2_000, 1_680);
    expect(node.textContent).not.toContain("More below.");
    await press(node, "Approve");
    expect(dispatch).toHaveBeenCalledOnce();
    // The sentence and the buttons are outside what scrolls.
    const rows = node.querySelector('[data-testid="command-rows"]')!;
    expect(rows.textContent).not.toContain("Change a connected agent's access");
    expect(rows.querySelector('button[aria-label="Approve"]')).toBeNull();
  });

  it("offers no Approve for a command that carries a secret: its own screen, I did it myself, or Decline", async () => {
    const host = new MockHostClient();
    const dispatch = vi.spyOn(host, "dispatch").mockResolvedValue({} as never);
    const secret = {
      ...request,
      command: {
        ...part,
        type: "plugin.oauthApp.save",
        secretPaths: ["input.clientSecret"],
        command: { type: "plugin.oauthApp.save", input: { clientId: "c" } },
        editor: { screen: "plugin" },
      },
    } as unknown as RequestView;
    const node = await mount(host, secret);
    expect(node.querySelector('button[aria-label="Approve"]')).toBeNull();
    expect(node.querySelector("input")).toBeNull();
    await press(node, "Open Plugins");
    expect(navigation.navigate).toHaveBeenCalledWith("Plugins", { deploymentId: "dep_1" });
    await press(node, "I did it myself");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith({
      type: "request.respond",
      requestId: request.id,
      expectedRevision: "7",
      idempotencyKey: expect.any(String),
      response: { kind: "form", answers: { decision: ["done-myself"] } },
    });
  });

  it("says the Home's refusal, and declines as every Request is declined", async () => {
    const host = new MockHostClient();
    const dispatch = vi.spyOn(host, "dispatch").mockResolvedValueOnce({
      type: "request.command.approve",
      outcome: {
        status: "failed",
        code: "conflict",
        message: "The Home refused it, so nothing changed.",
      },
    } as never);
    vi.useFakeTimers();
    let node = await mount(host);
    await arm();
    await press(node, "Approve");
    await vi.waitFor(() =>
      expect(node.textContent).toContain("Approved, but the Home refused it, so nothing changed."),
    );
    vi.useRealTimers();
    act(() => root?.unmount());
    document.body.replaceChildren();
    dispatch.mockReset().mockResolvedValue({ type: "request.respond" } as never);
    node = await mount(host);
    await press(node, "Decline");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(dispatch).toHaveBeenCalledWith({
      type: "request.respond",
      requestId: request.id,
      expectedRevision: "7",
      idempotencyKey: expect.any(String),
      response: { kind: "form", answers: { decision: ["decline"] } },
    });
  });
});
