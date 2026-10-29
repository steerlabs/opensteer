import { useEffect, useRef, useState } from "react";
import type { ThreadMessagePage } from "@opensteer/protocol";
import { formatRelativeTime, messageAuthorName, type HostClient } from "@opensteer/client/host";
import { actionErrorMessage } from "../ui-utils.js";
import { messageText } from "./attachments/attachment-parts.js";
import { Icon } from "./icon.js";

/** The Host's cap on a query; a longer one is refused, so it is not sent. */
const queryLimit = 256;

/** One canonical message, exactly as the Host’s search returns it. */
type FoundMessage = ThreadMessagePage["messages"][number];

interface ThreadFindProps {
  readonly client: HostClient;
  /** The reader's Chat: a result that came from it says so. */
  readonly homeThreadId: string | null;
  /** Closes the panel and returns the keyboard where it came from. */
  readonly onClose: () => void;
  /**
   * Loads the surrounding window for this exact source id and moves the
   * reader to it. The caller owns scrolling, highlighting and stopping
   * tail-follow, because only it knows where the transcript is rendered.
   */
  readonly onJump: (messageId: string) => Promise<void>;
  readonly threadId: string;
}

/**
 * Find in conversation: a Host-side query over this Thread's messages, with
 * every result addressed by its exact source id.
 */
export function ThreadFind({ client, homeThreadId, onClose, onJump, threadId }: ThreadFindProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly FoundMessage[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jumpingId, setJumpingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A new conversation is a new search; results from another one must never
  // offer a jump into a transcript they do not belong to.
  useEffect(() => {
    setQuery("");
    setResults(null);
    setNextBefore(null);
    setError(null);
  }, [threadId]);

  const runSearch = async (before?: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      setNextBefore(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const page = await client.searchThreadMessages({
        query: trimmed.slice(0, queryLimit),
        threadId,
        ...(before ? { before } : {}),
      });
      setResults((current) => (before && current ? [...current, ...page.messages] : page.messages));
      setNextBefore(page.window.nextBefore ?? null);
    } catch (searchError) {
      setError(actionErrorMessage(searchError));
    } finally {
      setSearching(false);
    }
  };

  const jump = async (messageId: string) => {
    setJumpingId(messageId);
    setError(null);
    try {
      await onJump(messageId);
    } catch (jumpError) {
      setError(actionErrorMessage(jumpError));
    } finally {
      setJumpingId(null);
    }
  };

  /** Up and down walk the results without leaving the query field. */
  const moveThroughResults = (direction: 1 | -1) => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-find-result]") ?? [])];
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = index < 0 ? (direction === 1 ? 0 : rows.length - 1) : index + direction;
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  };

  return (
    <section
      aria-label="Find in conversation"
      className="thread-find"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          moveThroughResults(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveThroughResults(-1);
        }
      }}
    >
      <div className="thread-find__bar">
        <Icon name="search" />
        <input
          aria-label="Find in conversation"
          className="text-input"
          maxLength={queryLimit}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void runSearch();
            }
          }}
          placeholder="Find in conversation…"
          ref={inputRef}
          type="search"
          value={query}
        />
        <button
          className="btn btn--small"
          disabled={searching || query.trim().length === 0}
          onClick={() => void runSearch()}
          type="button"
        >
          {searching ? "Searching…" : "Find"}
        </button>
        <button aria-label="Close find" className="icon-btn" onClick={onClose} type="button">
          <Icon name="close" />
        </button>
      </div>
      {error ? (
        <p className="form-actions__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="thread-find__results" ref={listRef}>
        {results === null ? (
          <p className="thread-find__hint">
            Search this conversation’s messages. A result opens the messages around it.
          </p>
        ) : results.length === 0 ? (
          <p className="thread-find__hint" role="status">
            No matching messages.
          </p>
        ) : (
          <>
            {results.map((message) => (
              <button
                className="thread-find__result"
                data-find-result
                disabled={jumpingId !== null}
                key={message.id}
                onClick={() => void jump(message.id)}
                type="button"
              >
                <span className="thread-find__result-head">
                  <span className="thread-find__result-author">
                    {messageAuthorName(message.author, message.kind, homeThreadId)}
                  </span>
                  <time dateTime={message.createdAt}>{formatRelativeTime(message.createdAt)}</time>
                </span>
                <span className="thread-find__result-excerpt">{excerpt(message)}</span>
              </button>
            ))}
            {nextBefore ? (
              <button
                className="sidebar__load-more"
                disabled={searching}
                onClick={() => void runSearch(nextBefore)}
                type="button"
              >
                {searching ? "Loading…" : "Older matches"}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function excerpt(message: FoundMessage): string {
  const text = messageText(message.content).replaceAll(/\s+/gu, " ").trim();
  if (text.length === 0) return "(attachment only)";
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}
