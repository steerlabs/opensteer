import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { classifyHref, teamPageUrl } from "@opensteer/core";
import { markdownLink } from "@opensteer/shared/markdownLinks";
import { collectComposerTokens } from "@opensteer/client/references";
import {
  composerReferenceCandidates,
  type HostClient,
  type PlaceItem,
} from "@opensteer/client/host";
import type { TeamChannelSummary, TeamTopic } from "@opensteer/protocol";
import { Icon, type IconName } from "./icon.js";
import type { ComposerEditorControl } from "./composer-editor.js";
import { PlaceMark } from "./workspace/place-mark.js";
import { mentionListHeight, mentionRoom } from "./workspace/place-picker.js";

/** Something the `@` list can write into the words: a Markdown link the Host or team built. */
export interface ComposerLinkCandidate {
  readonly key: string;
  readonly label: string;
  readonly markdown: string;
}

/** Personal links for an `@` query, from what this Host already holds. */
export function personalReferenceCandidates(
  hostClient: HostClient,
  query: string,
): readonly ComposerLinkCandidate[] {
  return composerReferenceCandidates(hostClient.getSnapshot(), query).flatMap((candidate) =>
    candidate.kind === "link" ? [candidate] : [],
  );
}

/** Team pages for an `@` query: the channels the sidebar holds, and knowledge topics read for it. */
export function teamReferenceCandidates(
  team: {
    readonly origin: string;
    readonly channels: readonly TeamChannelSummary[];
    readonly topics: readonly TeamTopic[];
  },
  query: string,
): readonly ComposerLinkCandidate[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches = (name: string) => name.toLocaleLowerCase().includes(needle);
  return [
    ...team.channels
      .filter((channel) => channel.kind !== "dm" && channel.kind !== "group_dm")
      .filter((channel) => channel.archivedAt === null && matches(channel.name))
      .map((channel) => ({
        key: `channel:${channel.id}`,
        label: channel.name,
        markdown: markdownLink(
          channel.name,
          teamPageUrl({ origin: team.origin, target: { kind: "channel", channelId: channel.id } }),
        ),
      })),
    ...team.topics
      .filter((topic) => topic.archivedAt === null && matches(topic.name))
      .map((topic) => ({
        key: `topic:${topic.id}`,
        label: topic.name,
        markdown: markdownLink(
          topic.name,
          teamPageUrl({
            origin: team.origin,
            target: { kind: "knowledge-topic", topicId: topic.id },
          }),
        ),
      })),
  ];
}

/** The heading a candidate is listed under, and its glyph, from where its link goes. */
export function referenceGroup(candidate: ComposerLinkCandidate): {
  readonly group: string;
  readonly glyph: IconName;
} {
  const href = collectComposerTokens(candidate.markdown, { commitTrailing: true })[0]?.href ?? "";
  const target = classifyHref(href);
  if (target.kind === "reference")
    switch (target.reference.kind) {
      case "task":
        return { group: "Recent tasks", glyph: "message" };
      case "automation":
        return { group: "Automations", glyph: "clock" };
      case "computer":
        return { group: "Computers", glyph: "desktop" };
      default:
        return { group: "References", glyph: "link" };
    }
  if (target.kind === "team-page")
    return target.page.target.kind.startsWith("knowledge")
      ? { group: "Knowledge", glyph: "folder" }
      : { group: "Channels", glyph: "hash" };
  return { group: "References", glyph: target.kind === "file" ? "file" : "link" };
}

const groupOrder = ["Recent tasks", "Automations", "Computers", "References"];
const perGroup = 6;

export type ReferencePickerRow =
  | {
      readonly kind: "link";
      readonly candidate: ComposerLinkCandidate;
      readonly glyph: IconName;
      readonly group: string;
    }
  | { readonly kind: "place"; readonly place: PlaceItem; readonly group: string };

/** Links grouped by kind, then the places a message can include. */
export function referencePickerRows(
  links: readonly ComposerLinkCandidate[],
  places: readonly PlaceItem[],
): readonly ReferencePickerRow[] {
  const grouped = new Map<string, ReferencePickerRow[]>();
  for (const candidate of links) {
    const { group, glyph } = referenceGroup(candidate);
    const rows = grouped.get(group) ?? [];
    if (rows.length < perGroup) rows.push({ kind: "link", candidate, glyph, group });
    grouped.set(group, rows);
  }
  return [
    ...groupOrder.flatMap((group) => grouped.get(group) ?? []),
    ...places.map((place): ReferencePickerRow => ({
      kind: "place",
      place,
      group: "Include context",
    })),
  ];
}

/**
 * `@` at a word start: references to write into the words and places to
 * include with the message, inline at the caret. A list of places alone
 * looks as it always has; headings appear once there is more than one kind.
 */
