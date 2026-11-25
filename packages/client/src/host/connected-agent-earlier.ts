import type { AgentOperationView } from "@opensteer/core";
import { operationAction, operationRow, operationTime } from "./agent-work.js";
import { distinctAgentPlaces } from "./connected-agents-now.js";

interface EarlierSession {
  readonly sessionId: string;
  readonly threadId: string;
  readonly place: string;
  readonly actionCount: number | null;
  readonly at: string;
  readonly action: string;
  readonly outcome: string;
}

interface EarlierDay {
  readonly day: string;
  readonly label: string;
  readonly sessions: readonly EarlierSession[];
}

const formatDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** Past sessions that have recorded actions. A session with no recorded action has no row. */
export function connectedAgentEarlier(input: {
  readonly operations: readonly AgentOperationView[];
  readonly activeSessionIds: ReadonlySet<string>;
  readonly hasEarlier: boolean;
  readonly now?: Date;
}): readonly EarlierDay[] {
  const bySession = new Map<string, AgentOperationView[]>();
  const seen = new Set<string>();
  for (const operation of input.operations) {
    if (input.activeSessionIds.has(operation.sessionId) || seen.has(operation.id)) continue;
    seen.add(operation.id);
    const actions = bySession.get(operation.sessionId);
    if (actions) actions.push(operation);
    else bySession.set(operation.sessionId, [operation]);
  }

  const sessions = [...bySession.values()].map((operations): EarlierSession => {
    const last = operations.reduce((latest, next) =>
      Date.parse(operationTime(next)) > Date.parse(operationTime(latest)) ? next : latest,
    );
    const row = operationRow(last);
    const places = input.hasEarlier
      ? []
      : distinctAgentPlaces(operations.map(({ target }) => target));
    // The cursor orders operations across all sessions. Another page can contain
    // an older action for any displayed session, even one above the oldest group.
    return {
      sessionId: last.sessionId,
      threadId: last.taskId,
      place: places.length > 1 ? `${places.length} places` : last.target.name,
      actionCount: input.hasEarlier ? null : operations.length,
      at: row.at,
      action: operationAction(last),
      outcome: row.outcome.label,
    };
  });
  sessions.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const now = input.now ?? new Date();
  const today = now.toDateString();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString();
  const byDay = new Map<string, { label: string; sessions: EarlierSession[] }>();
  for (const session of sessions) {
    const when = new Date(session.at);
    const day = when.toDateString();
    const group = byDay.get(day);
    if (group) group.sessions.push(session);
    else {
      const label =
        day === today ? "Today" : day === yesterday ? "Yesterday" : formatDate.format(when);
      byDay.set(day, { label, sessions: [session] });
    }
  }
  return [...byDay].map(([day, group]) => ({ day, ...group }));
}
