// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  groupTranscriptEntries,
  liveTurn,
  type RunEntry,
  type ToolEntry,
} from "@opensteer/client/host";

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    Version: "26",
    select: (options: { default?: unknown }) => options.default,
  },
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 0.5 },
  View: (props: { accessibilityLabel?: string; children?: ReactNode }) => (
    <div aria-label={props.accessibilityLabel}>{props.children}</div>
  ),
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  StatusDot: (props: { live?: boolean; tone: string }) => (
    <i data-live={String(props.live === true)} data-tone={props.tone} />
  ),
  monoFontFamily: "Menlo",
}));
const { LiveLine } = await import("./live-line.js");

/*
 * The mobile line above a task's composer draws the shared words. What can go
 * wrong: it stops ticking, or ticks and escalates while out of touch.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const start = Date.parse("2026-08-16T10:00:00.000Z");
const at = (seconds: number) => new Date(start + seconds * 1_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start + 12_000);
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

const run: RunEntry = {
  createdAt: at(0),
  error: null,
  id: "run:run-a",
  kind: "run",
  replyMessageId: null,
  runId: "run-a",
  status: "running",
};

const ls: ToolEntry = {
  arguments: { command: "ls" },
  callId: "call-ls",
  completedAt: at(4),
  createdAt: at(1),
  id: "tool:run-a:call-ls",
  integration: null,
  isError: false,
  kind: "tool",
  output: { text: "ok" },
  runId: "run-a",
  state: "done",
  streamText: "",
  tool: { name: "shell", namespace: "codex" },
};

function mount(connected: boolean) {
  const live = liveTurn(groupTranscriptEntries([run, ls]), {
    id: "run-a",
    status: "running",
    createdAt: at(0),
  })!;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<LiveLine connected={connected} live={live} />));
  return container;
}

it("names the last step and keeps its times moving, then turns quiet", () => {
  const container = mount(true);
  expect(container.textContent).toBe("Ran a commandlsupdated 8s ago · 12s");
  expect(container.querySelector("i")?.dataset).toMatchObject({ live: "true", tone: "ember" });
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  expect(container.textContent).toContain("updated 9s ago · 13s");
  act(() => {
    vi.advanceTimersByTime(2 * 60_000);
  });
  expect(container.querySelector("i")?.dataset).toMatchObject({ live: "false", tone: "amber" });
  expect(container.textContent).toContain("Quiet for 2m 9s");
});

it("holds still out of touch with the Host", () => {
  const container = mount(false);
  const before = container.textContent;
  act(() => {
    vi.advanceTimersByTime(10 * 60_000);
  });
  expect(container.textContent).toBe(before);
  expect(container.querySelector("i")?.dataset).toMatchObject({ live: "false", tone: "muted" });
});
