// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  groupTranscriptEntries,
  liveTurn,
  type RunEntry,
  type ToolEntry,
  type TranscriptEntry,
} from "@opensteer/client/host";
import { LiveLine } from "./live-line.js";

/*
 * The line above a task's composer. What can go wrong: it stops ticking, so a
 * busy turn reads as frozen; it ticks out of touch with the Host and calls the
 * silence quiet.
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
  startedAt: at(0),
  error: null,
  id: "run:run-a",
  kind: "run",
  replyMessageId: null,
  runId: "run-a",
  status: "running",
};

function command(text: string, overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    arguments: { command: text },
    callId: `call-${text}`,
    completedAt: at(4),
    createdAt: at(1),
    id: `tool:run-a:${text}`,
    integration: null,
    isError: false,
    kind: "tool",
    output: { text: "ok" },
    runId: "run-a",
    state: "done",
    streamText: "",
    tool: { name: "shell", namespace: "codex" },
    ...overrides,
  };
}

function liveRun(entries: readonly TranscriptEntry[]) {
  const live = liveTurn(groupTranscriptEntries(entries), {
    id: "run-a",
    status: "running",
    createdAt: at(0),
  });
  if (live === null) throw new Error("No turn under way");
  return live;
}

function mount(entries: readonly TranscriptEntry[], connected = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const draw = (next: readonly TranscriptEntry[]) =>
    act(() => root.render(<LiveLine connected={connected} live={liveRun(next)} />));
  draw(entries);
  return Object.assign(container, { draw });
}

const line = (container: HTMLElement) => container.querySelector(".live-line")!;
const meta = (container: HTMLElement) => container.querySelector(".live-line__meta")?.textContent;

describe("LiveLine", () => {
  it("names the last step between steps and keeps its times moving", () => {
    const container = mount([run, command("pnpm test")]);
    expect(line(container).className).toBe("live-line live-line--working");
    expect(container.querySelector(".live-line__label")?.textContent).toBe("Ran a command");
    expect(container.querySelector(".live-line__label--moving")).toBeNull();
    expect(container.querySelector(".live-line__detail--code")?.textContent).toBe("pnpm test");
    expect(meta(container)).toBe("updated 8s ago · 12s");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(meta(container)).toBe("updated 9s ago · 13s");
  });

  it("moves its words only while a step is running", () => {
    const container = mount([
      run,
      command("pnpm build", { completedAt: null, createdAt: at(10), state: "running" }),
    ]);
    expect(container.querySelector(".live-line__label--moving")?.textContent).toBe(
      "Running a command",
    );
    expect(meta(container)).toBe("running 2s · 12s");
  });

  it("turns quiet once nothing has run for two minutes, and says why", () => {
    const container = mount([run, command("ls")]);
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(line(container).className).toBe("live-line live-line--quiet");
    expect(container.querySelector(".live-line__label")?.textContent).toBe("Quiet for 2m 8s");
    expect(container.querySelector(".live-line__note")?.textContent).toBe(
      "Nothing is running. The agent may be thinking without reporting.",
    );
  });

  it("counts a change it sees as activity, though the entry carries no new time", () => {
    // A thought carries only its start: finishing after three minutes is still news.
    const thought = {
      completedAt: null,
      createdAt: at(1),
      id: "reasoning:run-a:block-1",
      kind: "reasoning" as const,
      runId: "run-a",
      state: "streaming" as const,
      text: "Checking the feeds",
    };
    const container = mount([run, command("ls"), thought]);
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(line(container).className).toBe("live-line live-line--working");
    container.draw([run, command("ls"), { ...thought, state: "done" }]);
    expect(line(container).className).toBe("live-line live-line--working");
    expect(meta(container)).toBe("updated just now · 3m 12s");
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(line(container).className).toBe("live-line live-line--quiet");
  });

  it("holds still out of touch with the Host", () => {
    const container = mount([run, command("ls")], false);
    expect(line(container).className).toBe("live-line live-line--held");
    const before = meta(container);
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(meta(container)).toBe(before);
    expect(line(container).className).toBe("live-line live-line--held");
  });
});
