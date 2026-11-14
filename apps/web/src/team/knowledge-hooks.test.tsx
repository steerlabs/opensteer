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

/** A team session whose knowledge reads answer with one note titled `title`. */
function account(title: Promise<string>): TeamSessionClient {
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
  const ok = <Data,>(data: Data) => ({ ok: true as const, data });
  return {
    rpc: {
      "team.knowledge.notes.page": () =>
        title.then((text) => ok({ notes: [{ ...note(text), preview: text }], nextCursor: null })),
      "team.knowledge.note.get": () => title.then((text) => ok(note(text))),
    },
  } as unknown as TeamSessionClient;
}

it("never shows one account's notes while another account's read is pending", async () => {
  const a = account(Promise.resolve("Private note A"));
  const pending = Promise.withResolvers<string>();
  const b = account(pending.promise);
  function Knowledge({ session }: { readonly session: TeamSessionClient | null }) {
    const list = useKnowledgeNotes(session, { topicId: null, query: "" });
    const open = useKnowledgeNote(session, noteId, null);
    return (
      <p>
        {list.notes?.map((row) => row.title).join(",")}|{open.note?.body}
      </p>
    );
  }
  const host = document.createElement("div"),
    root = createRoot(host);
  try {
    await act(async () => root.render(<Knowledge session={a} />));
    expect(host.textContent).toBe("Private note A|Private note A");
    act(() => root.render(<Knowledge session={null} />));
    expect(host.textContent).not.toContain("Private note A");
    act(() => root.render(<Knowledge session={b} />));
    expect(host.textContent).not.toContain("Private note A");
    await act(async () => pending.resolve("Private note B"));
    expect(host.textContent).toBe("Private note B|Private note B");
  } finally {
    act(() => root.unmount());
  }
});
