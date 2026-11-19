import { composerDrafts } from "../composer-drafts.js";
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
  setRoot,
  until,
  write,
} from "./workspace.interaction.test-support.js";
import { composerText } from "../composer-editor.test-support.js";

const field = () => element<HTMLElement>("[data-composer-input]");
const place = () => history.at(-1)!;
/** The composer of the page the address names is drawn. */
const shown = (what: string, path: (path: string) => boolean) =>
  until(`${what} never opened`, () => {
    expect(path(place().path)).toBe(true);
    return field();
  });
const openTask = async (threadId: string) => {
  await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
  await shown("The task", (path) => path === `/tasks/${threadId}`);
};
const newTask = async () => {
  await click(element('[aria-label="New task"]'));
  await shown("New task", (path) => path === "/");
};
const back = async () => {
  const before = history.length;
  await act(async () => {
    await goTo?.(-1);
  });
  await until("Back never moved", () => expect(history.length).toBeGreaterThan(before));
  await shown("The page before", () => true);
};
const savedDrafts = () => Object.keys(localStorage).filter((key) => key.includes("composer-draft"));
/** The drafts store has saved these words: what a reload reads. */
const saved = (text: string) =>
  until(`"${text}" was never saved`, () =>
    expect(savedDrafts().map((key) => composerDrafts.read(key)?.text)).toContain(text),
  );