export function ComposerReferencePicker({
  active,
  below,
  hostClient,
  left,
  onPick,
  rows,
}: {
  readonly active: number;
  /** Opens under the words, when there is no room above them. */
  readonly below: boolean;
  readonly hostClient: HostClient | null;
  /** The caret's offset in the composer, so the list opens where the words are. */
  readonly left: number;
  readonly onPick: (row: ReferencePickerRow) => void;
  readonly rows: readonly ReferencePickerRow[];
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".picker__row.is-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (rows.length === 0) return null;
  const headed = rows.some((row) => row.group !== rows[0]?.group);
  return (
    <div
      aria-label="Mention"
      className={below ? "mention-list mention-list--below" : "mention-list"}
      id="composer-mention-list"
      ref={listRef}
      role="listbox"
      style={{ left }}
    >
      {rows.map((row, index) => {
        const heading =
          headed && row.group !== rows[index - 1]?.group ? (
            <p aria-hidden className="mention-list__heading" key={`heading:${row.group}`}>
              {row.group}
            </p>
          ) : null;
        const selected = index === active;
        const common = {
          "aria-selected": selected,
          className: `picker__row place-pick${row.kind === "link" ? " reference-pick" : ""}${selected ? " is-active" : ""}`,
          onClick: () => onPick(row),
          // The field keeps its caret while a row is chosen with the pointer.
          onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
          role: "option",
          tabIndex: -1,
          type: "button",
        } as const;
        return [
          heading,
          row.kind === "link" ? (
            <button key={row.candidate.key} {...common}>
              <Icon name={row.glyph} />
              <span className="place-pick__title">{row.candidate.label}</span>
            </button>
          ) : (
            <button key={row.place.key} {...common}>
              {hostClient ? <PlaceMark hostClient={hostClient} icon={row.place.icon} /> : null}
              <span className="place-pick__title">{row.place.title}</span>
              {row.place.device && row.place.device.name !== row.place.title ? (
                <span className="place-pick__device">{row.place.device.name}</span>
              ) : null}
            </button>
          ),
        ];
      })}
    </div>
  );
}

interface MentionQuery {
  readonly active: number;
  /** No room for the list above the words: it opens below them. */
  readonly below: boolean;
  readonly left: number;
  readonly query: string;
  /** Where the "@" is in the source. */
  readonly start: number;
}

/**
 * The `@` list for one editor: an "@query" at a word start, before a
 * collapsed caret, opens it; a pick replaces the query with a link (one undo
 * step) or, for a place, removes it and hands the place on.
 */
export function useReferencePicker({
  editor,
  frame,
  hostClient,
  links,
  places,
  onPick,
}: {
  readonly editor: RefObject<ComposerEditorControl | null>;
  /** The editor's frame; the list opens inside the box it sits in. */
  readonly frame: RefObject<HTMLElement | null>;
  readonly hostClient: HostClient | null;
  readonly links: ((query: string) => readonly ComposerLinkCandidate[]) | null;
  readonly places: ((query: string) => readonly PlaceItem[]) | null;
  /** After a pick has changed the words; a place is still to be included. */
  readonly onPick?: ((row: ReferencePickerRow) => void) | undefined;
}): {
  readonly close: () => void;
  readonly expanded: boolean;
  readonly keyDown: (event: KeyboardEvent) => boolean;
  readonly list: ReactNode;
  readonly open: boolean;
  readonly read: () => void;
} {
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const rows: readonly ReferencePickerRow[] = mention
    ? referencePickerRows(links?.(mention.query) ?? [], places?.(mention.query) ?? [])
    : [];
  const read = () => {
    const control = editor.current;
    const run = links || places ? (control?.caretRun() ?? null) : null;
    const at = run ? run.text.lastIndexOf("@") : -1;
    const query = run && at !== -1 ? run.text.slice(at + 1) : "";
    if (
      !run ||
      !control ||
      at === -1 ||
      /\s/u.test(query) ||
      (at > 0 && !/\s/u.test(run.text.charAt(at - 1)))
    ) {
      setMention(null);
      return;
    }
    const start = run.start + at;
    // The list opens at the "@", kept inside the box it opens from.
    const parent = frame.current?.offsetParent;
    const box = parent instanceof HTMLElement ? parent : null;
    const room = box?.clientWidth ?? 300;
    const caret = control.coordsAt(start);
    const offset = caret && box ? caret.left - box.getBoundingClientRect().left : 0;
    const space = box ? mentionRoom(box) : null;
    setMention((current) => ({
      active: current?.start === start ? Math.min(current.active, 99) : 0,
      below: space !== null && space.above < mentionListHeight && space.below > space.above,
      left: Math.max(0, Math.min(offset, room - Math.min(300, room))),
      query,
      start,
    }));
  };
  const pick = (row: ReferencePickerRow) => {
    const control = editor.current;
    if (!mention || !control) return;
    // The "@" and what followed it were only how the reference or place was found.
    const range = { start: mention.start, end: mention.start + 1 + mention.query.length };
    setMention(null);
    control.replace(range, row.kind === "link" ? `${row.candidate.markdown} ` : "", {
      historyGroup: "edit",
    });
    control.focus();
    onPick?.(row);
  };
  const keyDown = (event: KeyboardEvent): boolean => {
    if (!mention || rows.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setMention({ ...mention, active: (mention.active + step + rows.length) % rows.length });
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const row = rows[mention.active] ?? rows[0];
      if (row) pick(row);
      return true;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      setMention(null);
      return true;
    }
    return false;
  };
  return {
    close: () => setMention(null),
    expanded: mention !== null && rows.length > 0,
    keyDown,
    list: mention ? (
      <ComposerReferencePicker
        active={mention.active}
        below={mention.below}
        hostClient={hostClient}
        left={mention.left}
        onPick={pick}
        rows={rows}
      />
    ) : null,
    open: mention !== null,
    read,
  };
}
