// @vitest-environment happy-dom

import type { SurfaceModel } from "@opensteer/client/host";
import type { Request } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadMutationGate } from "./thread-mutation-gate.js";

vi.mock("./password-approval-auth.js", () => ({
  authenticatePasswordApproval: vi.fn(async () => true),
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Medium: "medium" },
  NotificationFeedbackType: { Error: "error" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  Platform: { OS: "ios", Version: "26" },
  StyleSheet: { create: (styles: object) => styles },
  TextInput: (props: {
    accessibilityLabel?: string;
    onChangeText: (value: string) => void;
    value: string;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      onChange={(event) => props.onChangeText(event.target.value)}
      value={props.value}
    />
  ),
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_reason: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/ai-sharing.js", () => import("../../test-support/ai-sharing.js"));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../ui/composer-action.js", () => ({
  ComposerAction: (props: { disabled: boolean; label: string; onPress: () => void }) => (
    <button disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("./composer-bar.js", () => ({
  ComposerBar: (props: { action: ReactNode; caption: ReactNode; field: ReactNode }) => (
    <div>
      {props.caption}
      {props.field}
      {props.action}
    </div>
  ),
  composerLaneHeight: 44,
}));

const { AnswerBar } = await import("./answer-bar.js");
const { resetRequestSessionsForTests } = await import("./request-session.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  resetRequestSessionsForTests();
});

const request = {
  id: "req_00000000-0000-4000-8000-000000000001",
  kind: "harness.input",
  mode: "live",
  originatingThreadId: "thr_00000000-0000-4000-8000-000000000001",
  payload: { kind: "harness.input" },
  presentation: {
    fields: [{ id: "subject", multiSelect: false, prompt: "Subject line?", secret: false }],
    kind: "form",
    title: "A question",
  },
  status: "pending",
} as unknown as Request;
const surface: SurfaceModel = {
  denied: null,
  queued: 0,
  queuedTitle: null,
  request,
  textRole: "hidden",
};

async function render(options: {
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly onStop: (() => void) | null;
}): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <AnswerBar
        canRespond
        canStartResponse={() => true}
        fieldId="subject"
        gate={createThreadMutationGate(null, () => undefined)}
        hostClient={
          {
            dispatch: options.dispatch,
            getSnapshot: () => ({}),
            subscribe: () => () => undefined,
          } as never
        }
        onStop={options.onStop}
        question="Subject line?"
        stopBusy={false}
        stopLabel="Stop this run"
        surface={surface}
      />,
    );
  });
}

async function type(value: string): Promise<void> {
  const field = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((item) => item.textContent === label);
}

describe("AnswerBar", () => {
  it("sends what's typed as the question's answer", async () => {
    const dispatch = vi.fn(async () => ({ type: "request.respond" }));
    await render({ dispatch, onStop: null });
    expect(document.body.textContent).toContain("Subject line?");
    expect(button("Send answer")?.disabled).toBe(true);
    await type("Beta is here");
    await act(async () => {
      button("Send answer")?.click();
      await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestId: request.id,
        response: { answers: { subject: ["Beta is here"] }, kind: "form" },
        type: "request.respond",
      }),
    );
  });

  it("won't send whitespace, and offers Stop until there's an answer", async () => {
    const stop = vi.fn();
    await render({ dispatch: vi.fn(), onStop: stop });
    await type("   ");
    expect(button("Send answer")).toBeUndefined();
    await act(async () => button("Stop this run")?.click());
    expect(stop).toHaveBeenCalledOnce();
    await type("Beta");
    expect(button("Stop this run")).toBeUndefined();
    expect(button("Send answer")?.disabled).toBe(false);
  });
});
