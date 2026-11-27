import type { AgentSessionId, AgentWorkingIn, TabId, ThreadId, UserId } from "@opensteer/core";

interface SessionWork {
  readonly ownerUserId: UserId;
  readonly taskId: ThreadId;
  /** The tab the session's last command targeted, or none. */
  tabId: TabId | null;
}

/**
 * Where each connected agent's session is working now: one value per session, the tab of its
 * last command, in this process's memory only. A command on a tab costs one map read and one
 * comparison, and no statement. Only the person who owns the Home hears of it, by one notice
 * (`host.agent-working-in`) when it changes and as their socket attaches; no read an agent can
 * make carries it.
 */
export class AgentWorkingInRegistry {
  readonly #sessions = new Map<string, SessionWork>();
  readonly #publish: (ownerUserId: UserId, notice: AgentWorkingIn) => void;

  constructor(publish: (ownerUserId: UserId, notice: AgentWorkingIn) => void) {
    this.#publish = publish;
  }

  /** The session's work runs for this task: from now on its commands say where it works. */
  begin(sessionId: AgentSessionId, taskId: ThreadId, ownerUserId: UserId): void {
    const work = this.#sessions.get(sessionId);
    if (work?.taskId === taskId && work.ownerUserId === ownerUserId) return;
    this.#sessions.set(sessionId, { ownerUserId, taskId, tabId: null });
  }

  /**
   * A command of `bindingId` has passed its recheck and targets `tabId` (or a script took up a
   * page it holds). Any binding but a connected agent's session is ignored without a lookup.
   */
  note(bindingId: string, tabId: TabId): void {
    if (!bindingId.startsWith("session:")) return;
    const sessionId = bindingId.slice("session:".length) as AgentSessionId;
    const work = this.#sessions.get(sessionId);
    if (!work || work.tabId === tabId) return;
    work.tabId = tabId;
    this.#publish(work.ownerUserId, this.#notice(sessionId, work));
  }

  /** The tab closed: no session of its owner works in it any more. */
  forgetTab(ownerUserId: UserId, tabId: string): void {
    for (const [id, work] of this.#sessions)
      if (work.ownerUserId === ownerUserId && work.tabId === tabId)
        this.#release(id as AgentSessionId, work);
  }

  /** The session's hold on the tab was released (its grant no longer reaches it). */
  releaseTab(sessionId: AgentSessionId, tabId: string): void {
    const work = this.#sessions.get(sessionId);
    if (work?.tabId === tabId) this.#release(sessionId, work);
  }

  #release(sessionId: AgentSessionId, work: SessionWork): void {
    work.tabId = null;
    this.#publish(work.ownerUserId, this.#notice(sessionId, work));
  }

  /** The session has ended: nothing of it is kept, and the person hears that it is gone. */
  close(sessionId: AgentSessionId): void {
    const work = this.#sessions.get(sessionId);
    if (!work) return;
    this.#sessions.delete(sessionId);
    if (work.tabId !== null)
      this.#publish(work.ownerUserId, { threadId: work.taskId, sessionId, tabId: null });
  }

  clear(): void {
    this.#sessions.clear();
  }

  /** What the person who owns the Home is told as their socket attaches: each tab named now. */
  current(ownerUserId: UserId): readonly AgentWorkingIn[] {
    const named: AgentWorkingIn[] = [];
    for (const [id, work] of this.#sessions)
      if (work.ownerUserId === ownerUserId && work.tabId !== null)
        named.push(this.#notice(id as AgentSessionId, work));
    return named;
  }

  #notice(sessionId: AgentSessionId, work: SessionWork): AgentWorkingIn {
    return { threadId: work.taskId, sessionId, tabId: work.tabId };
  }
}
