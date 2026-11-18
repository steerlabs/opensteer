// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Home is a new task's composer, and a task can't start before the computer
 * has answered. A first launch with no connection showed the composer under
 * the pill on iOS while the web showed the gate. A saved view keeps the
 * composer: on a cold offline launch, before any Host client exists, and as
 * the saved list hands over to the live one.
 */

const harness = vi.hoisted(() => ({
  attached: true,
  readyRevision: 0,
  saved: "pending" as "pending" | "saved" | "live",
}));
vi.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 0 }));
vi.mock("@react-navigation/native", () => ({
  StackActions: { push: () => ({}) },
  useNavigation: () => ({ dispatch: () => undefined, isFocused: () => true }),
}));
vi.mock("../ui/composer-editor.js", () => ({ dismissKeyboard: () => undefined }));
vi.mock("../ui/connection-gate.js", () => ({
  Gated: (props: { children: unknown; gate: unknown }) => props.gate ?? props.children,
}));
vi.mock("../ui/screen.js", () => ({ Screen: (props: { children: unknown }) => props.children }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileState: () => ({
    rows: [{ deploymentId: "dep_1", name: "Mac mini", signIn: null }],
    selection: { deploymentId: "dep_1", session: null },
  }),
  useSavedSurface: () =>
    harness.saved === "saved" ? { source: "saved", userId: "usr_1" } : { source: harness.saved },
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => "gate",
  useAttachedHost: () =>
    harness.attached
      ? {
          connection: {
            getSnapshot: () => ({ readyRevision: harness.readyRevision }),
            subscribe: () => () => undefined,
          },
        }
      : null,
}));
vi.mock("./new-task.js", () => ({
  HeldNewTaskPane: () => "held composer",
  NewTaskPane: () => "composer",
}));
vi.mock("./notifications-intro.js", () => ({ useNotificationsIntro: () => undefined }));
vi.mock("../phone-setup/use-phone-setup.js", () => ({ usePhoneSetup: () => false }));

const { HomeScreen } = await import("./home.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function home(): string {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const route = { key: "home", name: "Home", params: { deploymentId: "dep_1" } } as never;
  act(() => root?.render(<HomeScreen route={route} />));
  return node.textContent ?? "";
}

describe("Home", () => {
  it.each([
    { attached: true, readyRevision: 0, saved: "pending", shows: "gate" },
    { attached: true, readyRevision: 0, saved: "saved", shows: "composer" },
    { attached: true, readyRevision: 0, saved: "live", shows: "composer" },
    { attached: true, readyRevision: 1, saved: "pending", shows: "composer" },
    { attached: false, readyRevision: 0, saved: "saved", shows: "held composer" },
    { attached: false, readyRevision: 0, saved: "pending", shows: "gate" },
  ] as const)(
    "shows the $shows when attached is $attached, ever ready is $readyRevision and the saved view is $saved",
    ({ attached, readyRevision, saved, shows }) => {
      harness.attached = attached;
      harness.readyRevision = readyRevision;
      harness.saved = saved;
      expect(home()).toBe(shows);
    },
  );
});
