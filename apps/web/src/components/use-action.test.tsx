// @vitest-environment happy-dom
import type { ClientConnectionState, ClientSession } from "@opensteer/client/connections";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { localSession, useAction } from "./use-action.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function sessionWith(patch: Partial<ClientConnectionState>): ClientSession {
  const state = { ...localSession.connection.getSnapshot(), ...patch };
  return { connection: { getSnapshot: () => state, subscribe: () => () => {}, retry() {} } };
}

async function mount(session: ClientSession, execute: () => Promise<string>) {
  let latest: ReturnType<typeof useAction<void, string>> | null = null;
  function Probe() {
    latest = useAction<void, string>(session, {
      label: "start this task",
      done: "started",
      happened: "this task started",
      execute,
    });
    return latest.line?.text ?? null;
  }
  const page = document.createElement("div");
  document.body.append(page);
  const root = createRoot(page);
  cleanups.push(() => {
    act(() => root.unmount());
    page.remove();
  });
  // Development's double mount must not leave the action disposed.
  await act(async () =>
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    ),
  );
  return { page, run: () => latest!.run() };
}

it("runs once mounted under StrictMode and confirms the answer", async () => {
  const execute = vi.fn(async () => "thread");
  const { page, run } = await mount(localSession, execute);
  let outcome: unknown;
  await act(async () => {
    outcome = await run();
  });
  expect(execute).toHaveBeenCalledOnce();
  expect(outcome).toEqual({ kind: "confirmed", value: "thread" });
  expect(page.textContent).toBe("");
});

it("says it didn't start beside the control, without sending, when the device is offline", async () => {
  const execute = vi.fn(async () => "thread");
  const { page, run } = await mount(sessionWith({ network: "offline" }), execute);
  await act(async () => {
    await run();
  });
  expect(execute).not.toHaveBeenCalled();
  expect(page.textContent).toBe("Not started. You're offline.");
});
