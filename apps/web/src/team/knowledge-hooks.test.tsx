// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { KnowledgeNoteIdSchema, KnowledgeTopicIdSchema, UserIdSchema } from "@opensteer/core";
import { useKnowledgeNote, useKnowledgeNotes } from "@opensteer/client/react";
import type { TeamSessionClient } from "@opensteer/client/team";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const noteId = KnowledgeNoteIdSchema.parse("knt_00000000-0000-4000-8000-000000000001");
const topicId = KnowledgeTopicIdSchema.parse("ktp_00000000-0000-4000-8000-000000000001");
const ok = <Data,>(data: Data) => ({ ok: true as const, data });
const note = (text: string) => ({
  id: noteId,
  topicId,
  version: 1,
  title: text,
  body: text,
  deleted: false,
  writtenAt: "2026-11-01T00:00:00.000Z",
  writer: {
    kind: "agent",
    userId: UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000001"),
    name: "Leo",
  },
  source: null,
});

/** A team session whose knowledge reads answer with one note titled by `title()`. */
function account(title: () => Promise<string>): TeamSessionClient {
  return {
    rpc: {
      "team.knowledge.notes.page": () =>
        title().then((text) => ok({ notes: [{ ...note(text), preview: text }], nextCursor: null })),
      "team.knowledge.note.get": () => title().then((text) => ok(note(text))),
      "team.knowledge.note.history": () =>
        title().then((text) => ok({ versions: [note(`${text} v1`)], hasMore: false })),
    },
  } as unknown as TeamSessionClient;
}

type Read = ReturnType<typeof useKnowledgeNote>;

function mount() {
  /** Every render's text, not just the settled one: state cleared by an effect is a render late. */
  const seen: { open: Read | null; renders: string[] } = { open: null, renders: [] };
  function Knowledge({ session }: { readonly session: TeamSessionClient | null }) {
    const list = useKnowledgeNotes(session, { topicId: null, query: "" });
    const open = useKnowledgeNote(session, noteId, null);
    seen.open = open;
    const text = `${list.notes?.map((row) => row.title).join(",") ?? ""}|${open.note?.body ?? ""}|${
      open.history?.versions.map((version) => version.body).join(",") ?? ""
    }`;
    seen.renders.push(text);
    return <p>{text}</p>;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  return {
    host,
    seen,
    render: (session: TeamSessionClient | null) => root.render(<Knowledge session={session} />),
    unmount: () => root.unmount(),
  };
}

it("never shows one account's notes or versions while another account's read is pending", async () => {
  const a = account(() => Promise.resolve("Private note A"));
  const pending = Promise.withResolvers<string>();
  const b = account(() => pending.promise);
  const view = mount();
  try {
    await act(async () => view.render(a));
    await act(async () => view.seen.open?.showHistory());
    expect(view.host.textContent).toBe("Private note A|Private note A|Private note A v1");
    const switched = view.seen.renders.length;
    act(() => view.render(null));
    act(() => view.render(b));
    expect(view.seen.renders.slice(switched).join("\n")).not.toContain("Private note A");
    await act(async () => pending.resolve("Private note B"));
    expect(view.host.textContent).toBe("Private note B|Private note B|");
  } finally {
    act(() => view.unmount());
  }
});

it("drops an open note and its versions when a reload is refused", async () => {
  let readable = true;
  const session = account(() =>
    readable ? Promise.resolve("Leadership plan") : Promise.reject(forbidden()),
  );
  const view = mount();
  try {
    await act(async () => view.render(session));
    await act(async () => view.seen.open?.showHistory());
    expect(view.host.textContent).toContain("Leadership plan v1");
    readable = false;
    await act(async () => view.seen.open?.reload());
    expect(view.seen.open).toMatchObject({ note: null, history: null });
    expect(view.host.textContent).not.toContain("Leadership plan v1");
    expect(view.seen.open?.error).toMatchObject({ code: "forbidden" });
  } finally {
    act(() => view.unmount());
  }
});

function forbidden() {
  return Object.assign(new Error("That topic doesn't exist or you can't read it."), {
    code: "forbidden",
  });
}