const mounted = async (
  path: Parameters<typeof mount>[0],
  options?: Parameters<typeof mount>[1],
) => {
  await mount(path, options);
  await until("The composer never appeared", field);
};
/** Two tasks the sidebar lists, the first holding an unsent reply. */
async function replyLeftIn(text: string) {
  await mounted("/");
  const [first, second] = await until("The sidebar never listed two tasks", () => {
    const rows = [...document.querySelectorAll<HTMLElement>(".side-task[data-thread-id]")].map(
      (row) => row.dataset.threadId!,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    return rows.slice(0, 2);
  });
  await openTask(first!);
  await write(field(), text);
  await saved(text);
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
  await until("The discard never offered to take it back", () => element(".toast__action"));
}

async function remount(path: string, sameHost = false) {
  await act(async () => root?.unmount());
  setRoot(null);
  document.body.replaceChildren();
  await mounted(path, { sameHost });
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
    await mounted("/");
    await write(field(), "Survive a reload");
    const { path, search } = place();
    await saved("Survive a reload");

    await remount(`${path}${search}`);

    expect(composerText(field())).toBe("Survive a reload");
  });

  it("keeps Home's one unsent draft and shows it again on every return", async () => {
    await mounted("/");
    await write(field(), "Not sent yet");
    await saved("Not sent yet");
    await openTask(firstTaskId());

    await newTask();
    expect(composerText(field())).toBe("Not sent yet");
    expect(savedDrafts()).toHaveLength(1);
  });

  it("reopens a named Home draft from the sidebar", async () => {
    await mount("/?draft=workshop");
    await write(field(), "Plan the workshop");
    await newTask();
    expect(composerText(field())).toBe("");

    await click(element(".side-section--tasks summary"));
    const reopen = [
      ...document.querySelectorAll<HTMLButtonElement>(".side-section--tasks details button"),
    ].find((button) => button.textContent === "Plan the workshop");
    expect(reopen).toBeDefined();
    await click(reopen!);
    expect(composerText(field())).toBe("Plan the workshop");
  });

  it("shows the safe refusal in the composer when the Host refuses a new task", async () => {
    await mounted("/");
    vi.spyOn(client, "createThread").mockRejectedValue(
      new HostClientRequestError({
        code: "forbidden",
        message: "This folder is on another computer.",
        status: 403,
      }),
    );
    await write(field(), "Start over there");
    await click(element(".composer__send"));

    await until("The refusal was never shown in the composer", () =>
      expect(element(".composer__error").textContent).toBe("Not started. You don't have access."),
    );
    expect(composerText(field())).toBe("Start over there");
  });

  it("removes the draft once it starts a task", async () => {
    await mounted("/");
    await write(field(), "Start this one");
    await click(element(".composer__send"));

    await until("The started task never took the draft", () => {
      expect(place().path).toMatch(/^\/tasks\//u);
      expect(savedDrafts()).toEqual([]);
    });
    await newTask();
    expect(composerText(field())).toBe("");
  });

  it("gives each conversation its own reply, and marks the ones waiting", async () => {
    const { first, second } = await replyLeftIn("A reply to the first");
    await openTask(second);
    expect(composerText(field())).toBe("");
    await until("The first task was never marked as waiting", () =>
      expect(
        element(`.side-task[data-thread-id="${first}"]`).querySelector(".side-unsent"),
      ).not.toBeNull(),
    );

    await openTask(first);
    expect(composerText(field())).toBe("A reply to the first");
    expect(
      element(`.side-task[data-thread-id="${first}"]`).querySelector(".side-unsent"),
    ).toBeNull();
  });

  it("discards a reply from its row and takes the discard back", async () => {
    const { first, second } = await replyLeftIn("Maybe not");
    await openTask(second);

    await discardFromRow(first);
    expect(
      element(`.side-task[data-thread-id="${first}"]`).querySelector(".side-unsent"),
    ).toBeNull();

    await click(element(".toast__action"));
    await saved("Maybe not");
    await openTask(first);
    expect(composerText(field())).toBe("Maybe not");
  });

  it("returns a task refused after leaving to its own draft, and says why there", async () => {
    await mounted("/");
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

    await act(async () => {
      refused.resolve();
    });
    // Away from it, the refusal is kept with the draft it came from.
    await until("The refusal was never handed back to its draft", () =>
      expect(savedDrafts().some((key) => composerDrafts.read(key)?.refusal !== undefined)).toBe(
        true,
      ),
    );

    await back();
    expect(composerText(field())).toBe("Do the thing");
    expect(element(".composer__error").textContent).toBe("Not started. You don't have access.");
  });

  it("hands a refused task to the draft reopened before the answer came", async () => {
    await mounted("/");
    const refused = deferred<void>();
    const create = vi.spyOn(client, "createThread").mockImplementation(async () => {
      await refused.promise;
      throw new HostClientRequestError({ code: "forbidden", message: "No.", status: 403 });
    });
    await write(field(), "Do the thing");
    await click(element(".composer__send"));
    await openTask(firstTaskId());
    await back();
    expect(composerText(field())).toBe("Do the thing");

    await act(async () => {
      refused.resolve();
      await create.mock.results[0]!.value.catch(() => undefined);
    });
    // The open draft takes the refusal: it says so, with its words as they were.
    await until("The reopened draft never took the refusal", () =>
      expect(element(".composer__error").textContent).toBe("Not started. You don't have access."),
    );
    expect(composerText(field())).toBe("Do the thing");
    await saved("Do the thing");

    const { path, search } = place();
    await remount(`${path}${search}`, true);
    expect(composerText(field())).toBe("Do the thing");
  });

  it("finishes an upload after leaving, and the file is there on return", async () => {
    await mounted("/", { latencyMs: 20 });
    const upload = vi.spyOn(client, "uploadAttachment");
    await attach("notes.txt");
    await openTask(firstTaskId());
    // The upload finishes while the person is away, and the draft keeps its file.
    await until("The upload never started", () => expect(upload).toHaveBeenCalled());
    await act(async () => {
      await upload.mock.results[0]!.value;
    });
    await until("The finished file was never saved with the draft", () =>
      expect(
        savedDrafts().some((key) =>
          composerDrafts.read(key)?.files?.some((file) => file.name === "notes.txt" && file.part),
        ),
      ).toBe(true),
    );

    await back();
    expect(document.querySelector(".composer__send")?.hasAttribute("disabled")).toBe(false);
    expect(document.body.textContent).toContain("notes.txt");
  });

  it("asks for a file again when a reload lost it mid-upload", async () => {
    await mounted("/");
    const search = () => place().search;
    await write(field(), "With a file");
    const key = await vi.waitFor(
      () => {
        const key = Object.keys(localStorage).find((name) => name.includes("composer-draft"));
        expect(key && composerDrafts.read(key)?.text).toBe("With a file");
        return key!;
      },
      { timeout: 1_000 },
    );
    await act(async () => {
      await composerDrafts.update(key, {
        files: [{ mediaType: "text/plain", name: "lost.txt", part: null, sizeBytes: 4 }],
      });
    });
    await remount(`/${search()}`);

    expect(composerText(field())).toBe("With a file");
    expect(document.body.textContent).toContain("added again");
    expect(document.querySelector(".composer__send")?.hasAttribute("disabled")).toBe(true);
  });

  it("survives React's double effects without losing or doubling a draft", async () => {
    await mounted("/", { strict: true });
    await write(field(), "Strict words");
    await saved("Strict words");
    await openTask(firstTaskId());
    await back();
    expect(composerText(field())).toBe("Strict words");
    expect(savedDrafts()).toHaveLength(1);
  });

  it("goes back to a draft from the browser's Back button", async () => {
    await mounted("/");
    await write(field(), "Back to me");
    await saved("Back to me");
    await openTask(firstTaskId());
    await back();
    expect(composerText(field())).toBe("Back to me");
  });
});
