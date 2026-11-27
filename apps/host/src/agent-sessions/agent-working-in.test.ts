import { describe, expect, it } from "vitest";
import type { AgentSessionId, AgentWorkingIn, TabId, ThreadId, UserId } from "@opensteer/core";
import { AgentWorkingInRegistry } from "./agent-working-in.js";

const session = "ags_00000000-0000-4000-8000-000000000001" as AgentSessionId;
const other = "ags_00000000-0000-4000-8000-000000000002" as AgentSessionId;
const task = "thr_00000000-0000-4000-8000-000000000001" as ThreadId;
const otherTask = "thr_00000000-0000-4000-8000-000000000002" as ThreadId;
const owner = "usr_owner" as UserId;
const tab = (name: string) => `tab_${name}` as TabId;

function registry() {
  const told: { ownerUserId: UserId; notice: AgentWorkingIn }[] = [];
  const working = new AgentWorkingInRegistry((ownerUserId, notice) =>
    told.push({ ownerUserId, notice }),
  );
  return { working, told };
}

describe("where a connected agent's session works now", () => {
  it("holds one value per session, the tab of its last command, and tells the owner only of a change", () => {
    const { working, told } = registry();
    working.begin(session, task, owner);
    expect(told).toEqual([]);
    expect(working.current(owner)).toEqual([]);
    working.note(`session:${session}`, tab("a"));
    working.note(`session:${session}`, tab("a"));
    // A second operation of the same session, overlapping: the session's one value moves.
    working.begin(session, task, owner);
    working.note(`session:${session}`, tab("b"));
    working.note(`session:${session}`, tab("b"));
    expect(told).toEqual([
      { ownerUserId: owner, notice: { threadId: task, sessionId: session, tabId: tab("a") } },
      { ownerUserId: owner, notice: { threadId: task, sessionId: session, tabId: tab("b") } },
    ]);
    expect(working.current(owner)).toEqual([
      { threadId: task, sessionId: session, tabId: tab("b") },
    ]);
    // Another person is told nothing as their socket attaches.
    expect(working.current("usr_other" as UserId)).toEqual([]);
  });

  it("forgets a closed tab for every session naming it, and only for them", () => {
    const { working, told } = registry();
    working.begin(session, task, owner);
    working.begin(other, otherTask, owner);
    working.note(`session:${session}`, tab("a"));
    working.note(`session:${other}`, tab("b"));
    working.forgetTab(owner, tab("a"));
    expect(told.at(-1)?.notice).toEqual({ threadId: task, sessionId: session, tabId: null });
    expect(working.current(owner)).toEqual([
      { threadId: otherTask, sessionId: other, tabId: tab("b") },
    ]);
    // Cleared for one session only.
    working.clearSession(session);
    expect(working.current(owner)).toHaveLength(1);
    working.clearSession(other);
    expect(working.current(owner)).toEqual([]);
  });

  it("ignores a Run's binding and a session it does not know, and forgets a session at its end", () => {
    const { working, told } = registry();
    working.note("run:run_1", tab("a"));
    working.note(`session:${session}`, tab("a"));
    expect(told).toEqual([]);
    working.begin(session, task, owner);
    working.note(`session:${session}`, tab("a"));
    working.close(session);
    expect(told.at(-1)?.notice).toEqual({ threadId: task, sessionId: session, tabId: null });
    expect(working.current(owner)).toEqual([]);
    working.note(`session:${session}`, tab("b"));
    expect(told).toHaveLength(2);
  });
});
