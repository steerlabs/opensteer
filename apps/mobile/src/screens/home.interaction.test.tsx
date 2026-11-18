// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Home is a new task's composer, and a task can't start before the computer
 * has answered. A first launch with no connection showed the composer under
 * the pill on iOS while the web showed the gate.
 */

const harness = vi.hoisted(() => ({
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
  useSavedSurface: () => ({ source: harness.saved }),
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => "gate",
  useAttachedHost: () => ({
    connection: {
      getSnapshot: () => ({ readyRevision: harness.readyRevision }),
      subscribe: () => () => undefined,
    },
  }),
}));
vi.mock("./new-task.js", () => ({ NewTaskPane: () => "composer" }));
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
    { readyRevision: 0, saved: "pending", shows: "gate" },
    { readyRevision: 0, saved: "saved", shows: "composer" },
    { readyRevision: 1, saved: "pending", shows: "composer" },
  ] as const)(
    "shows the $shows when ever ready is $readyRevision and the saved view is $saved",
    ({ readyRevision, saved, shows }) => {
      harness.readyRevision = readyRevision;
      harness.saved = saved;
      expect(home()).toBe(shows);
    },
  );
});
