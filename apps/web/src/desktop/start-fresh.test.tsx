// @vitest-environment happy-dom

import type { DesktopPersonalOldDataState } from "@opensteer/protocol/desktop";
import { createId } from "@opensteer/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useStartFresh, type StartFreshState } from "./start-fresh.js";

/*
 * How Start fresh could hurt: the old data is read, or a reset offered, while
 * the Personal Host does not need repair; a reset starts twice; a failed
 * reset leaves the person on a spinner instead of saying why and offering it
 * again; an unreadable answer is taken for old data.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

const oldData: DesktopPersonalOldDataState = {
  kind: "old-data",
  deploymentId: createId("deployment"),
  entries: ["slot", "browser-profiles", "catalog", "native-auth", "manifest"].map((name) => ({
    source: `/data/${name}`,
    destination: `/data/${name}.set-aside-1`,
  })),
};

async function mount(
  reset: {
    oldData: () => Promise<DesktopPersonalOldDataState | null>;
    startFresh: () => Promise<void>;
  },
  repairRequired: boolean,
) {
  let current: { state: StartFreshState; startFresh: () => void } | null = null;
  function Probe({ repair }: { readonly repair: boolean }) {
    current = useStartFresh({ personalDataReset: reset }, repair);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => root.render(<Probe repair={repairRequired} />));
  return {
    rerender: (repair: boolean) => act(async () => root.render(<Probe repair={repair} />)),
    get: () => current!,
  };
}

it("asks about old data only while the Personal Host needs repair", async () => {
  const reset = { oldData: vi.fn(async () => oldData), startFresh: vi.fn(async () => undefined) };
  const view = await mount(reset, false);
  expect(view.get().state).toEqual({ phase: "idle" });
  expect(reset.oldData).not.toHaveBeenCalled();

  await view.rerender(true);
  expect(view.get().state).toEqual({ phase: "offer", data: oldData, error: null });
  expect(reset.oldData).toHaveBeenCalledTimes(1);
});

it("starts fresh once, and offers it again with the reason when it fails", async () => {
  const attempt = Promise.withResolvers<void>();
  const reset = { oldData: vi.fn(async () => oldData), startFresh: vi.fn(() => attempt.promise) };
  const view = await mount(reset, true);
  await act(async () => {
    view.get().startFresh();
  });
  expect(view.get().state).toEqual({ phase: "starting", data: oldData });
  await act(async () => view.get().startFresh());
  expect(reset.startFresh).toHaveBeenCalledTimes(1);

  await act(async () => attempt.reject(new Error("The browser profiles are in use.")));
  expect(view.get().state).toEqual({
    phase: "offer",
    data: oldData,
    error: "The browser profiles are in use.",
  });
  await act(async () => view.get().startFresh());
  expect(reset.startFresh).toHaveBeenCalledTimes(2);
});

it("offers nothing when there is no old data, or it can't be read", async () => {
  const none = await mount(
    { oldData: async () => null, startFresh: vi.fn(async () => undefined) },
    true,
  );
  expect(none.get().state).toEqual({ phase: "none" });
  const unreadable = await mount(
    { oldData: async () => Promise.reject(new Error("closed")), startFresh: vi.fn() },
    true,
  );
  expect(unreadable.get().state).toEqual({ phase: "none" });
});
