// @vitest-environment happy-dom

import type { SurfaceModel } from "@opensteer/client/host";
import type { Request } from "@opensteer/core";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadMutationGate } from "./thread-mutation-gate.js";

const native = vi.hoisted(() => ({
  alert: vi.fn(),
  bodyHeight: 60 as number | null,
  navigate: vi.fn(),
}));

vi.mock("./password-approval-auth.js", () => ({
  authenticatePasswordApproval: vi.fn(async () => true),
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => <span>Spinner</span>,
  Alert: { alert: native.alert },
  AppState: { addEventListener: () => ({ remove: () => undefined }), currentState: "active" },
  Platform: { OS: "ios", Version: "26" },
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
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ fontScale: 1, height: 800, width: 390 }),
  View: (props: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
  }) => {
    const { onLayout } = props;
    useEffect(() => {
      if (native.bodyHeight !== null) {
        onLayout?.({ nativeEvent: { layout: { height: native.bodyHeight } } });
      }
    }, []);
    return <div>{props.children}</div>;
  },
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_reason: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/ai-sharing.js", () => import("../../test-support/ai-sharing.js"));
vi.mock("../navigation-ref.js", () => ({
  navigationRef: { isReady: () => true, navigate: native.navigate },
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  StatusDot: () => null,
  monoFontFamily: "monospace",
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("./composer-menu.js", () => ({
  NativeMenu: (props: {
    accessibilityLabel: string;
    children?: ReactNode;
    options: readonly { id: string; label: string; onPress: () => void }[];
  }) => (
    <div aria-label={props.accessibilityLabel}>
      {props.children}
      {props.options.map((option) => (
        <button key={option.id} onClick={option.onPress}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./integration-connect-sheet.js", () => ({
  IntegrationConnectCard: () => <span>Inline Connect card</span>,
}));

const { RequestCard } = await import("./request-card.js");
const { resetRequestSessionsForTests } = await import("./request-session.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const threadId = "thr_00000000-0000-4000-8000-000000000001";

const allow = { hint: "allow-once", id: "allow", label: "Allow once" } as const;
const reject = { hint: "reject-once", id: "reject", label: "Reject" } as const;

beforeEach(() => {
  native.alert.mockClear();
  native.navigate.mockClear();
  native.bodyHeight = 60;
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  resetRequestSessionsForTests();
  vi.useRealTimers();
});

function approval(extra: object = {}, presentation: object = {}): Request {
  return {
    id: "req_00000000-0000-4000-8000-000000000001",
    kind: "harness.approval",
    mode: "live",
    originatingThreadId: threadId,
    payload: { kind: "harness.approval" },
    presentation: {
      detail: "pnpm test",
      kind: "choice",
      options: [allow, reject],
      risk: "medium",
      title: "Run this command?",
      ...presentation,
    },
    requestedBy: "usr_00000000-0000-4000-8000-000000000001",
    requiredActor: "requester",
    status: "pending",
    ...extra,
  } as unknown as Request;
}

function surfaceOf(request: Request, denied: SurfaceModel["denied"] = null): SurfaceModel {
  return { denied, queued: 0, queuedTitle: null, request, textRole: "message" };
}

async function render(
  surface: SurfaceModel,
  options: {
    readonly canRespond?: boolean;
    readonly dispatch?: ReturnType<typeof vi.fn>;
    readonly driverKind?: string;
    readonly waiting?: readonly Request[];
  } = {},
): Promise<ReturnType<typeof vi.fn>> {
  const dispatch = options.dispatch ?? vi.fn(async () => ({ type: "request.respond" }));
  const snapshot = {
    harnesses: [{ driverKind: options.driverKind ?? "antigravity", id: "h1" }],
    threads: [{ harnessInstanceId: "h1", id: threadId }],
    waitingRequests: (options.waiting ?? []).map((request) => ({ assignments: [], request })),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <RequestCard
        canRespond={options.canRespond ?? true}
        canStartResponse={() => true}
        deploymentId="dep"
        disabledReason={null}
        highlighted={false}
        hostClient={
          {
            dispatch,
            getSnapshot: () => snapshot,
            refresh: async () => undefined,
            rpc: { "browser.sources.inspect": vi.fn() },
            subscribe: () => () => undefined,
          } as never
        }
        mutationGate={createThreadMutationGate(null, () => undefined)}
        onPresent={() => undefined}
        onSettle={() => undefined}
        surface={surface}
      />,
    );
  });
  return dispatch;
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")];
}

function button(label: string): HTMLButtonElement {
  const target = buttons().find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  );
  if (target === undefined) {
    throw new Error(
      `No ${label} among ${buttons()
        .map((item) => item.textContent)
        .join(", ")}`,
    );
  }
  return target;
}

async function press(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
}

/** Past the moment a card ignores a tap for having just arrived. */
function settleArrival(): void {
  vi.useFakeTimers({ now: Date.now() + 1000, toFake: ["Date"] });
}

function text(): string {
  return document.body.textContent ?? "";
}

describe("RequestCard", () => {
  it("answers an approval in one tap, with the system's words", async () => {
    const dispatch = await render(surfaceOf(approval()));
    settleArrival();
    expect(text()).toContain("Run this command?");
    expect(text()).toContain("pnpm test");
    await press("Allow");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestId: approval().id,
        response: { kind: "choice", optionId: "allow" },
        type: "request.respond",
      }),
    );
  });

  it("ignores a tap that lands as the card arrives, so a thumb can't approve by accident", async () => {
    const dispatch = await render(surfaceOf(approval()));
    await press("Allow");
    await press("Don’t Allow");
    expect(dispatch).not.toHaveBeenCalled();
    settleArrival();
    await press("Don’t Allow");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("drops Medium risk, which every ordinary command carries, and says High", async () => {
    await render(surfaceOf(approval()));
    expect(text()).not.toContain("risk");
  });

  it("offers Allow only while the whole request fits, and otherwise the rest of it", async () => {
    native.bodyHeight = 400;
    const dispatch = await render(surfaceOf(approval()));
    settleArrival();
    expect(buttons().some(({ textContent }) => textContent === "Allow")).toBe(false);
    await press("Review");
    expect(native.navigate).toHaveBeenCalledExactlyOnceWith(
      "RequestSheet",
      expect.objectContaining({ full: true, requestId: approval().id, threadId }),
    );
    // Refusing needs no reading, so it stays.
    await press("Don’t Allow");
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("offers no Allow before the card has been measured", async () => {
    native.bodyHeight = null;
    await render(surfaceOf(approval()));
    settleArrival();
    expect(button("Allow").disabled).toBe(true);
  });

  it("asks the system again before allowing something high risk", async () => {
    const dispatch = await render(surfaceOf(approval({}, { risk: "high" })));
    settleArrival();
    await press("Allow…");
    expect(dispatch).not.toHaveBeenCalled();
    expect(native.alert).toHaveBeenCalledOnce();
    const buttonsAsked = native.alert.mock.calls[0]?.[2] as {
      text: string;
      onPress?: () => void;
    }[];
    expect(buttonsAsked.map(({ text }) => text)).toEqual(["Cancel", "Allow"]);
    await act(async () => buttonsAsked[1]?.onPress?.());
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps the rarer answers in the menu", async () => {
    const run = { hint: "allow-for-run", id: "run", label: "Allow for this Run" } as const;
    const dispatch = await render(surfaceOf(approval({}, { options: [allow, run, reject] })));
    settleArrival();
    await press("Allow for this Run");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ response: { kind: "choice", optionId: "run" } }),
    );
  });

  it("doesn't let a menu's answer around reading or being asked again", async () => {
    const run = { hint: "allow-for-run", id: "run", label: "Allow for this Run" } as const;
    native.bodyHeight = 400;
    const clipped = await render(surfaceOf(approval({}, { options: [allow, run, reject] })));
    expect(document.body.textContent).not.toContain("Allow for this Run");
    expect(clipped).not.toHaveBeenCalled();
    for (const root of roots.splice(0)) act(() => root.unmount());
    resetRequestSessionsForTests();
    native.bodyHeight = 60;
    const risky = await render(
      surfaceOf(approval({}, { options: [allow, run, reject], risk: "high" })),
    );
    settleArrival();
    await press("Allow for this Run");
    expect(risky).not.toHaveBeenCalled();
    expect(native.alert).toHaveBeenCalledOnce();
  });

  it("takes a reason only from an engine that passes it on", async () => {
    await render(surfaceOf(approval()), { driverKind: "codex" });
    await press("Don’t Allow and say why…");
    expect(native.navigate).toHaveBeenCalledExactlyOnceWith(
      "RequestSheet",
      expect.objectContaining({ reason: true }),
    );
  });

  it("doesn't offer a reason to an engine that would drop it", async () => {
    await render(surfaceOf(approval()), { driverKind: "grok" });
    expect(text()).not.toContain("say why");
  });

  it("says who answers instead of offering what can't be done", async () => {
    const dispatch = await render(surfaceOf(approval(), "requester"));
    expect(text()).toContain("The person who started this task has to answer this.");
    expect(buttons()).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("holds every answer while the Host is out of reach", async () => {
    await render(surfaceOf(approval()), { canRespond: false });
    settleArrival();
    expect(button("Allow").disabled).toBe(true);
    expect(button("Don’t Allow").disabled).toBe(true);
    expect(text()).not.toContain("Reconnecting");
  });

  it("retries a lost answer under the same key, and says so in today's words", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce({ type: "request.respond" });
    await render(surfaceOf(approval()), { dispatch });
    settleArrival();
    await press("Allow");
    expect(text()).toContain("Could not confirm your answer was sent.");
    await press("Allow");
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0].idempotencyKey).toBe(
      dispatch.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("sends a lone choice as the form it answers", async () => {
    const question = {
      choices: [
        { label: "Tomorrow", value: "tomorrow" },
        { label: "Not yet", value: "later" },
      ],
      id: "when",
      multiSelect: false,
      prompt: "Post it today?",
      secret: false,
    };
    const request = approval({
      kind: "harness.input",
      payload: { kind: "harness.input" },
      presentation: { fields: [question], kind: "form", title: "A question" },
    });
    const dispatch = await render(surfaceOf(request));
    settleArrival();
    expect(text()).toContain("Post it today?");
    await press("Not yet");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        response: { answers: { when: ["later"] }, kind: "form" },
      }),
    );
  });

  it("keeps a title that explains the question in view", async () => {
    const request = approval({
      kind: "harness.input",
      payload: { kind: "harness.input" },
      presentation: {
        fields: [{ id: "q", multiSelect: false, prompt: "Which branch?", secret: false }],
        kind: "form",
        title: "Choose where to deploy",
      },
    });
    await render(surfaceOf(request));
    expect(text()).toContain("Choose where to deploy");
    expect(text()).toContain("Which branch?");
  });

  it("opens the sheet for an open question no composer is there to take", async () => {
    const request = approval({
      kind: "harness.input",
      payload: { kind: "harness.input" },
      presentation: {
        fields: [{ id: "q", multiSelect: false, prompt: "Which branch?", secret: false }],
        kind: "form",
        title: "A question",
      },
    });
    await render(surfaceOf(request));
    await press("Answer");
    expect(native.navigate).toHaveBeenCalledWith(
      "RequestSheet",
      expect.objectContaining({ requestId: request.id }),
    );
  });

  it("lists what else is waiting, each going to the Thread that asked", async () => {
    const other = approval(
      {
        id: "req_00000000-0000-4000-8000-000000000002",
        originatingThreadId: "thr_00000000-0000-4000-8000-000000000002",
      },
      { title: "Change these files?" },
    );
    await render(surfaceOf(approval()), { waiting: [approval(), other] });
    expect(text()).toContain("1 of 2");
    await press("Change these files?");
    expect(native.navigate).toHaveBeenCalledExactlyOnceWith("Thread", {
      deploymentId: "dep",
      requestId: other.id,
      threadId: other.originatingThreadId,
    });
  });

  it("says nothing about a queue when this is the only one", async () => {
    await render(surfaceOf(approval()), { waiting: [approval()] });
    expect(text()).not.toContain("1 of");
  });

  it("renders an integration's access inline, as its own card", async () => {
    const request = approval({
      kind: "integration.access",
      payload: { kind: "integration.access" },
      presentation: { kind: "external", title: "Connect Gmail" },
    });
    await render(surfaceOf(request));
    expect(text()).toContain("Inline Connect card");
  });
});
