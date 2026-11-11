import { compareSequence, type Sequence } from "@opensteer/core";
import {
  TeamConsistentCutSchema,
  type TeamConsistentCut,
  type TeamMessage,
  type TeamAgentRequest,
} from "@opensteer/protocol";
import type { z } from "zod";
import type {
  TeamMessagePageSchema,
  TeamSubscriptionScopeSchema,
  TeamSidebarSchema,
} from "@opensteer/protocol";

export type TeamScope = z.infer<typeof TeamSubscriptionScopeSchema>;
export type TeamSidebar = z.infer<typeof TeamSidebarSchema>;
export type TeamPage = z.infer<typeof TeamMessagePageSchema>;
export interface TeamTimeline {
  readonly subscriptionId: string;
  readonly generation: number;
  readonly scope: TeamScope;
  readonly throughSeq: Sequence | null;
  readonly channel: TeamPage["channel"] | null;
  readonly messages: readonly TeamMessage[];
  readonly requests: readonly TeamAgentRequest[];
  readonly hasMore: boolean;
  readonly linkPresence: TeamConsistentCut["linkPresence"];
}
export const teamTimelineMaxMessages = 300;
export function teamScopeKey(scope: TeamScope): string {
  return JSON.stringify(
    scope.kind === "channel"
      ? [scope.kind, scope.channelId]
      : [scope.kind, scope.channelId, scope.rootId],
  );
}
export function emptyTeamTimeline(
  subscriptionId: string,
  generation: number,
  scope: TeamScope,
): TeamTimeline {
  return {
    subscriptionId,
    generation,
    scope,
    throughSeq: null,
    channel: null,
    messages: [],
    requests: [],
    hasMore: false,
    linkPresence: [],
  };
}
export function sameTeamScope(a: TeamScope, b: TeamScope): boolean {
  return (
    a.kind === b.kind &&
    a.channelId === b.channelId &&
    (a.kind !== "thread" || (b.kind === "thread" && a.rootId === b.rootId))
  );
}
function belongs(message: TeamMessage, scope: TeamScope): boolean {
  return (
    message.channelId === scope.channelId &&
    (scope.kind === "channel"
      ? message.threadRootId === null
      : message.id === scope.rootId || message.threadRootId === scope.rootId)
  );
}
function ordered(messages: Iterable<TeamMessage>, older = false): TeamMessage[] {
  const rows = [...messages].sort((a, b) =>
    BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0,
  );
  return older ? rows.slice(0, teamTimelineMaxMessages) : rows.slice(-teamTimelineMaxMessages);
}
export function reduceTeamCut(state: TeamTimeline, input: TeamConsistentCut): TeamTimeline {
  const cut = TeamConsistentCutSchema.parse(input);
  if (
    cut.subscriptionId !== state.subscriptionId ||
    cut.generation !== state.generation ||
    !sameTeamScope(cut.scope, state.scope)
  )
    return state;
  if (state.throughSeq !== null && compareSequence(cut.throughSeq, state.throughSeq) < 0)
    return state;
  if (
    cut.channel.id !== state.scope.channelId ||
    [...(cut.type === "snapshot" ? cut.messages : cut.changedRows), ...cut.requests].some(
      (row) => compareSequence(row.changeSeq, cut.throughSeq) > 0,
    )
  )
    throw new Error("Team cut exceeds its consistent watermark.");
  if (cut.type === "resumed" && state.throughSeq === null)
    throw new Error("A resumed cut requires its cached snapshot.");
  const messages = new Map(
    (cut.type === "snapshot"
      ? state.messages.filter((row) => compareSequence(row.changeSeq, cut.throughSeq) > 0)
      : state.messages
    ).map((row) => [row.id, row] as const),
  );
  const rows = cut.type === "snapshot" ? cut.messages : cut.changedRows;
  for (const row of rows) {
    if (!belongs(row, state.scope)) continue;
    const held = messages.get(row.id);
    if (!held || compareSequence(row.changeSeq, held.changeSeq) >= 0) messages.set(row.id, row);
  }
  if (cut.type === "resumed") for (const id of cut.deletedIds) messages.delete(id);
  const requests = new Map(
    cut.type === "snapshot" ? [] : state.requests.map((row) => [row.id, row] as const),
  );
  for (const row of cut.requests) {
    const held = requests.get(row.id);
    if (!held || compareSequence(row.changeSeq, held.changeSeq) >= 0) requests.set(row.id, row);
  }
  return {
    ...state,
    channel: cut.channel,
    messages: ordered(messages.values()),
    requests: [...requests.values()].slice(-200),
    throughSeq: cut.throughSeq,
    linkPresence: cut.linkPresence,
    hasMore: cut.type === "snapshot" ? cut.hasMore : state.hasMore,
  };
}
export function reduceTeamPage(
  state: TeamTimeline,
  page: TeamPage,
  generation: number,
  direction: "newest" | "before" | "after",
): TeamTimeline {
  if (generation !== state.generation || page.channel.id !== state.scope.channelId) return state;
  const rows = new Map(state.messages.map((row) => [row.id, row] as const));
  for (const row of page.messages) {
    if (!belongs(row, state.scope)) continue;
    const held = rows.get(row.id);
    // A page begun before a live cut cannot resurrect rows that cut removed.
    if (
      !held &&
      state.throughSeq !== null &&
      compareSequence(page.throughSeq, state.throughSeq) < 0
    )
      continue;
    if (!held || compareSequence(row.changeSeq, held.changeSeq) >= 0) rows.set(row.id, row);
  }
  return {
    ...state,
    messages: ordered(rows.values(), direction === "before"),
    hasMore: page.hasMore,
  };
}
export function monotonicTeamSidebar(
  previous: TeamSidebar | null,
  incoming: TeamSidebar,
): TeamSidebar {
  if (previous && compareSequence(incoming.accessRevision, previous.accessRevision) < 0)
    return previous;
  return {
    ...incoming,
    channels: incoming.channels.map((entry) => {
      const held = previous?.channels.find((row) => row.channel.id === entry.channel.id);
      if (
        held?.lastReadMessageId &&
        (!entry.lastReadMessageId ||
          (BigInt(held.lastReadMessageId) > BigInt(entry.lastReadMessageId) ? 1 : -1) > 0)
      )
        return {
          ...entry,
          lastReadMessageId: held.lastReadMessageId,
          unread: held.unread,
          mentionCount: held.mentionCount,
        };
      return entry;
    }),
  };
}
