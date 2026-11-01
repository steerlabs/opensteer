import { CHAT_THREAD_TITLE } from "@opensteer/core";
import type { HostSnapshot } from "./client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";
import type { PlaceItem } from "./places.js";
import { taskMark, type TaskMark } from "./task-marks.js";

/** One agent in a tab, app or phone that the reader can open. */
export interface PlaceAgent {
  readonly threadId: string;
  /** Chat, which wears the product's orb rather than a task's mark. */
  readonly home: boolean;
  readonly acting: boolean;
  readonly title: string;
  /** The task's mark; null for Chat. */
  readonly mark: TaskMark | null;
  readonly lastActiveAt: string;
}

/**
 * Who is in a place, as its bar and the Tabs list say it.
 *
 * `agents` are the occupants the reader can open, acting first and then most
 * recently active. `unnamedActing` says an agent acts here whom none of them
 * names: an older Host that reports acting without saying who, or a Thread
 * this reader's directory does not hold. It is evidence, never an identity, so
 * it can be said ("Agent working") but not opened.
 */
export interface PlaceAgents {
  readonly agents: readonly PlaceAgent[];
  readonly unnamedActing: boolean;
}

export type PlaceAgentSource = Pick<
  HostSnapshot,
  "activeTasks" | "browserSessions" | "machines" | "tasks" | "threads" | "workspaceTasks"
>;

/**
 * The agents in a place, from its `occupants` and nothing else: never the
 * route it was opened from, and never a Thread picked for being nearby.
 */
export function placeAgents(
  place: Pick<PlaceItem, "destination" | "occupants">,
  snapshot: PlaceAgentSource,
): PlaceAgents {
  const agents: PlaceAgent[] = [];
  let unnamedActing = false;
  for (const occupant of place.occupants) {
    const thread = occupant.home ? null : threadInDirectory(occupant.threadId, snapshot);
    if (!occupant.home && thread === null) {
      unnamedActing ||= occupant.acting;
      continue;
    }
    agents.push({
      acting: occupant.acting,
      home: occupant.home,
      lastActiveAt: occupant.lastActiveAt,
      mark: thread === null ? null : taskMark(thread),
      threadId: occupant.threadId,
      title: thread?.title.trim() || (occupant.home ? CHAT_THREAD_TITLE : "Task"),
    });
  }
  agents.sort(
    (a, b) =>
      Number(b.acting) - Number(a.acting) ||
      b.lastActiveAt.localeCompare(a.lastActiveAt) ||
      a.threadId.localeCompare(b.threadId),
  );
  return {
    agents,
    unnamedActing: unnamedActing || actingWithoutIdentity(place, snapshot),
  };
}

/**
 * Acting reported where no occupant says who. A browser's own flag names no
 * tab, so it speaks for a tab only while the browser holds that one tab and
 * no tab of it names an acting occupant. A task's session on an app or phone
 * names its holder as `actor`; one that acts without one is anonymous.
 */
function actingWithoutIdentity(
  place: Pick<PlaceItem, "destination" | "occupants">,
  snapshot: PlaceAgentSource,
): boolean {
  if (place.occupants.some(({ acting }) => acting)) return false;
  const { destination } = place;
  if (destination.kind === "browser") {
    const session = snapshot.browserSessions.find(({ id }) => id === destination.sessionId);
    if (session?.state !== "ready" || session.acting !== true) return false;
    const tabs = session.tabCatalog?.tabs ?? session.tabs;
    return (
      tabs.length === 1 &&
      tabs.every((tab) => tab.id === destination.tabId) &&
      !session.tabCatalog?.tabs.some((tab) => tab.occupants.some(({ acting }) => acting))
    );
  }
  if (destination.source?.kind === "owner-view") return false;
  const session = snapshot.machines
    .find(({ id }) => id === destination.machineId)
    ?.computerUse?.sessions.find(({ sessionId }) => sessionId === destination.computerSessionId);
  if (session === undefined || session.actor) return false;
  return destination.kind === "phone"
    ? session.actingDisplay === true
    : session.actingAppKeys.includes(destination.appKey);
}

/** Whether two answers say the same thing, so a bar redraws only when who is here changes. */
export function samePlaceAgents(left: PlaceAgents, right: PlaceAgents): boolean {
  return (
    left.unnamedActing === right.unnamedActing &&
    left.agents.length === right.agents.length &&
    left.agents.every((agent, index) => {
      const other = right.agents[index]!;
      return (
        agent.threadId === other.threadId &&
        agent.acting === other.acting &&
        agent.home === other.home &&
        agent.title === other.title &&
        agent.lastActiveAt === other.lastActiveAt &&
        agent.mark?.icon === other.mark?.icon &&
        agent.mark?.color === other.mark?.color
      );
    })
  );
}

/**
 * What a place's agent pill says: who and whether working, in two short lines,
 * and as one sentence for a screen reader. Null when no agent is here.
 */
export function placeAgentsWords(
  value: PlaceAgents,
): { readonly title: string; readonly detail: string | null; readonly label: string } | null {
  const { agents } = value;
  if (agents.length === 0)
    return value.unnamedActing
      ? { detail: null, label: "Agent working", title: "Agent working" }
      : null;
  if (agents.length === 1) {
    const agent = agents[0]!;
    const detail = !agent.acting && value.unnamedActing ? "Agent working" : placeAgentState(agent);
    return { detail, label: `${agent.title}, ${detail.toLowerCase()}`, title: agent.title };
  }
  const working = agents.filter(({ acting }) => acting).length;
  const title = `${agents.length} agents`;
  const detail =
    working === 0 ? (value.unnamedActing ? "Agent working" : "Idle") : `${working} working`;
  return { detail, label: `${title}, ${detail.toLowerCase()}`, title };
}

/** One agent's state in its place, as a menu row or the pill says it. */
export function placeAgentState(agent: Pick<PlaceAgent, "acting">): string {
  return agent.acting ? "Working here" : "Idle";
}
