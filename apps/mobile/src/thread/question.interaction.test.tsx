// @vitest-environment happy-dom
import { controlledClientSession } from "@opensteer/client/test-support";

import type { SurfaceModel } from "@opensteer/client/host";
import type { Request, RequestFormField } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadMutationGate } from "./thread-mutation-gate.js";

vi.mock("./password-approval-auth.js", () => ({
  authenticatePasswordApproval: vi.fn(async () => true),
}));
vi.mock(
  "../ui/action-line.js",
  async () => (await import("../../test-support/action-line-mocks.js")).actionLine,
);
vi.mock(
  "../ui/placeholder.js",
  async () => (await import("../../test-support/action-line-mocks.js")).placeholder,
);
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Medium: "medium" },
  NotificationFeedbackType: { Error: "error", Success: "success" },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn(async () => undefined) },
  ActivityIndicator: () => <span>Spinner</span>,
  Platform: { OS: "ios", Version: "26" },
  Pressable: (props: {
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button
      aria-checked={props.accessibilityState?.checked}
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={props.onPress}
      role={props.accessibilityRole}
    >
      {typeof props.children === "function" ? props.children({ pressed: false }) : props.children}
    </button>
  ),
  ScrollView: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  TextInput: (props: {
    accessibilityLabel?: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
    placeholder?: string;
    value: string;
  }) => (
    <textarea
      aria-label={props.accessibilityLabel}
      disabled={props.editable === false}
      onChange={(event) => props.onChangeText(event.target.value)}
      placeholder={props.placeholder}
      value={props.value}
    />
  ),
  useWindowDimensions: () => ({ fontScale: 1, height: 800, width: 390 }),
  View: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_reason: unknown, fallback: string) => fallback,
}));
vi.mock("../ui/ai-sharing.js", () => import("../../test-support/ai-sharing.js"));
vi.mock("../navigation-ref.js", () => ({ pushSubagent: vi.fn() }));
vi.mock("../ui/primitives.js", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("./asker-byline.js", () => ({ AskerByline: () => null, useRequestAsker: () => null }));
vi.mock("./request-card.js", () => ({ arrivalGuardMs: 450, WaitingMenu: () => null }));
vi.mock("../ui/composer-action.js", () => ({
  ComposerAction: (props: {
    disabled: boolean;
    kind: string;
    label: string;
    onPress: () => void;
  }) => (
    <button
      aria-label={props.label}
      data-kind={props.kind}
      disabled={props.disabled}
      onClick={props.onPress}
    />
  ),
}));
vi.mock("./composer-bar.js", () => ({
  ComposerBar: (props: { action: ReactNode; field: ReactNode }) => (
    <div>
      {props.field}
      {props.action}
    </div>
  ),
  composerLaneHeight: 44,
}));

const { QuestionRequestCard } = await import("./question-card.js");
const { AnswerBar } = await import("./answer-bar.js");
const { resetRequestSessionsForTests } = await import("./request-session.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  resetRequestSessionsForTests();
  vi.useRealTimers();
});

const refund: RequestFormField = {
  choices: [
    { description: "Email Northwind now", label: "Send the refund request", value: "send" },
    { label: "Leave it for now", value: "leave" },
  ],
  custom: true,
  id: "refund",
  multiSelect: false,
  prompt: "What should I do about the duplicate charge?",
  secret: false,
};
const backends: RequestFormField = {
  choices: [
    { label: "Local directory", value: "local" },
    { label: "S3", value: "s3" },
    { label: "GCS", value: "gcs" },
  ],
  custom: true,
  id: "backends",
  multiSelect: true,
  prompt: "Which backends?",
  secret: false,
};
const notify: RequestFormField = {
  custom: false,
  id: "notify",
  multiSelect: false,
  prompt: "Who should hear about a failure?",
  secret: false,
};

function asking(
  fields: readonly RequestFormField[],
  kind: "harness.input" | "person.question" = "harness.input",
): SurfaceModel {
  const request = {
    id: "req_00000000-0000-4000-8000-000000000001",
    kind,
    mode: kind === "person.question" ? "durable" : "live",
    originatingThreadId: "thr_00000000-0000-4000-8000-000000000001",
    payload: { kind },
    presentation: { fields, kind: "form", title: "A question" },
    requestedBy: "usr_00000000-0000-4000-8000-000000000001",
    requiredActor: "requester",
    status: "pending",
  } as unknown as Request;
  return { denied: null, queued: 0, queuedTitle: null, request, textRole: "answer" };
}

/** The card above the composer, as the Thread draws them; or the card alone where no composer is. */
async function render(
  surface: SurfaceModel,
  options: { readonly composer?: boolean; readonly onStop?: () => void } = {},
): Promise<ReturnType<typeof vi.fn>> {
  vi.useFakeTimers({ toFake: ["Date"] });
  const dispatch = vi.fn(async () => ({ type: "request.respond" }));
  const hostClient = {
    connection: controlledClientSession().connection,
    dispatch,
    getSnapshot: () => ({ user: { id: "usr_00000000-0000-4000-8000-000000000001" } }),
    subscribe: () => () => undefined,
  } as never;
  const gate = createThreadMutationGate(null, () => undefined);
  const shared = { canRespond: true, canStartResponse: () => true, hostClient, surface };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const composer = options.composer ?? true;
  await act(async () => {
    root.render(
      <>
        <QuestionRequestCard
          {...shared}
          composer={composer ? "answer" : null}
          deploymentId="dep"
          disabledReason={null}
          highlighted={false}
          mutationGate={gate}
        />
        {composer ? (
          <AnswerBar
            {...shared}
            gate={gate}
            onStop={options.onStop ?? null}
            stopBusy={false}
            stopLabel="Stop this run"
          />
        ) : null}
      </>,
    );
  });
  // Past the moment a card ignores taps for, having just arrived under a thumb.
  vi.setSystemTime(Date.now() + 1_000);
  return dispatch;
}

