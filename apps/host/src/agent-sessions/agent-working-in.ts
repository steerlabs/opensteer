import type {
  AgentOperationId,
  AgentSessionId,
  AgentWorkingIn,
  TabId,
  ThreadId,
  UserId,
} from "@opensteer/core";

interface SessionWork {
  readonly ownerUserId: UserId;
  readonly taskId: ThreadId;
  /** Each operation in flight, oldest first, with the tab its last command targeted. */
  readonly inFlight: Map<AgentOperationId, TabId | null>;
  /** The tab the session's last command targeted, kept until the session ends. */
  lastTab: TabId | null;
}

/**
 * Where each connected agent's session is working now, in this process's memory only. A command
 * on a tab costs one map read and one comparison, and no statement. The person who owns the Home
 * hears of it only when it changes; nothing of it goes to an agent or another connection.
 */
export class AgentWorkingInRegistry {
  readonly #sessions = new Map<string, SessionWork>();
  readonly #publish: (ownerUserId: UserId, notice: AgentWorkingIn) => void;

  constructor(publish: (ownerUserId: UserId, notice: AgentWorkingIn) => void) {
    this.#publish = publish;
  }

  /** An operation of the session begins running: it has worked in no tab yet. */
  begin(
    sessionId: AgentSessionId,
    operationId: AgentOperationId,
    taskId: ThreadId,
    ownerUserId: UserId,
  ): void {
    let work = this.#sessions.get(sessionId);
    if (!work || work.taskId !== taskId || work.ownerUserId !== ownerUserId) {
      work = { ownerUserId, taskId, inFlight: new Map(), lastTab: null };
      this.#sessions.set(sessionId, work);
    }
    work.inFlight.set(operationId, null);
  }

  /** The operation has ended: it carries no tab any more; the session keeps its last one. */
  end(sessionId: AgentSessionId, operationId: AgentOperationId): void {
    const work = this.#sessions.get(sessionId);
    const tab = work?.inFlight.get(operationId);
    if (!work || tab === undefined) return;
    work.inFlight.delete(operationId);
    if (tab !== null) this.#publish(work.ownerUserId, this.#notice(sessionId, work));
  }

  /**
   * A command of `bindingId` has passed its recheck and targets `tabId` (or a script took up a
   * page it holds). Any binding but a connected agent's session is ignored without a lookup.
   */
  note(bindingId: string, tabId: TabId): void {
    if (!bindingId.startsWith("session:")) return;
    const sessionId = bindingId.slice("session:".length) as AgentSessionId;
    const work = this.#sessions.get(sessionId);
    if (!work) return;
    let changed = work.lastTab !== tabId;
    // Commands come from the session's one binding: each operation in flight is working there.
    for (const [operationId, tab] of work.inFlight)
      if (tab !== tabId) {
        changed = true;
        work.inFlight.set(operationId, tabId);
      }
    if (!changed) return;
    work.lastTab = tabId;
    this.#publish(work.ownerUserId, this.#notice(sessionId, work));
  }

  /** The session has ended: nothing of it is kept, and the person hears that it is gone. */
  close(sessionId: AgentSessionId): void {
    const work = this.#sessions.get(sessionId);
    if (!work) return;
    this.#sessions.delete(sessionId);
    if (work.lastTab !== null)
      this.#publish(work.ownerUserId, {
        threadId: work.taskId,
        sessionId,
        operationId: null,
        tabId: null,
      });
  }

  clear(): void {
    this.#sessions.clear();
  }

  /** The tab an operation in flight is working in, if any. */
  operationTab(operationId: AgentOperationId): TabId | undefined {
    for (const work of this.#sessions.values()) {
      const tab = work.inFlight.get(operationId);
      if (tab !== undefined) return tab ?? undefined;
    }
    return undefined;
  }

  /** Where the person's task's session is working now, if it has worked in a tab. */
  ofTask(ownerUserId: UserId, taskId: ThreadId): AgentWorkingIn | undefined {
    for (const [sessionId, work] of this.#sessions)
      if (work.ownerUserId === ownerUserId && work.taskId === taskId && work.lastTab !== null)
        return this.#notice(sessionId as AgentSessionId, work);
    return undefined;
  }

  #notice(sessionId: AgentSessionId, work: SessionWork): AgentWorkingIn {
    let operationId: AgentOperationId | null = null;
    let tabId = work.lastTab;
    for (const [id, tab] of work.inFlight)
      if (tab !== null) {
        operationId = id;
        tabId = tab;
      }
    return { threadId: work.taskId, sessionId, operationId, tabId };
  }
}
