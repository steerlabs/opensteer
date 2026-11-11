// @vitest-environment happy-dom

import { syncingPlaceholderDelayMs, useSyncingPlaceholder } from "@opensteer/client/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
const shown: boolean[] = [];

function Probe({ rows, syncing }: { readonly rows: number; readonly syncing: boolean }) {
  shown.push(useSyncingPlaceholder(syncing, rows));
  return null;
}

function render(syncing: boolean, rows: number) {
  act(() => root!.render(<Probe rows={rows} syncing={syncing} />));
}

beforeEach(() => {
  vi.useFakeTimers();
  shown.length = 0;
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe("useSyncingPlaceholder", () => {
  it("shows a syncing list's skeleton only once it has had no rows for the delay", () => {
    render(true, 0);
    act(() => vi.advanceTimersByTime(syncingPlaceholderDelayMs - 1));
    expect(shown.at(-1)).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(shown.at(-1)).toBe(true);
    // Rows arriving take the skeleton away at once, as does the sync ending.
    render(true, 3);
    expect(shown.at(-1)).toBe(false);
    render(true, 0);
    expect(shown.at(-1)).toBe(false);
    render(false, 0);
    act(() => vi.advanceTimersByTime(syncingPlaceholderDelayMs * 2));
    expect(shown.at(-1)).toBe(false);
  });

  it("never covers rows that are there, and a quick sync never flashes it", () => {
    render(true, 5);
    act(() => vi.advanceTimersByTime(syncingPlaceholderDelayMs * 2));
    expect(shown.every((value) => !value)).toBe(true);
    render(true, 0);
    act(() => vi.advanceTimersByTime(syncingPlaceholderDelayMs - 100));
    render(false, 4);
    act(() => vi.advanceTimersByTime(syncingPlaceholderDelayMs));
    expect(shown.every((value) => !value)).toBe(true);
  });
});
