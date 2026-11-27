import { describe, expect, it } from "vitest";
import type {
  AgentOperationId,
  AgentSessionId,
  AgentWorkingIn,
  TabId,
  ThreadId,
  UserId,
} from "@opensteer/core";
import { AgentWorkingInRegistry } from "./agent-working-in.js";

const session = "ags_00000000-0000-4000-8000-000000000001" as AgentSessionId;
const task = "thr_00000000-0000-4000-8000-000000000001" as ThreadId;
const owner = "usr_owner" as UserId;
const op = (n: number) => `aop_00000000-0000-4000-8000-00000000000${n}` as AgentOperationId;
const tab = (name: string) => `tab_${name}` as TabId;

function registry() {
  const told: { ownerUserId: UserId; notice: AgentWorkingIn }[] = [];
  const working = new AgentWorkingInRegistry((ownerUserId, notice) =>
    told.push({ ownerUserId, notice }),
  );
  return { working, told };
}

describe("where a connected agent's session works now", () => {
  it("tells the owner only when the tab changes, and clears the operation's tab at its end", () => {
    const { working, told } = registry();
    working.begin(session, op(1), task, owner);
    // Nothing yet: no tab has been worked in.
    expect(told).toEqual([]);
    expect(working.ofTask(owner, task)).toBeUndefined();
    working.note(`session:${session}`, tab("a"));
    working.note(`session:${session}`, tab("a"));
    working.note(`session:${session}`, tab("a"));
    expect(told).toEqual([
      {
        ownerUserId: owner,
        notice: { threadId: task, sessionId: session, operationId: op(1), tabId: tab("a") },
      },
    ]);
    expect(working.operationTab(op(1))).toBe(tab("a"));
    working.note(`session:${session}`, tab("b"));
    expect(told.at(-1)?.notice).toMatchObject({ operationId: op(1), tabId: tab("b") });
    working.end(session, op(1));
    expect(working.operationTab(op(1))).toBeUndefined();
    // The session keeps its last tab, with nothing in flight.
    expect(told.at(-1)?.notice).toEqual({
      threadId: task,
      sessionId: session,
      operationId: null,
      tabId: tab("b"),
    });
    expect(working.ofTask(owner, task)).toEqual(told.at(-1)?.notice);
    // Another person's read of the same task names nothing.
    expect(working.ofTask("usr_other" as UserId, task)).toBeUndefined();
    expect(told).toHaveLength(3);
  });

  it("names a new operation's tab at its first command, even the session's last one", () => {
    const { working, told } = registry();
    working.begin(session, op(1), task, owner);
    working.note(`session:${session}`, tab("a"));
    working.end(session, op(1));
    working.begin(session, op(2), task, owner);
    const before = told.length;
    working.note(`session:${session}`, tab("a"));
    expect(told.slice(before)).toEqual([
      {
        ownerUserId: owner,
        notice: { threadId: task, sessionId: session, operationId: op(2), tabId: tab("a") },
      },
    ]);
  });

  it("ignores a Run's binding and a session it does not know, and forgets a session at its end", () => {
    const { working, told } = registry();
    working.note("run:run_1", tab("a"));
    working.note(`session:${session}`, tab("a"));
    expect(told).toEqual([]);
    working.begin(session, op(1), task, owner);
    working.note(`session:${session}`, tab("a"));
    working.close(session);
    expect(told.at(-1)?.notice).toEqual({
      threadId: task,
      sessionId: session,
      operationId: null,
      tabId: null,
    });
    expect(working.ofTask(owner, task)).toBeUndefined();
    expect(working.operationTab(op(1))).toBeUndefined();
    working.note(`session:${session}`, tab("b"));
    expect(told).toHaveLength(2);
  });
});
