import type {
  AgentOperationTarget,
  AgentSessionId,
  AgentWorkingIn,
  DeviceId,
  TabId,
  ThreadId,
  UserId,
} from "@opensteer/core";

interface SessionWork {
  readonly ownerUserId: UserId;
  readonly taskId: ThreadId;
  place:
    | { readonly tabId: TabId; readonly computerId?: never }
    | {
        readonly tabId: null;
        readonly computerId: DeviceId;
        readonly target?: AgentOperationTarget;
      }
    | null;
}

/**
 * Where each connected agent's session is working now: one value per session, the tab or
 * device of its last command, in this process's memory only. A command costs one map read and one
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
    this.#sessions.set(sessionId, { ownerUserId, taskId, place: null });
  }

  /**
   * A command of `bindingId` has passed its recheck and targets `tabId` (or a script took up a
   * page it holds). Any binding but a connected agent's session is ignored without a lookup.
   */
  note(bindingId: string, tabId: TabId): void {
    if (!bindingId.startsWith("session:")) return;
    const sessionId = bindingId.slice("session:".length) as AgentSessionId;
    const work = this.#sessions.get(sessionId);
    if (!work || work.place?.tabId === tabId) return;
    work.place = { tabId };
    this.#publish(work.ownerUserId, this.#notice(sessionId, work));
  }

  /** A submitted device command replaces the browser place, even while a client awaits its app or screen. */
  noteComputer(
    sessionId: AgentSessionId,
    computerId: DeviceId,
    target?: AgentOperationTarget,
  ): void {
    const work = this.#sessions.get(sessionId);
    if (!work) return;
    const before = work.place?.computerId === computerId ? work.place.target : undefined;
    const approval = (place: AgentOperationTarget | undefined) =>
      place?.grant.kind === "computer-app" ? place.grant.approvalId : undefined;
    if (
      work.place?.computerId === computerId &&
      approval(before) === approval(target) &&
      before?.name === target?.name
    )
      return;
    work.place = { tabId: null, computerId, ...(target ? { target } : {}) };
    this.#publish(work.ownerUserId, this.#notice(sessionId, work));
  }

  tabOf(sessionId: AgentSessionId): TabId | null {
    return this.#sessions.get(sessionId)?.place?.tabId ?? null;
  }

  /** A closed tab clears every session there; a narrowing clears only the affected session. */
  forgetTab(ownerUserId: UserId, tabId: string, sessionId?: AgentSessionId): void {
    for (const [id, work] of this.#sessions)
      if (
        (!sessionId || id === sessionId) &&
        work.ownerUserId === ownerUserId &&
        work.place?.tabId === tabId
      )
        this.#release(id as AgentSessionId, work);
  }

  /** The session starts afresh (a narrowing left it running): it names no tab until it works. */
  clearSession(sessionId: AgentSessionId): void {
    const work = this.#sessions.get(sessionId);
    if (work?.place) this.#release(sessionId, work);
  }

  #release(sessionId: AgentSessionId, work: SessionWork): void {
    work.place = null;
    this.#publish(work.ownerUserId, this.#notice(sessionId, work));
  }

  /** The session has ended: nothing of it is kept, and the person hears that it is gone. */
  close(sessionId: AgentSessionId): void {
    const work = this.#sessions.get(sessionId);
    if (!work) return;
    this.#sessions.delete(sessionId);
    if (work.place)
      this.#publish(work.ownerUserId, { threadId: work.taskId, sessionId, tabId: null });
  }

  clear(): void {
    this.#sessions.clear();
  }

  /** What the person who owns the Home is told as their socket attaches: each tab named now. */
  current(ownerUserId: UserId): readonly AgentWorkingIn[] {
    const named: AgentWorkingIn[] = [];
    for (const [id, work] of this.#sessions)
      if (work.ownerUserId === ownerUserId && work.place)
        named.push(this.#notice(id as AgentSessionId, work));
    return named;
  }

  #notice(sessionId: AgentSessionId, work: SessionWork): AgentWorkingIn {
    return { threadId: work.taskId, sessionId, ...(work.place ?? { tabId: null }) };
  }
}
