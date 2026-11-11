import { useState, type FormEvent } from "react";
import { Icon } from "../icon.js";
import { AuthorAvatar, PeopleOnlyBadge } from "./team-marks.js";
import {
  authorName,
  plural,
  type FactView,
  type ThingView,
  type TopicView,
} from "./team-models.js";
import { shortWhen } from "./team-time.js";

export interface KnowledgeActions {
  readonly onSelectTopic: (topicId: string) => void;
  readonly onShowSource?: ((factId: string) => void) | undefined;
  readonly onHistory?: ((thingId: string) => void) | undefined;
  /** Present only for people who may write to this topic. */
  readonly onAddFact?:
    | ((fact: {
        readonly thing: string;
        readonly property: string;
        readonly value: string;
      }) => void)
    | undefined;
}

/**
 * A channel's shared memory: its own topic and the shared topics attached to
 * it, facts grouped by thing, each with who wrote it — a person or someone's
 * agent — and when. Editing appends a version; nothing is overwritten.
 */
export function KnowledgeTab({
  actions,
  history = null,
  selectedTopicId,
  things,
  topics,
}: {
  readonly actions: KnowledgeActions;
  /** Every version of one thing's facts, when the reader asked for it. */
  readonly history?: { readonly thingId: string; readonly versions: readonly FactView[] } | null;
  readonly selectedTopicId: string;
  readonly things: readonly ThingView[];
  readonly topics: readonly TopicView[];
}) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const topic = topics.find((entry) => entry.id === selectedTopicId) ?? topics[0];
  const own = topics.filter((entry) => entry.kind === "channel");
  const attached = topics.filter((entry) => entry.kind === "shared");
  const needle = query.trim().toLowerCase();
  const shown = things.filter(
    (thing) =>
      needle === "" ||
      thing.name.toLowerCase().includes(needle) ||
      thing.key.toLowerCase().includes(needle) ||
      thing.facts.some(
        (fact) =>
          fact.property.toLowerCase().includes(needle) || fact.value.toLowerCase().includes(needle),
      ),
  );
  return (
    <div className="knowledge">
      <nav aria-label="Topics" className="knowledge__topics">
        <TopicGroup
          heading="This channel"
          onSelect={actions.onSelectTopic}
          selected={topic?.id}
          topics={own}
        />
        {attached.length > 0 ? (
          <TopicGroup
            heading="Attached"
            onSelect={actions.onSelectTopic}
            selected={topic?.id}
            topics={attached}
          />
        ) : null}
      </nav>
      {topic ? (
        <div className="knowledge__main">
          <header className="knowledge__head">
            <div className="knowledge__titles">
              <h2 className="knowledge__title">
                {topic.kind === "channel" ? `#${topic.name}’s topic` : topic.name}
                {topic.peopleOnly ? <PeopleOnlyBadge /> : null}
              </h2>
              <p className="knowledge__meta">
                {topic.access} · {plural(topic.factCount, "fact")} about{" "}
                {plural(topic.thingCount, "thing")}
              </p>
            </div>
            <label className="team-search-field knowledge__find">
              <Icon name="search" />
              <input
                aria-label="Find a thing or fact"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a thing or fact"
                value={query}
              />
            </label>
            {actions.onAddFact ? (
              <button className="btn btn--small" onClick={() => setAdding(true)} type="button">
                <Icon name="plus" />
                Add fact
              </button>
            ) : null}
          </header>
          {adding && actions.onAddFact ? (
            <AddFact
              onCancel={() => setAdding(false)}
              onSave={(fact) => {
                actions.onAddFact?.(fact);
                setAdding(false);
              }}
            />
          ) : null}
          {things.length === 0 ? (
            <p className="channel-tab__empty">
              Nothing here yet. People here, and their agents when asked, add facts as they learn
              them.
            </p>
          ) : shown.length === 0 ? (
            <p className="channel-tab__empty">Nothing matches “{query.trim()}”.</p>
          ) : (
            shown.map((thing) => (
              <ThingCard
                actions={actions}
                history={history?.thingId === thing.id ? history.versions : null}
                key={thing.id}
                thing={thing}
              />
            ))
          )}
        </div>
      ) : (
        <p className="channel-tab__empty">No topics you can read here.</p>
      )}
    </div>
  );
}

