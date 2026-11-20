import { expect, it, vi } from "vitest";
import { parentedQuitQuestion, quitQuestionParentOptions } from "./quit-question.js";

function fixture(answer: Promise<{ response: number }>) {
  const parent = {
    destroyed: false,
    center: vi.fn(),
    show: vi.fn(),
    isDestroyed() {
      return this.destroyed;
    },
    destroy: vi.fn(function (this: { destroyed: boolean }) {
      this.destroyed = true;
    }),
  };
  const showMessageBox = vi.fn(() => answer);
  const shown = vi.fn();
  const ask = parentedQuitQuestion({
    focus: vi.fn(),
    createParent: () => parent,
    showMessageBox,
    shown,
  });
  return { ask, parent, showMessageBox, shown };
}
const question = { message: "Quit Opensteer?", detail: "Agents can’t use this Mac." };

it("asks as a sheet on its own parent, with the shutdown's signal, and takes the parent away after", async () => {
  const { ask, parent, showMessageBox, shown } = fixture(Promise.resolve({ response: 0 }));
  const signal = new AbortController().signal;
  await expect(ask(question, signal)).resolves.toBe(true);
  expect(showMessageBox).toHaveBeenCalledWith(
    parent,
    expect.objectContaining({ message: question.message, signal, cancelId: 1, defaultId: 1 }),
  );
  expect(shown).toHaveBeenCalledOnce();
  expect(parent.destroy).toHaveBeenCalledOnce();
  expect(quitQuestionParentOptions("Opensteer")).toMatchObject({ show: false, transparent: true });
});

it("treats a question the shutdown dismissed as unanswered, and still removes its parent", async () => {
  const dismissed = Promise.withResolvers<{ response: number }>();
  const { ask, parent } = fixture(dismissed.promise);
  const shutdown = new AbortController();
  const asking = ask(question, shutdown.signal);
  shutdown.abort(new Error("logging out"));
  // Electron answers a dismissed sheet with its cancel button.
  dismissed.resolve({ response: 1 });
  await expect(asking).rejects.toThrow("logging out");
  expect(parent.destroy).toHaveBeenCalledOnce();
});

it("asks nothing once the shutdown began", async () => {
  const { ask, showMessageBox } = fixture(Promise.resolve({ response: 0 }));
  const shutdown = new AbortController();
  shutdown.abort(new Error("already quitting"));
  await expect(ask(question, shutdown.signal)).rejects.toThrow("already quitting");
  expect(showMessageBox).not.toHaveBeenCalled();
});
