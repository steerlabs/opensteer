import type { MessageEntry } from "@opensteer/client/host";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { reconcileOwed } from "./owed-message-model.js";

const reader = createId("user");
const claimedAt = "2026-11-15T12:00:00.000Z";
const minuteBefore = "2026-11-15T11:59:00.000Z";
let keys = 0;
const owed = (text = "yes") => ({
  createdAt: claimedAt,
  idempotencyKey: `message:${(keys += 1)}`,
  text,
});

function mine(id: string, body: string, createdAt = claimedAt): MessageEntry {
  return {
    author: { displayName: "Reader", kind: "human", principalId: reader, userId: reader },
    body,
    createdAt,
    id,
    kind: "message",
    messageKind: "input",
    runId: null,
  };
}

describe("an owed message against the transcript", () => {
  it("gives way to the Host's copy, not to an earlier message saying the same", () => {
    const command = owed();
    const earlier = mine("msg_earlier", "yes", minuteBefore);
    expect(reconcileOwed([earlier], command, reader, true).drawn).toBe(true);
    expect(reconcileOwed([earlier, mine("msg_new", "yes")], command, reader, true).drawn).toBe(
      false,
    );
  });

  it("stays given way once the Host's copy is seen, whatever is said after it", () => {
    const command = owed();
    const copy = mine("msg_copy", "yes");
    expect(reconcileOwed([copy], command, reader, true).drawn).toBe(false);
    // Another device says something else; a pane opened again reads the same.
    const after = [copy, mine("msg_other", "and this")];
    expect(reconcileOwed(after, command, reader, true).drawn).toBe(false);
  });

  it("recognises a copy already loaded when first drawn, as after a lost answer", () => {
    expect(reconcileOwed([mine("msg_copy", "yes")], owed(), reader, true).drawn).toBe(false);
  });

  it("is not answered by an older message loaded later", () => {
    const command = owed();
    expect(reconcileOwed([], command, reader, true).drawn).toBe(true);
    const history = mine("msg_old", "yes", "2026-11-14T09:00:00.000Z");
    expect(reconcileOwed([history], command, reader, true).drawn).toBe(true);
  });

  it("keeps where it was first drawn", () => {
    const command = owed();
    expect(reconcileOwed([], command, reader, false)).toEqual({ drawn: false, inline: false });
    expect(reconcileOwed([], command, reader, true)).toEqual({ drawn: false, inline: false });
  });
});
