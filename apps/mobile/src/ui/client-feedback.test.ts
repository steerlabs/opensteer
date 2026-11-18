import { HostTransportError } from "@opensteer/client/connections";
import { controlledClientSession } from "@opensteer/client/test-support";
import { afterEach, expect, it, vi } from "vitest";
import { notDone, observeScreenAction, screenAction } from "./client-feedback.js";

afterEach(() => {
  vi.useRealTimers();
});

it("says the verb of the latest spec under a key two verbs share", async () => {
  const session = controlledClientSession();
  session.change({ network: "offline", phase: "recovering" });
  const spec = (done: string) => ({ label: "restart the worker", done, execute: async () => {} });
  screenAction(session, "worker:1", spec("reopened"));
  const outcome = await screenAction(session, "worker:1", spec("resumed")).run(undefined);
  expect(outcome).toMatchObject({ kind: "not-sent", issue: { done: "resumed" } });
});

function countedSession() {
  const session = controlledClientSession();
  let live = 0;
  const subscribe = session.connection.subscribe;
  session.connection.subscribe = (listener) => {
    live += 1;
    const unsubscribe = subscribe(listener);
    return () => {
      live -= 1;
      unsubscribe();
    };
  };
  return { session, live: () => live };
}

const lost = () => new HostTransportError("timed-out");

it("lets go of rows that are gone, keeping a running action and one awaiting Check until settled", async () => {
  vi.useFakeTimers();
  const { session, live } = countedSession();
  const quiet = { label: "close this tab", done: "closed", execute: async () => {} };
  const rows = Array.from({ length: 50 }, (_, i) => [
    observeScreenAction(session, `close:${i}`, quiet),
    observeScreenAction(session, `pin:${i}`, quiet),
  ]).flat();
  expect(live()).toBe(100);

  let finish!: () => void;
  const running = observeScreenAction(session, "close:running", {
    ...quiet,
    execute: () => new Promise<void>((resolve) => (finish = resolve)),
  });
  void running.action.run(undefined);
  const checkable = {
    ...quiet,
    execute: () => Promise.reject(lost()),
    reconcile: async () => notDone("closed"),
  };
  const lostAnswer = observeScreenAction(session, "close:lost", checkable);
  expect(await lostAnswer.action.run(undefined)).toMatchObject({ kind: "unconfirmed" });

  for (const row of [...rows, running, lostAnswer]) row.release();
  await vi.runAllTimersAsync();
  expect(live()).toBe(2);
  expect(screenAction(session, "close:lost", checkable)).toBe(lostAnswer.action);

  finish();
  await vi.runAllTimersAsync();
  expect(live()).toBe(1);

  await lostAnswer.action.reconcile();
  await vi.runAllTimersAsync();
  expect(live()).toBe(0);
  expect(screenAction(session, "close:lost", checkable)).not.toBe(lostAnswer.action);
});

it("keeps at most 32 unwatched outcomes awaiting Check, dropping the oldest", async () => {
  vi.useFakeTimers();
  const { session, live } = countedSession();
  const spec = {
    label: "close this tab",
    execute: () => Promise.reject(lost()),
    reconcile: async () => null,
  };
  const actions = [];
  for (let i = 0; i < 40; i += 1) {
    const row = observeScreenAction(session, `close:${i}`, spec);
    await row.action.run(undefined);
    row.release();
    actions.push(row.action);
    await vi.runAllTimersAsync();
  }
  expect(live()).toBe(32);
  expect(screenAction(session, "close:39", spec)).toBe(actions[39]);
  expect(screenAction(session, "close:0", spec)).not.toBe(actions[0]);
});
