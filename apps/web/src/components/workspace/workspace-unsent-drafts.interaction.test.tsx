// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi } from "vitest";
import { HostClientRequestError } from "@opensteer/client/host";

import {
  click,
  client,
  deferred,
  element,
  firstTaskId,
  goTo,
  history,
  mount,
  root,
  settle,
  setRoot,
  write,
} from "./workspace.interaction.test-support.js";

const field = () => element<HTMLTextAreaElement>("[data-composer-input]");
const openTask = (threadId: string) =>
  click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
const newTask = () => click(element('[aria-label="New task"]'));
const place = () => history.at(-1)!;
const back = async () => {
  await act(async () => {
    await goTo?.(-1);
  });
  await settle();
};
const savedDrafts = () => Object.keys(localStorage).filter((key) => key.includes("composer-draft"));
/** Two tasks the sidebar lists, the first holding an unsent reply. */
async function replyLeftIn(text: string) {
  await mount("/");
  await settle();
  const [first, second] = [...document.querySelectorAll<HTMLElement>(".side-task[data-thread-id]")]
    .map((row) => row.dataset.threadId!)
    .slice(0, 2);
  await openTask(first!);
  await settle();
  await write(field(), text);
  return { first: first!, second: second! };
}
async function discardFromRow(threadId: string) {
  await act(async () => {
    element(`.side-task[data-thread-id="${threadId}"] .side-task__main`).dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ContextMenu" }),
    );
  });
  const discard = [...document.querySelectorAll<HTMLButtonElement>(".picker__row")].find(
    (row) => row.textContent === "Discard draft",
  );
  if (!discard) throw new Error("The row offers no Discard draft.");
  await click(discard);
  await settle();
}

async function remount(path: string) {
  await act(async () => root?.unmount());
  setRoot(null);
  document.body.replaceChildren();
  await mount(path);
}

async function attach(name: string) {
  const input = element<HTMLInputElement>('input[type="file"]');
  const file = new File(["contents"], name, { type: "text/plain" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("what a person has written and not sent", () => {
  it("keeps a draft through a reload, on the same address", async () => {
    await mount("/");
    await settle();
    await write(field(), "Survive a reload");
    const { path, search } = place();
    await settle();

    await remount(`${path}${search}`);
    await settle();

    expect(field().value).toBe("Survive a reload");
  });

  it("starts a blank task beside an unfinished one, and each keeps its own words", async () => {
    await mount("/");
    await settle();
    await write(field(), "The first task");
    const first = place();
    await newTask();
    await settle();
    expect(field().value).toBe("");
    await write(field(), "The second task");
    const second = place();
    expect(second.search).not.toBe(first.search);

    await remount(`${first.path}${first.search}`);
    await settle();
    expect(field().value).toBe("The first task");
    await remount(`${second.path}${second.search}`);
    await settle();
    expect(field().value).toBe("The second task");
  });

  it("removes the draft once it starts a task", async () => {
    await mount("/");
    await settle();
    await write(field(), "Start this one");
    await click(element(".composer__send"));
    await settle(100);

    expect(place().path).toMatch(/^\/tasks\//u);
    expect(savedDrafts()).toEqual([]);
    await newTask();
    await settle();
    expect(field().value).toBe("");
  });

  it("gives each conversation its own reply, and marks the ones waiting", async () => {
    const { first, second } = await replyLeftIn("A reply to the first");
    await openTask(second);
    await settle();
    expect(field().value).toBe("");
    expect(
      element(`.side-task[data-thread-id="${first}"]`).querySelector(".side-unsent"),
    ).not.toBeNull();

    await openTask(first);
    await settle();
    expect(field().value).toBe("A reply to the first");
    expect(
      element(`.side-task[data-thread-id="${first}"]`).querySelector(".side-unsent"),
    ).toBeNull();
  });

  it("discards a reply from its row and takes the discard back", async () => {
    const { first, second } = await replyLeftIn("Maybe not");
    await openTask(second);
    await settle();

    await discardFromRow(first);
    expect(
      element(`.side-task[data-thread-id="${first}"]`).querySelector(".side-unsent"),
    ).toBeNull();

    await click(element(".toast__action"));
    await settle();
    await openTask(first);
    await settle();
    expect(field().value).toBe("Maybe not");
  });

  it("returns a task refused after leaving to its own draft, and says why there", async () => {
    await mount("/");
    await settle();
    const refused = deferred<void>();
    vi.spyOn(client, "createThread").mockImplementation(async () => {
      await refused.promise;
      throw new HostClientRequestError({
        code: "forbidden",
        message: "That is not allowed here.",
        status: 403,
      });
    });
    await write(field(), "Do the thing");
    await click(element(".composer__send"));
    await openTask(firstTaskId());
    await settle();

    await act(async () => {
      refused.resolve();
    });
    await settle(50);

    await back();
    expect(field().value).toBe("Do the thing");
    expect(element(".composer__error").textContent).toContain("could not be started");
  });

  it("hands a refused task to the draft reopened before the answer came", async () => {
    await mount("/");
    await settle();
    const refused = deferred<void>();
    vi.spyOn(client, "createThread").mockImplementation(async () => {
      await refused.promise;
      throw new HostClientRequestError({ code: "forbidden", message: "No.", status: 403 });
    });
    await write(field(), "Do the thing");
    await click(element(".composer__send"));
    await openTask(firstTaskId());
    await settle();
    await back();
    await write(field(), "Written meanwhile");

    await act(async () => {
      refused.resolve();
    });
    await settle(50);
    expect(field().value).toBe("Do the thing\nWritten meanwhile");

    await write(field(), "Do the thing\nWritten meanwhile, and more");
    const { path, search } = place();
    await remount(`${path}${search}`);
    await settle();
    expect(field().value).toBe("Do the thing\nWritten meanwhile, and more");
  });

  it("finishes an upload after leaving, and the file is there on return", async () => {
    await mount("/", { latencyMs: 20 });
    await settle();
    await attach("notes.txt");
    await openTask(firstTaskId());
    await settle(120);

    await back();
    expect(document.querySelector(".composer__send")?.hasAttribute("disabled")).toBe(false);
    expect(document.body.textContent).toContain("notes.txt");
  });

  it("asks for a file again when a reload lost it mid-upload", async () => {
    await mount("/");
    await settle();
    const search = () => place().search;
    await write(field(), "With a file");
    const key = Object.keys(localStorage).find((name) => name.includes("composer-draft"))!;
    const saved = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
    localStorage.setItem(
      key,
      JSON.stringify({
        ...saved,
        files: [{ mediaType: "text/plain", name: "lost.txt", part: null, sizeBytes: 4 }],
      }),
    );
    await remount(`/${search()}`);
    await settle();

    expect(field().value).toBe("With a file");
    expect(document.body.textContent).toContain("added again");
    expect(document.querySelector(".composer__send")?.hasAttribute("disabled")).toBe(true);
  });

  it("survives React's double effects without losing or doubling a draft", async () => {
    await mount("/", { strict: true });
    await settle();
    await write(field(), "Strict words");
    await openTask(firstTaskId());
    await settle();
    await back();
    expect(field().value).toBe("Strict words");
    expect(savedDrafts()).toHaveLength(1);
  });

  it("goes back to a draft from the browser's Back button", async () => {
    await mount("/");
    await settle();
    await write(field(), "Back to me");
    await openTask(firstTaskId());
    await settle();
    await back();
    expect(field().value).toBe("Back to me");
  });
});
