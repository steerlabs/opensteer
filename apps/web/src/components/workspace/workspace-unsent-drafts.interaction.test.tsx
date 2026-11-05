// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi } from "vitest";
import { HostClientRequestError, mutationIdempotencyKey } from "@opensteer/client/host";

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
const draftRows = () => [...document.querySelectorAll<HTMLElement>(".side-task--draft")];
const draftTitles = () =>
  draftRows().map((row) => row.querySelector(".side-task__title")?.textContent);
const openDraft = (index = 0) => click(draftRows()[index]!.querySelector(".side-task__main")!);
const openTask = (threadId: string) =>
  click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
const newTask = () => click(element('[aria-label="New task"]'));
const place = () => history.at(-1)!;

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

async function createProject() {
  let id = "";
  await act(async () => {
    const result = await client.dispatch({
      idempotencyKey: mutationIdempotencyKey("workspace"),
      name: "Website",
      type: "workspace.create",
    });
    if (result.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    id = result.workspace.id;
  });
  return id;
}

async function chooseAssignee(name: string) {
  await click(element(".assignee__button"));
  await settle();
  const row = [...document.querySelectorAll<HTMLElement>(".assignee-popover .picker__row")].find(
    (candidate) => candidate.textContent?.includes(name),
  );
  if (!row) throw new Error(`Missing assignee ${name}`);
  await click(row);
}

async function remountWith(key: string, draft: unknown) {
  await act(async () => root?.unmount());
  setRoot(null);
  document.body.replaceChildren();
  localStorage.setItem(key, JSON.stringify(draft));
  await mount("/");
  await settle();
}

describe("what a person has written and not sent", () => {
  it("brings a new task back after visiting another task", async () => {
    await mount("/new");
    await settle();
    await write(field(), "Compare the invoices");
    expect(draftRows()).toHaveLength(0);

    await openTask(firstTaskId());
    await settle();
    expect(draftTitles()).toEqual(["Compare the invoices"]);

    await openDraft();
    await settle();
    expect(field().value).toBe("Compare the invoices");
    expect(place().path).toBe("/new");
  });

  it("keeps a draft through a reload, on the same address", async () => {
    await mount("/new");
    await settle();
    await write(field(), "Survive a reload");
    const { path, search } = place();
    await settle();

    await act(async () => root?.unmount());
    setRoot(null);
    document.body.replaceChildren();
    await mount(`${path}${search}`);
    await settle();

    expect(field().value).toBe("Survive a reload");
  });

  it("starts a blank task beside an unfinished one, and each keeps its own words", async () => {
    await mount("/new");
    await settle();
    await write(field(), "The first task");
    await newTask();
    await settle();
    expect(field().value).toBe("");
    await write(field(), "The second task");

    await openTask(firstTaskId());
    await settle();
    expect(draftTitles().sort()).toEqual(["The first task", "The second task"]);

    await openDraft(draftTitles().indexOf("The first task"));
    await settle();
    expect(field().value).toBe("The first task");
    await openDraft(draftTitles().indexOf("The second task"));
    await settle();
    expect(field().value).toBe("The second task");
  });

  it("reuses a blank task rather than listing it", async () => {
    await mount("/new");
    await settle();
    await newTask();
    await settle();
    await newTask();
    await settle();
    await openTask(firstTaskId());
    await settle();
    expect(draftRows()).toHaveLength(0);
  });

  it("removes the draft once it starts a task", async () => {
    await mount("/new");
    await settle();
    await write(field(), "Start this one");
    await click(element(".composer__send"));
    await settle(100);

    expect(place().path).toMatch(/^\/threads\//u);
    expect(draftRows()).toHaveLength(0);
    await newTask();
    await settle();
    expect(field().value).toBe("");
  });

  it("gives each conversation its own reply, and marks the ones waiting", async () => {
    await mount("/new");
    await settle();
    const [first, second] = [
      ...document.querySelectorAll<HTMLElement>(".side-task[data-thread-id]"),
    ]
      .map((row) => row.dataset.threadId!)
      .slice(0, 2);
    await openTask(first!);
    await settle();
    await write(field(), "A reply to the first");
    await openTask(second!);
    await settle();
    expect(field().value).toBe("");
    expect(
      element(`.side-task[data-thread-id="${first}"]`).querySelector(".side-unsent"),
    ).not.toBeNull();

    await openTask(first!);
    await settle();
    expect(field().value).toBe("A reply to the first");
    expect(
      element(`.side-task[data-thread-id="${first}"]`).querySelector(".side-unsent"),
    ).toBeNull();
  });

  it("keeps Chat's words apart from every task's", async () => {
    await mount("/");
    await settle();
    await write(field(), "Something for Chat");
    await openTask(firstTaskId());
    await settle();
    expect(field().value).toBe("");
    expect(element(".side-home .side-unsent")).not.toBeNull();
    await click(element(".side-home__main"));
    await settle();
    expect(field().value).toBe("Something for Chat");
  });

  it("discards a draft and takes the discard back", async () => {
    await mount("/new");
    await settle();
    await write(field(), "Maybe not");
    await openTask(firstTaskId());
    await settle();

    await click(element('[aria-label="Discard draft: Maybe not"]'));
    await settle();
    expect(draftRows()).toHaveLength(0);

    await click(element(".toast__action"));
    await settle();
    expect(draftTitles()).toEqual(["Maybe not"]);
    await openDraft();
    await settle();
    expect(field().value).toBe("Maybe not");
  });

  it("leaves the open draft when it is the one discarded, without writing it back", async () => {
    await mount("/new");
    await settle();
    await write(field(), "First");
    await openTask(firstTaskId());
    await settle();
    await openDraft();
    await settle();

    await click(element('[aria-label="Discard draft: First"]'));
    await settle();

    expect(field().value).toBe("");
    await openTask(firstTaskId());
    await settle();
    expect(draftRows()).toHaveLength(0);
  });

  it("returns a task refused after leaving to its own draft, and says why there", async () => {
    await mount("/new");
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

    expect(draftTitles()).toEqual(["Do the thing"]);
    expect(draftRows()[0]!.classList.contains("is-refused")).toBe(true);

    await openDraft();
    await settle();
    expect(field().value).toBe("Do the thing");
    expect(element(".composer__error").textContent).toContain("could not be started");
    expect(draftRows()[0]!.classList.contains("is-refused")).toBe(false);
  });

  it("hands a refused task to the draft reopened before the answer came", async () => {
    await mount("/new");
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
    await act(async () => {
      await goTo?.(-1);
    });
    await settle();
    await write(field(), "Written meanwhile");

    await act(async () => {
      refused.resolve();
    });
    await settle(50);
    expect(field().value).toBe("Do the thing\nWritten meanwhile");

    await write(field(), "Do the thing\nWritten meanwhile, and more");
    await openTask(firstTaskId());
    await settle();
    await openDraft();
    await settle();
    expect(field().value).toBe("Do the thing\nWritten meanwhile, and more");
  });

  it("keeps an upload going through a discard that is taken back", async () => {
    await mount("/new", { latencyMs: 30 });
    await settle();
    await attach("notes.txt");
    await openTask(firstTaskId());
    await settle();

    await click(element('[aria-label="Discard draft: notes.txt"]'));
    await settle();
    await click(element(".toast__action"));
    await settle(200);

    await openDraft();
    await settle();
    expect(document.body.textContent).not.toContain("added again");
    expect(document.querySelector(".composer__send")?.hasAttribute("disabled")).toBe(false);
  });

  it("does not let a discarded draft's upload bring it back", async () => {
    await mount("/new", { latencyMs: 30 });
    await settle();
    await attach("notes.txt");
    await openTask(firstTaskId());
    await settle();

    await click(element('[aria-label="Discard draft: notes.txt"]'));
    await settle(200);

    expect(draftRows()).toHaveLength(0);
    expect(Object.keys(localStorage).filter((key) => key.includes("composer-draft"))).toEqual([]);
  });

  it("finishes an upload after leaving, and the file is there on return", async () => {
    await mount("/new", { latencyMs: 20 });
    await settle();
    await attach("notes.txt");
    await openTask(firstTaskId());
    await settle(120);
    expect(draftTitles()).toEqual(["notes.txt"]);

    await openDraft();
    await settle();
    expect(document.querySelector(".composer__send")?.hasAttribute("disabled")).toBe(false);
    expect(document.body.textContent).toContain("notes.txt");
  });

  it("asks for a file again when a reload lost it mid-upload", async () => {
    await mount("/new");
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
    await remount(`/new${search()}`);
    await settle();

    expect(field().value).toBe("With a file");
    expect(document.body.textContent).toContain("added again");
    expect(document.querySelector(".composer__send")?.hasAttribute("disabled")).toBe(true);
  });

  it("survives React's double effects without losing or doubling a draft", async () => {
    await mount("/new", { strict: true });
    await settle();
    await write(field(), "Strict words");
    await openTask(firstTaskId());
    await settle();
    expect(draftTitles()).toEqual(["Strict words"]);
    await openDraft();
    await settle();
    expect(field().value).toBe("Strict words");
  });

  it("lists a project's draft in its folder, and moves it with the assignee", async () => {
    await mount("/new");
    await settle();
    const project = await createProject();
    await settle();
    await write(field(), "Whoever does this");

    await chooseAssignee("Website");
    await settle();
    expect(place().path).toBe(`/workspaces/${project}`);
    expect(field().value).toBe("Whoever does this");

    await openTask(firstTaskId());
    await settle();
    expect(draftRows()).toHaveLength(1);
    expect(draftRows()[0]!.classList.contains("side-task--nested")).toBe(true);

    await openDraft();
    await settle();
    expect(place().path).toBe(`/workspaces/${project}`);
    expect(field().value).toBe("Whoever does this");
  });

  it("uploads a draft's files again when its task moves to another Workspace", async () => {
    await mount("/new");
    await settle();
    const project = await createProject();
    await settle();
    await attach("notes.txt");
    await settle(50);
    const stage = vi.spyOn(client, "createAttachment");

    await chooseAssignee("Website");
    await settle(50);

    expect(stage).toHaveBeenCalledOnce();
    expect(stage.mock.calls[0]![0]).toMatchObject({ workspaceId: project });
    expect(document.querySelector(".composer__send")?.hasAttribute("disabled")).toBe(false);
  });

  it("keeps a draft whose project has gone reachable from Main", async () => {
    await mount("/new");
    await settle();
    await write(field(), "An orphan");
    const key = Object.keys(localStorage).find((name) => name.includes("composer-draft"))!;
    const saved = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
    await openTask(firstTaskId());
    await settle();
    await remountWith(key, { ...saved, workspaceId: "wrk_gone" });

    expect(draftTitles()).toEqual(["An orphan"]);
    await openDraft();
    await settle();
    expect(place().path).toBe("/new");
    expect(field().value).toBe("An orphan");
  });

  it("goes back to a draft from the browser's Back button", async () => {
    await mount("/new");
    await settle();
    await write(field(), "Back to me");
    await openTask(firstTaskId());
    await settle();
    await act(async () => {
      await goTo?.(-1);
    });
    await settle();
    expect(field().value).toBe("Back to me");
  });
});