function TopicGroup({
  heading,
  onSelect,
  selected,
  topics,
}: {
  readonly heading: string;
  readonly onSelect: (topicId: string) => void;
  readonly selected: string | undefined;
  readonly topics: readonly TopicView[];
}) {
  return (
    <div className="knowledge__group">
      <p className="knowledge__group-title">{heading}</p>
      {topics.map((topic) => (
        <button
          aria-current={topic.id === selected ? "true" : undefined}
          className="knowledge__topic"
          key={topic.id}
          onClick={() => onSelect(topic.id)}
          type="button"
        >
          <Icon name={topic.kind === "channel" ? "hash" : "table"} />
          <span className="knowledge__topic-name">
            {topic.kind === "channel" ? topic.name.replace(/^#?/u, "#") : topic.name}
          </span>
          {topic.peopleOnly ? (
            <Icon className="knowledge__topic-people" name="user" />
          ) : (
            <span className="knowledge__topic-count">{topic.factCount}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function ThingCard({
  actions,
  history,
  thing,
}: {
  readonly actions: KnowledgeActions;
  readonly history: readonly FactView[] | null;
  readonly thing: ThingView;
}) {
  return (
    <article className="thing">
      <header className="thing__head">
        <h3 className="thing__name">{thing.name}</h3>
        <code className="thing__key">{thing.key}</code>
        {actions.onHistory ? (
          <button
            className="thing__history"
            onClick={() => actions.onHistory?.(thing.id)}
            type="button"
          >
            <Icon name="history" />
            History
          </button>
        ) : null}
      </header>
      <dl className="thing__facts">
        {thing.facts.map((fact) => (
          <FactRow fact={fact} key={fact.id} onShowSource={actions.onShowSource} />
        ))}
      </dl>
      {history ? (
        <div className="thing__versions">
          <p className="thing__versions-title">Every version</p>
          <dl className="thing__facts">
            {history.map((fact) => (
              <FactRow fact={fact} key={fact.id} />
            ))}
          </dl>
        </div>
      ) : null}
    </article>
  );
}

function FactRow({
  fact,
  onShowSource,
}: {
  readonly fact: FactView;
  readonly onShowSource?: ((factId: string) => void) | undefined;
}) {
  return (
    <div className="fact">
      <dt className="fact__property">{fact.property}</dt>
      <dd className="fact__value">{fact.value}</dd>
      <dd className="fact__writer">
        <AuthorAvatar author={fact.writer} size={16} />
        <span>
          {authorName(fact.writer)} · {shortWhen(fact.at)}
        </span>
        {fact.sourceLabel && onShowSource ? (
          <button className="fact__source" onClick={() => onShowSource(fact.id)} type="button">
            {fact.sourceLabel}
          </button>
        ) : null}
      </dd>
    </div>
  );
}

function AddFact({
  onCancel,
  onSave,
}: {
  readonly onCancel: () => void;
  readonly onSave: (fact: {
    readonly thing: string;
    readonly property: string;
    readonly value: string;
  }) => void;
}) {
  const [thing, setThing] = useState("");
  const [property, setProperty] = useState("");
  const [value, setValue] = useState("");
  const ready = thing.trim() && property.trim() && value.trim();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onSave({ thing: thing.trim(), property: property.trim(), value: value.trim() });
  };
  return (
    <form className="add-fact" onSubmit={submit}>
      <input
        aria-label="Thing"
        autoFocus
        className="text-input"
        onChange={(event) => setThing(event.target.value)}
        placeholder="Thing (Order 4411)"
        value={thing}
      />
      <input
        aria-label="Property"
        className="text-input"
        onChange={(event) => setProperty(event.target.value)}
        placeholder="Property (resolution)"
        value={property}
      />
      <input
        aria-label="Value"
        className="text-input"
        onChange={(event) => setValue(event.target.value)}
        placeholder="Value"
        value={value}
      />
      <button className="btn btn--small btn--ghost" onClick={onCancel} type="button">
        Cancel
      </button>
      <button className="btn btn--small btn--primary" disabled={!ready} type="submit">
        Save
      </button>
    </form>
  );
}