function control(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  if (found === undefined) throw new Error(`No control named ${label}`);
  return found;
}

const checked = (label: string): boolean =>
  [...document.querySelectorAll("button")]
    .find((item) => item.getAttribute("aria-label")?.startsWith(label))
    ?.getAttribute("aria-checked") === "true";

async function tap(label: string): Promise<void> {
  const target = [...document.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label")?.startsWith(label) === true || item.textContent === label,
  );
  if (target === undefined) throw new Error(`No control named ${label}`);
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

async function type(words: string, field = "textarea"): Promise<void> {
  const input = document.querySelector<HTMLTextAreaElement>(field)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      words,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const answered = (answers: Record<string, string[]>) =>
  expect.objectContaining({
    requestId: "req_00000000-0000-4000-8000-000000000001",
    response: { answers, kind: "form" },
    type: "request.respond",
  });

describe("answering a question", () => {
  it("answers a single question with one tap", async () => {
    const dispatch = await render(asking([refund]));
    expect(document.querySelector("textarea")?.placeholder).toBe("Type your own answer…");
    await tap("Leave it for now");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(answered({ refund: ["leave"] }));
  });

  it("ignores a tap that lands as the card arrives", async () => {
    const dispatch = await render(asking([refund]));
    vi.setSystemTime(Date.now() - 1_000);
    await tap("Leave it for now");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("sends typed words instead of the options chosen, and unmarks them", async () => {
    const dispatch = await render(asking([backends]));
    await tap("S3");
    expect(checked("S3")).toBe(true);
    await type("Only the local verifier");
    expect(checked("S3")).toBe(false);
    await tap("Answer");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      answered({ backends: ["Only the local verifier"] }),
    );
  });

  it("toggles several options, in the order offered, and sends them with Answer", async () => {
    const dispatch = await render(asking([backends]));
    expect(control("Answer").disabled).toBe(true);
    await tap("GCS");
    await tap("S3");
    await tap("Local directory");
    await tap("Local directory");
    expect(dispatch).not.toHaveBeenCalled();
    await tap("Answer");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(answered({ backends: ["s3", "gcs"] }));
  });

  it("steps through several questions and sends them once, together", async () => {
    const dispatch = await render(asking([refund, backends, notify]));
    expect(document.body.textContent).toContain("Question 1 of 3");
    await tap("Send the refund request");
    expect(document.body.textContent).toContain("Question 2 of 3");
    await tap("S3");
    expect(control("Next").getAttribute("data-kind")).toBe("next");
    await tap("Next");
    expect(document.body.textContent).toContain("Question 3 of 3");
    expect(document.querySelector("textarea")?.placeholder).toBe("Type your answer…");
    await type("The release channel");
    await tap("Previous question");
    expect(checked("S3")).toBe(true);
    await tap("Next question");
    await tap("Answer");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      answered({ backends: ["s3"], notify: ["The release channel"], refund: ["send"] }),
    );
  });

  it("retries an answer whose reply was lost under the same key, and says so", async () => {
    const dispatch = await render(asking([backends]));
    dispatch.mockRejectedValueOnce(new Error("socket closed"));
    await tap("S3");
    await tap("Answer");
    expect(document.body.textContent).toContain("Couldn't confirm your answer sent.");
    await tap("Answer");
    expect(dispatch).toHaveBeenCalledTimes(2);
    const [first, second] = dispatch.mock.calls.map(
      ([command]) => (command as { idempotencyKey: string }).idempotencyKey,
    );
    expect(second).toBe(first);
  });

  it("offers Stop in the send place until there's an answer", async () => {
    const stop = vi.fn();
    await render(asking([backends]), { onStop: stop });
    await tap("Stop this run");
    expect(stop).toHaveBeenCalledOnce();
    await type("   ");
    expect(control("Stop this run")).toBeDefined();
    await tap("S3");
    expect(() => control("Stop this run")).toThrow();
    expect(control("Answer").disabled).toBe(false);
  });

  it("lets ask_person's question be dismissed, and not an engine's", async () => {
    const dispatch = await render(asking([refund], "person.question"));
    await tap("Dismiss");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      }),
    );
    for (const root of roots.splice(0)) act(() => root.unmount());
    resetRequestSessionsForTests();
    await render(asking([refund]));
    expect(() => control("Dismiss")).toThrow();
  });

  it("takes a typed answer in the card where no composer stands", async () => {
    const dispatch = await render(asking([notify]), { composer: false });
    await type("Maya");
    await tap("Answer");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(answered({ notify: ["Maya"] }));
  });
});
