import { useRef, useState, type ReactNode } from "react";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { MessageBody, MessageFiles } from "./message-body.js";
import { AuthorAvatar, ChannelGlyph, PersonAvatar } from "./team-marks.js";
import {
  agentName,
  authorName,
  channelLabel,
  plural,
  type ChannelKind,
  type PersonView,
  type SearchFilters,
  type SearchResultView,
} from "./team-models.js";
import { clockTime, shortWhen } from "./team-time.js";

interface ChannelOption {
  readonly id: string;
  readonly name: string;
  readonly kind: ChannelKind;
}

export const noSearchFilters: SearchFilters = {
  authorId: null,
  channelId: null,
  hasFile: false,
  inThreads: false,
};

/**
 * One team's message search. Filters are chips, never syntax to learn, and
 * only four: where, who, in threads, has a file. Typing `in:#support` or
 * `from:@leo` turns into the matching chip.
 */
export function TeamSearch({
  channels,
  filters,
  header,
  onFilters,
  onOpenResult,
  onQuery,
  people,
  query,
  results,
}: {
  readonly channels: readonly ChannelOption[];
  readonly filters: SearchFilters;
  readonly header?: ReactNode;
  readonly onFilters: (filters: SearchFilters) => void;
  readonly onOpenResult: (result: SearchResultView) => void;
  readonly onQuery: (query: string) => void;
  readonly people: readonly PersonView[];
  readonly query: string;
  /** Null while the search runs. */
  readonly results: readonly SearchResultView[] | null;
}) {
  const channel = channels.find((entry) => entry.id === filters.channelId) ?? null;
  // The whole phrase first, so it is marked as one where it appears whole.
  const words = query.split(/\s+/u).filter((term) => term.length > 1);
  const terms = words.length > 1 ? [query.trim(), ...words] : words;
  const typed = (text: string) => {
    const token = /(?:^|\s)(in:#?([\w-]+)|from:@?([\w-]+))\s$/u.exec(text);
    if (token) {
      const [whole, , channelName, handle] = token;
      const next = text.slice(0, text.length - whole.length).trimEnd();
      const match = channelName
        ? channels.find((entry) => entry.name.toLowerCase() === channelName.toLowerCase())
        : undefined;
      const author = handle ? authorFromHandle(handle, people) : undefined;
      if (match) {
        onFilters({ ...filters, channelId: match.id });
        onQuery(next ? `${next} ` : "");
        return;
      }
      if (author) {
        onFilters({ ...filters, authorId: author });
        onQuery(next ? `${next} ` : "");
        return;
      }
    }
    onQuery(text);
  };
  return (
    <div className="team-search">
      {header}
      <div className="team-search__inner">
        <label className="team-search-field team-search__field">
          <Icon name="search" />
          <input
            aria-label="Search messages"
            autoFocus
            onChange={(event) => typed(event.target.value)}
            placeholder="Search messages"
            value={query}
          />
        </label>
        <div aria-label="Filters" className="team-search__filters" role="group">
          <FilterMenu
            icon={channel ? <ChannelGlyph kind={channel.kind} /> : <Icon name="hash" />}
            label={channel ? `In: ${channelLabel(channel)}` : "In: anywhere"}
            on={channel !== null}
            options={[
              { id: null, label: "Anywhere" },
              ...channels.map((entry) => ({
                id: entry.id,
                label: channelLabel(entry),
                mark: <ChannelGlyph kind={entry.kind} />,
              })),
            ]}
            onPick={(id) => onFilters({ ...filters, channelId: id })}
            selected={filters.channelId}
          />
          <FilterMenu
            icon={<Icon name="user" />}
            label={`From: ${authorLabel(filters.authorId, people)}`}
            on={filters.authorId !== null}
            options={[
              { id: null, label: "Anyone" },
              ...people.flatMap((person) => [
                {
                  id: person.id,
                  label: person.name,
                  mark: <PersonAvatar person={person} size={16} />,
                },
                {
                  id: `agent:${person.id}`,
                  label: agentName(person),
                  mark: <AuthorAvatar author={{ kind: "agent", owner: person }} size={16} />,
                },
              ]),
            ]}
            onPick={(id) => onFilters({ ...filters, authorId: id })}
            selected={filters.authorId}
          />
          <button
            aria-pressed={filters.inThreads}
            className="filter-chip"
            onClick={() => onFilters({ ...filters, inThreads: !filters.inThreads })}
            type="button"
          >
            <Icon name="reply" />
            In threads
          </button>
          <button
            aria-pressed={filters.hasFile}
            className="filter-chip"
            onClick={() => onFilters({ ...filters, hasFile: !filters.hasFile })}
            type="button"
          >
            <Icon name="paperclip" />
            Has a file
          </button>
        </div>
        {results === null ? (
          <p className="team-search__count">Searching…</p>
        ) : query.trim() === "" && !filtered(filters) ? (
          <p className="team-search__count">Search messages in every channel you’re in.</p>
        ) : (
          <>
            <p aria-live="polite" className="team-search__count">
              {results.length === 0
                ? "No messages match."
                : `${plural(results.length, "result")}${channel ? ` in ${channelLabel(channel)}` : ""}`}
            </p>
            <ul className="search-results">
              {groupResults(results).map((group) => (
                <li className="search-group" key={group.key}>
                  <header className="search-group__head">
                    <ChannelGlyph kind={group.channel.kind} />
                    <span className="search-group__where">{group.channel.name}</span>
                    <span className="search-group__detail">
                      {group.threadOf
                        ? `· thread under “${group.threadOf}”`
                        : `· ${shortWhen(group.at)}`}
                    </span>
                  </header>
                  {group.results.map((result) => (
                    <button
                      className="search-hit"
                      key={result.message.id}
                      onClick={() => onOpenResult(result)}
                      type="button"
                    >
                      <AuthorAvatar author={result.message.author} size={28} />
                      <span className="search-hit__main">
                        <span className="tmsg__head">
                          <span className="tmsg__name">{authorName(result.message.author)}</span>
                          <time className="tmsg__time" dateTime={result.message.at}>
                            {clockTime(result.message.at)}
                          </time>
                        </span>
                        <MessageBody
                          highlight={terms}
                          mentions={result.message.mentions}
                          text={result.message.body}
                        />
                        <MessageFiles files={result.message.files} />
                      </span>
                      <span className="search-hit__view">
                        {result.threadOf ? "View in thread" : "View in channel"}
                        <Icon name="chevron-right" />
                      </span>
                    </button>
                  ))}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function filtered(filters: SearchFilters): boolean {
  return (
    filters.channelId !== null || filters.authorId !== null || filters.inThreads || filters.hasFile
  );
}

function groupResults(results: readonly SearchResultView[]) {
  const groups: {
    key: string;
    channel: SearchResultView["channel"];
    threadOf: string | null;
    at: string;
    results: SearchResultView[];
  }[] = [];
  for (const result of results) {
    const key = `${result.channel.id}:${result.threadOf ?? ""}`;
    const last = groups.at(-1);
    if (last && last.key === key) last.results.push(result);
    else
      groups.push({
        at: result.message.at,
        channel: result.channel,
        key: `${key}:${result.message.id}`,
        results: [result],
        threadOf: result.threadOf,
      });
  }
  return groups;
}

function authorFromHandle(handle: string, people: readonly PersonView[]): string | undefined {
  const lower = handle.toLowerCase();
  const agent = lower.endsWith("-agent");
  const person = people.find(
    (entry) => entry.handle.toLowerCase() === (agent ? lower.slice(0, -"-agent".length) : lower),
  );
  if (!person) return undefined;
  return agent ? `agent:${person.id}` : person.id;
}

function authorLabel(authorId: string | null, people: readonly PersonView[]): string {
  if (!authorId) return "anyone";
  const agent = authorId.startsWith("agent:");
  const person = people.find((entry) => entry.id === (agent ? authorId.slice(6) : authorId));
  if (!person) return "anyone";
  return agent ? agentName(person) : person.name;
}

function FilterMenu({
  icon,
  label,
  on,
  onPick,
  options,
  selected,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly on: boolean;
  readonly onPick: (id: string | null) => void;
  readonly options: readonly {
    readonly id: string | null;
    readonly label: string;
    readonly mark?: ReactNode;
  }[];
  readonly selected: string | null;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-pressed={on}
        className="filter-chip"
        onClick={() => setOpen((value) => !value)}
        ref={anchor}
        type="button"
      >
        {icon}
        {label}
        <Icon className="filter-chip__chevron" name="chevron-down" />
      </button>
      {open && anchor.current ? (
        <Popover anchor={anchor.current} below label={label} onClose={() => setOpen(false)}>
          {options.map((option) => (
            <button
              aria-checked={option.id === selected}
              className="picker__row"
              key={option.id ?? "none"}
              onClick={() => {
                setOpen(false);
                onPick(option.id);
              }}
              role="menuitemradio"
              type="button"
            >
              <span className="picker__glyph">{option.mark ?? null}</span>
              <span className="picker__label">{option.label}</span>
              <span className="picker__check">
                {option.id === selected ? <Icon name="check" /> : null}
              </span>
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}
