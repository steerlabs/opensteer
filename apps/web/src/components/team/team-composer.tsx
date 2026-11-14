import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { attachmentDetail } from "../attachments/attachment-parts.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { AgentOrb } from "../workspace/task-mark.js";
import { PeopleOnlyBadge, PersonAvatar } from "./team-marks.js";
import {
  agentName,
  firstName,
  type MyAgentHere,
  type PersonView,
  type StagedFileView,
  type TeamSend,
} from "./team-models.js";

type PickerItem =
  | { readonly kind: "my-agent"; readonly available: boolean }
  | { readonly kind: "person"; readonly person: PersonView }
  | { readonly kind: "agent-reference"; readonly owner: PersonView };

interface MentionQuery {
  /** Where the "@" is in the text. */
  readonly start: number;
  readonly query: string;
}

const pickerLimit = 7;

/**
 * The team composer: words, files, @ mentions and the viewer's own agent.
 * "Ask my agent" is one state with two ways in — the pill, or "My agent" in
 * the @ list — and while it is on the message goes to the
 * thread and asks the viewer's agent. Naming another agent asks its owner.
 */
export function TeamComposer({
  notice,
  onMentionQuery,
  agent,
  agentStartsOn = false,
  onAgentRecipient,
  autoFocus = false,
  draft,
  onDraft,
  me,
  onAddFiles,
  onConnect,
  onEditLast,
  onRemoveFile,
  onSend,
  onTyping,
  people,
  placeholder,
  staged = [],
  typing = [],
}: {
  readonly notice?: string | null;
  readonly onMentionQuery?: ((query: string | null) => void) | undefined;
  readonly agent: MyAgentHere;
  /** The team Host's current recipient state for this thread. */
  readonly agentStartsOn?: boolean;
  readonly onAgentRecipient?: (enabled: boolean) => void;
  readonly autoFocus?: boolean;
  readonly draft?: string;
  readonly onDraft?: (text: string) => void;
  readonly me: PersonView;
  readonly onAddFiles?: ((files: readonly File[]) => void) | undefined;
  /** Connect this team to the viewer's own Opensteer. */
  readonly onConnect?: (() => void) | undefined;
  /** ↑ in an empty composer. */
  readonly onEditLast?: (() => void) | undefined;
  readonly onRemoveFile?: ((id: string) => void) | undefined;
  readonly onSend: (send: TeamSend) => Promise<void> | void;
  readonly onTyping?: (() => void) | undefined;
  /** Members of this channel, for the @ list. */
  readonly people: readonly PersonView[];
  readonly placeholder: string;
  readonly staged?: readonly StagedFileView[];
  readonly typing?: readonly PersonView[];
}) {
  const ready = agent.kind === "ready";
  const [text, setLocalText] = useState(draft ?? "");
  useEffect(() => {
    if (draft !== undefined) setLocalText(draft);
  }, [draft]);
  const setText = (value: string) => {
    setLocalText(value);
    onDraft?.(value);
  };
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [localToAgent, setLocalToAgent] = useState(ready && agentStartsOn);
  const toAgent = onAgentRecipient ? agentStartsOn : localToAgent;
  const setToAgent = (enabled: boolean) => {
    if (onAgentRecipient) onAgentRecipient(enabled);
    else setLocalToAgent(enabled);
  };
  const [mention, setMention] = useState<MentionQuery | null>(null);
  useEffect(() => {
    onMentionQuery?.(mention?.query ?? null);
  }, [mention?.query, onMentionQuery]);
  const [active, setActive] = useState(0);
  const [why, setWhy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const pill = useRef<HTMLButtonElement | null>(null);
  const files = useRef<HTMLInputElement | null>(null);
  const listId = useId();

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [text]);

  const items = useMemo(
    () => pickerItems(mention, agent, me, people),
    [agent, me, mention, people],
  );
  const uploading = staged.some((file) => file.status === "uploading");
  const failedFile = staged.some((file) => file.status === "failed");
  const sendable = (text.trim().length > 0 || staged.length > 0) && !failedFile;

  const askAgent = () => {
    if (ready) {
      setToAgent(true);
      field.current?.focus();
    } else setWhy(true);
  };

  const send = async (forceAgent: boolean) => {
    if (!sendable || sendingRef.current) return;
    if (forceAgent && !ready) {
      setWhy(true);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      await onSend({
        body: text.trim(),
        toMyAgent: ready && (forceAgent || (!onAgentRecipient && toAgent)),
      });
      setText("");
      setMention(null);
      if (!onAgentRecipient) setToAgent(ready && agentStartsOn);
    } catch {
      // The caller reports admission failure; the draft and files remain here.
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const pick = (item: PickerItem) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    if (item.kind === "my-agent") {
      setText(`${before}${after.replace(/^ /u, "")}`);
      setMention(null);
      if (item.available) askAgent();
      else setWhy(true);
      return;
    }
    const handle = item.kind === "person" ? item.person.handle : `${item.owner.handle}-agent`;
    const next = `${before}@${handle} ${after.replace(/^ /u, "")}`;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const caret = before.length + handle.length + 2;
      field.current?.setSelectionRange(caret, caret);
    });
  };

  const readMention = (element: HTMLTextAreaElement) => {
    const upto = element.value.slice(0, element.selectionStart);
    const query = /(?:^|\s)@([\w-]*)$/u.exec(upto)?.[1];
    setMention(query === undefined ? null : { start: upto.length - query.length - 1, query });
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (mention && items.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => (index + step + items.length) % items.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = items[active];
        if (item) pick(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      void send(false);
      return;
    }
    if (event.key === "ArrowUp" && text === "" && onEditLast) {
      event.preventDefault();
      onEditLast();
      return;
    }
    const element = event.currentTarget;
    if (
      event.key === "Backspace" &&
      toAgent &&
      element.selectionStart === 0 &&
      element.selectionEnd === 0
    ) {
      event.preventDefault();
      setToAgent(false);
    }
  };

  const takeFiles = (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    if (chosen.length > 0) onAddFiles?.(chosen);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAddFiles || event.clipboardData.files.length === 0) return;
    event.preventDefault();
    takeFiles(event.clipboardData.files);
  };
  const onDrag = (event: DragEvent<HTMLDivElement>) => {
    if (!onAddFiles || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDropping(event.type !== "dragleave");
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onAddFiles) return;
    event.preventDefault();
    setDropping(false);
    takeFiles(event.dataTransfer.files);
  };

  const shownPlaceholder = toAgent ? "Ask your agent…" : placeholder;
  return (
    <div className="team-composer">
      {onAgentRecipient && (toAgent || ready) ? (
        <button
          className="team-composer__recipient"
          type="button"
          onClick={() => setToAgent(!toAgent)}
        >
          {toAgent ? "→ your agent ✕" : "+ your agent"}
        </button>
      ) : null}
      <div
        className={[
          "composer",
          "team-composer__box",
          toAgent && !onAgentRecipient ? "team-composer__box--agent" : "",
          dropping ? "composer--dropping" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onDragEnter={onDrag}
        onDragLeave={onDrag}
        onDragOver={onDrag}
        onDrop={onDrop}
      >
        {mention && items.length > 0 ? (
          <MentionList
            active={active}
            id={listId}
            items={items}
            me={me}
            onHover={setActive}
            onPick={pick}
          />
        ) : null}
        {staged.length > 0 ? <StagedFiles files={staged} onRemove={onRemoveFile} /> : null}
        <div className="team-composer__line">
          {toAgent && !onAgentRecipient ? (
            <span className="mention mention--agent team-composer__chip">
              <span aria-hidden className="mention__dot" />
              @My agent
            </span>
          ) : null}
          <textarea
            aria-activedescendant={mention && items.length > 0 ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-controls={mention && items.length > 0 ? listId : undefined}
            aria-expanded={mention !== null && items.length > 0}
            aria-label={toAgent ? "Message to your agent" : "Message"}
            autoFocus={autoFocus}
            className="composer__input team-composer__input"
            onBlur={() => setMention(null)}
            onChange={(event) => {
              setText(event.target.value);
              readMention(event.target);
              onTyping?.();
            }}
            onClick={(event) => readMention(event.currentTarget)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={shownPlaceholder}
            ref={field}
            role="combobox"
            rows={1}
            disabled={sending}
            value={text}
          />
        </div>
        <div className="composer__footer team-composer__footer">
          {onAddFiles ? (
            <>
              <button
                aria-label="Attach files"
                className="composer__attach"
                onClick={() => files.current?.click()}
                title="Attach files"
                type="button"
              >
                <Icon name="paperclip" />
              </button>
              <input
                aria-hidden
                hidden
                multiple
                onChange={(event) => {
                  takeFiles(event.target.files);
                  event.target.value = "";
                }}
                ref={files}
                tabIndex={-1}
                type="file"
              />
            </>
          ) : null}
          <button
            aria-label="Mention someone"
            className="composer__attach"
            onClick={() => {
              const element = field.current;
              if (!element) return;
              const caret = element.selectionStart;
              const spacer = caret > 0 && !/\s$/u.test(text.slice(0, caret)) ? " " : "";
              const next = `${text.slice(0, caret)}${spacer}@${text.slice(caret)}`;
              setText(next);
              setMention({ start: caret + spacer.length, query: "" });
              requestAnimationFrame(() => {
                element.focus();
                element.setSelectionRange(caret + spacer.length + 1, caret + spacer.length + 1);
              });
            }}
            title="Mention someone · @"
            type="button"
          >
            <Icon name="at" />
          </button>
          {onAgentRecipient ? null : agent.kind === "people-only" ? (
            <span className="team-composer__people-only">
              <PeopleOnlyBadge />
              <span>Agents can’t be asked, read or search here.</span>
            </span>
          ) : (
            <button
              aria-pressed={toAgent}
              className={toAgent ? "ask-pill ask-pill--on" : "ask-pill"}
              onClick={() => (toAgent ? setToAgent(false) : askAgent())}
              ref={pill}
              title={toAgent ? "Don’t ask my agent" : "Ask my agent"}
              type="button"
            >
              <AgentOrb size={16} />
              {toAgent ? "To my agent" : "Ask my agent"}
              {toAgent ? <Icon className="ask-pill__off" name="close" /> : null}
            </button>
          )}
          <span className="team-composer__grow">
            {uploading ? (
              <span className="team-composer__hint">Sends when uploads finish</span>
            ) : null}
          </span>
          <button
            aria-label={toAgent ? "Send to your agent" : "Send"}
            className="composer__send"
            disabled={!sendable || sending}
            onClick={() => void send(false)}
            title={toAgent ? "Send · asks your agent" : "Send"}
            type="button"
          >
            <Icon name="arrow-up" />
          </button>
        </div>
      </div>
      {notice ? (
        <p className="team-composer__hint team-composer__hint--notice" role="status">
          {notice}
        </p>
      ) : null}
      <TypingLine people={typing} />
      {why && pill.current && (agent.kind === "not-linked" || agent.kind === "no-computer") ? (
        <Popover
          anchor={pill.current}
          label="Your agent"
          onClose={() => setWhy(false)}
          role="dialog"
        >
          <AgentUnavailable
            kind={agent.kind}
            onConnect={
              onConnect
                ? () => {
                    setWhy(false);
                    onConnect();
                  }
                : undefined
            }
          />
        </Popover>
      ) : null}
    </div>
  );
}

function pickerItems(
  mention: MentionQuery | null,
  agent: MyAgentHere,
  me: PersonView,
  people: readonly PersonView[],
): PickerItem[] {
  if (!mention) return [];
  const query = mention.query.toLowerCase();
  const agentsHere = agent.kind !== "people-only";
  const items: PickerItem[] = [];
  const myWords = ["my agent", "myagent", `${me.handle}-agent`, "agent"];
  if (agentsHere && (query === "" || myWords.some((word) => word.startsWith(query))))
    items.push({ kind: "my-agent", available: agent.kind === "ready" });
  const matches = people.filter((person) => !person.you && personMatches(person, query));
  for (const person of matches) items.push({ kind: "person", person });
  // Someone else's agent shows only when it is asked for by name, and never looks wakeable.
  if (agentsHere && query.length > 0)
    for (const person of matches) items.push({ kind: "agent-reference", owner: person });
  return items.slice(0, pickerLimit);
}

function personMatches(person: PersonView, query: string): boolean {
  if (query === "") return true;
  const handle = query.replace(/-a(g(e(nt?)?)?)?$/u, "");
  return (
    person.handle.toLowerCase().startsWith(handle) ||
    person.name
      .toLowerCase()
      .split(/\s+/u)
      .some((part) => part.startsWith(handle))
  );
}

function MentionList({
  active,
  id,
  items,
  me,
  onHover,
  onPick,
}: {
  readonly active: number;
  readonly id: string;
  readonly items: readonly PickerItem[];
  readonly me: PersonView;
  readonly onHover: (index: number) => void;
  readonly onPick: (item: PickerItem) => void;
}) {
  const firstPerson = items.findIndex((item) => item.kind === "person");
  return (
    <div className="at-list" id={id} role="listbox">
      {items.map((item, index) => {
        const selected = index === active;
        const common = {
          "aria-selected": selected,
          className: [
            "at-list__row",
            selected ? "is-active" : "",
            item.kind === "my-agent" && !item.available ? "at-list__row--inert" : "",
          ]
            .filter(Boolean)
            .join(" "),
          id: `${id}-${index}`,
          onMouseDown: (event: React.MouseEvent) => {
            event.preventDefault();
            onPick(item);
          },
          onMouseEnter: () => onHover(index),
          role: "option",
        } as const;
        const heading =
          index === firstPerson && index > 0 ? (
            <p className="at-list__heading" key={`heading-${index}`}>
              People here
            </p>
          ) : null;
        if (item.kind === "my-agent")
          return (
            <div key="my-agent" {...common}>
              <AgentOrb size={20} />
              <span className="at-list__text">
                <span className="at-list__name">My agent</span>
                <span className="at-list__detail">
                  {item.available
                    ? `Others see “${firstName(me)}’s agent” · @${me.handle}-agent`
                    : "Not connected to your Opensteer here"}
                </span>
              </span>
              {selected ? <Icon className="at-list__enter" name="corner-down-right" /> : null}
            </div>
          );
        if (item.kind === "person")
          return [
            heading,
            <div key={`person-${item.person.id}`} {...common}>
              <PersonAvatar person={item.person} presence size={20} />
              <span className="at-list__text">
                <span className="at-list__name">
                  {item.person.name}
                  {item.person.externalTeam ? (
                    <span className="team-external">External · {item.person.externalTeam}</span>
                  ) : null}
                </span>
                <span className="at-list__detail">@{item.person.handle}</span>
              </span>
              {selected ? <Icon className="at-list__enter" name="corner-down-right" /> : null}
            </div>,
          ];
        return (
          <div key={`agent-${item.owner.id}`} {...common}>
            <span className="person-face-badged">
              <PersonAvatar person={item.owner} size={20} />
              <span className="agent-badge">
                <img alt="" src="/opensteer.png" />
              </span>
            </span>
            <span className="at-list__text">
              <span className="at-list__name">{agentName(item.owner)}</span>
              <span className="at-list__detail at-list__detail--wrap">
                Ask {firstName(item.owner)}
                {item.owner.externalTeam ? ` · External · ${item.owner.externalTeam}` : ""}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StagedFiles({
  files,
  onRemove,
}: {
  readonly files: readonly StagedFileView[];
  readonly onRemove?: ((id: string) => void) | undefined;
}) {
  return (
    <div className="attachment-tray">
      <ul aria-label="Attachments" className="attachment-tray__list">
        {files.map((file) => (
          <li
            aria-busy={file.status === "uploading"}
            className={[
              "staged-attachment",
              "team-staged",
              file.status === "failed" ? "staged-attachment--failed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={file.id}
          >
            <span aria-hidden className="staged-attachment__media">
              {file.previewUrl ? <img alt="" src={file.previewUrl} /> : <Icon name="file" />}
              {file.status === "failed" ? (
                <Icon className="staged-attachment__alert" name="alert-circle" />
              ) : null}
            </span>
            <span className="staged-attachment__text">
              <span className="staged-attachment__name" title={file.name}>
                {file.name}
              </span>
              <span className="staged-attachment__detail">
                {file.status === "failed"
                  ? (file.error ?? "Could not be attached.")
                  : file.status === "uploading"
                    ? `${attachmentDetail(file.name, file.mediaType, file.sizeBytes)} · uploading`
                    : attachmentDetail(file.name, file.mediaType, file.sizeBytes)}
              </span>
            </span>
            {onRemove ? (
              <button
                aria-label={`Remove ${file.name}`}
                className="staged-attachment__action staged-attachment__action--remove"
                onClick={() => onRemove(file.id)}
                title="Remove"
                type="button"
              >
                <Icon name="close" />
              </button>
            ) : null}
            {file.status === "uploading" ? (
              <span
                aria-hidden
                className="team-staged__progress"
                style={{ transform: `scaleX(${Math.max(0.04, file.progress ?? 0)})` }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One reserved line, so nothing moves when someone starts or stops typing. */
export function TypingLine({ people }: { readonly people: readonly PersonView[] }) {
  const [first, second] = people;
  const words = !first
    ? ""
    : people.length === 1
      ? `${firstName(first)} is typing`
      : people.length === 2 && second
        ? `${firstName(first)} and ${firstName(second)} are typing`
        : "Several people are typing";
  return (
    <p aria-live="polite" className="typing-line">
      {words ? (
        <>
          <span aria-hidden className="typing-line__dots">
            <i />
            <i />
            <i />
          </span>
          {words}
        </>
      ) : null}
    </p>
  );
}

/**
 * Why "Ask my agent" can't ask here, and the one way forward: connect this
 * team to the person's own Opensteer, or set Opensteer up on a computer.
 */
export function AgentUnavailable({
  kind,
  onConnect,
}: {
  readonly kind: "not-linked" | "no-computer";
  readonly onConnect?: (() => void) | undefined;
}) {
  return (
    <div className="agent-unavailable">
      <AgentOrb size={28} />
      {kind === "not-linked" ? (
        <>
          <p className="agent-unavailable__title">Connect your agent</p>
          <p className="agent-unavailable__body">
            Your agent runs on your computer. Connect it to this team to ask it here. Your message
            still posts either way.
          </p>
          {onConnect ? (
            <button className="btn btn--small btn--primary" onClick={onConnect} type="button">
              Connect your agent
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p className="agent-unavailable__title">Your agent runs on a computer</p>
          <p className="agent-unavailable__body">
            Set up Opensteer on a Mac or PC to ask your agent here. You can still read and post from
            this device.
          </p>
        </>
      )}
    </div>
  );
}
