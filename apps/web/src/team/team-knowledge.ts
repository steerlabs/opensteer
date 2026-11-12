import { useMemo, useState } from "react";
import { KnowledgeTopicIdSchema, type TeamChannelId } from "@opensteer/core";
import type { TeamFact } from "@opensteer/protocol";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { KnowledgeActions } from "../components/team/knowledge-tab.js";
import type { FactView, ThingView, TopicView } from "../components/team/team-models.js";
import { useToast } from "../components/toast.js";
import { actionErrorMessage } from "../ui-utils.js";
import { useTeamRead, type TeamView } from "./team-view.js";
import { person } from "./team-view-models.js";

function valueText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function factView(view: TeamView, fact: TeamFact): FactView {
  const writer = person(view.words, fact.writerUserId);
  return {
    id: fact.id,
    property: fact.property,
    value: valueText(fact.value),
    writer:
      fact.writerKind === "agent"
        ? { kind: "agent", owner: writer }
        : { kind: "person", person: writer },
    at: fact.writtenAt,
    sourceLabel: fact.source ? "From a message" : null,
  };
}

/** The latest fact per thing and property, grouped by thing, as the knowledge tab draws them. */
export function thingsOf(view: TeamView, facts: readonly TeamFact[]): ThingView[] {
  const latest = new Map<string, TeamFact>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.thing, fact.property]);
    const held = latest.get(key);
    if (!held || BigInt(fact.id) > BigInt(held.id)) latest.set(key, fact);
  }
  const things = new Map<string, TeamFact[]>();
  for (const fact of latest.values())
    things.set(fact.thing, [...(things.get(fact.thing) ?? []), fact]);
  return [...things.entries()].map(([thing, rows]) => ({
    id: thing,
    name: thing,
    key: thing,
    facts: rows.map((fact) => factView(view, fact)),
  }));
}

/** One topic list and the selected topic's facts, for a channel's tab or the team page. */
export function useKnowledge(
  view: TeamView,
  channelId: TeamChannelId | null,
  topicId: string | null,
) {
  const toast = useToast();
  const topics = useTeamRead(
    () =>
      view.client.rpc["team.knowledge.topics.list"](channelId ? { channelId } : {}).then(
        unwrapRpcResult,
      ),
    `topics:${view.team.teamId}:${channelId ?? ""}`,
  );
  const list = topics.value?.topics ?? [];
  const selected = topicId ?? list[0]?.id ?? null;
  const facts = useTeamRead(
    selected
      ? () =>
          view.client.rpc["team.knowledge.facts.page"]({
            topicId: KnowledgeTopicIdSchema.parse(selected),
          }).then(unwrapRpcResult)
      : null,
    `facts:${selected ?? ""}`,
  );
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const history = useTeamRead(
    selected && historyFor
      ? () =>
          view.client.rpc["team.knowledge.history.page"]({
            topicId: KnowledgeTopicIdSchema.parse(selected),
          }).then(unwrapRpcResult)
      : null,
    `history:${selected ?? ""}:${historyFor ?? ""}`,
  );
  const things = useMemo(() => thingsOf(view, facts.value?.facts ?? []), [facts.value, view]);
  const topicViews = useMemo<TopicView[]>(
    () =>
      list.map((topic) => ({
        id: topic.id,
        name: topic.name,
        kind: topic.originChannelId ? "channel" : "shared",
        peopleOnly: topic.peopleOnly,
        factCount: topic.id === selected ? (facts.value?.facts.length ?? 0) : 0,
        thingCount: topic.id === selected ? things.length : 0,
        access: topic.originChannelId ? "Same access as its channel" : "Its own access list",
      })),
    [facts.value, list, selected, things.length],
  );
  const current = list.find((topic) => topic.id === selected) ?? null;
  const actions: Omit<KnowledgeActions, "onSelectTopic"> = {
    onHistory: (thingId) => setHistoryFor(thingId),
    onAddFact: current?.can.write
      ? (fact) => {
          const replaced = (facts.value?.facts ?? [])
            .filter((row) => row.thing === fact.thing && row.property === fact.property)
            .sort((left, right) => (BigInt(right.id) > BigInt(left.id) ? 1 : -1))[0];
          void view.client.rpc["commands.dispatch"]({
            type: "team.knowledge.fact.append",
            operationId: crypto.randomUUID(),
            facts: [
              {
                topicId: current.id,
                thing: fact.thing,
                property: fact.property,
                value: fact.value,
                replacesId: replaced?.id ?? null,
              },
            ],
          })
            .then(unwrapRpcResult)
            .then(facts.reload)
            .catch((error: unknown) => toast.error(actionErrorMessage(error)));
        }
      : undefined,
  };
  return {
    actions,
    current,
    selectedTopicId: selected ?? "",
    things,
    topics: topicViews,
    reloadTopics: topics.reload,
    history:
      historyFor && history.value
        ? {
            thingId: historyFor,
            versions: history.value.facts
              .filter((fact) => fact.thing === historyFor)
              .map((fact) => factView(view, fact)),
          }
        : null,
  };
}
