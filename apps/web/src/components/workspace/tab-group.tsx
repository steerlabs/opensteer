import { memo, useMemo, useRef, useState, type CSSProperties } from "react";
import type { BrowserTabGroup } from "@opensteer/protocol";
import { BrowserTabGroupColorSchema, browserTabGroupTitleMaxLength } from "@opensteer/protocol";
import type { HostClient, PlaceItem, PlaceOccupant } from "@opensteer/client/host";
import { actionErrorMessage } from "../../ui-utils.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { SurfaceMenuRow } from "../surface-menu.js";
import { useToast } from "../toast.js";
import { OccupantMarks } from "./occupant-marks.js";
import { useTabGroupCloser } from "./tab-closer.js";
import type { TaskDirectory } from "./task-directory.js";
import type { TabSortHandle } from "./use-tab-sort.js";

export function tabGroupStyle(color: BrowserTabGroup["color"]): CSSProperties {
  return { "--tab-group-color": `var(--tab-group-${color})` } as CSSProperties;
}

export const TabGroupHeader = memo(function TabGroupHeader({
  active,
  directory,
  editing,
  group,
  hostClient,
  onEdit,
  onOpenMark,
  places,
  sort,
}: {
  readonly active: boolean;
  readonly directory: TaskDirectory;
  readonly editing: boolean;
  readonly group: BrowserTabGroup;
  readonly hostClient: HostClient;
  readonly onEdit: (id: string | null) => void;
  readonly onOpenMark: (place: PlaceItem, threadId: string) => void;
  readonly places: readonly PlaceItem[];
  /** Drag-and-drop and ⌘↑/⌘↓ for the whole group. */
  readonly sort: TabSortHandle;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const toast = useToast();
  const [at, setAt] = useState<{ x: number; y: number } | undefined>();
  const occupants = useMemo(() => {
    const members = new Map<string, PlaceOccupant>();
    for (const place of places)
      for (const occupant of place.occupants) {
        const held = members.get(occupant.threadId);
        if (!held || occupant.lastActiveAt > held.lastActiveAt)
          members.set(occupant.threadId, occupant);
      }
    return [...members.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }, [places]);
  const edit = (point?: { x: number; y: number }) => {
    setAt(point);
    onEdit(group.id);
  };
  const name = group.title || "Untitled group";
  return (
    <li
      className={`side-tab side-tab-group${active && group.collapsed ? " is-active" : ""}`}
      data-motion-key={group.id}
      data-tab-group-id={group.id}
      style={tabGroupStyle(group.color)}
      onContextMenu={(event) => {
        event.preventDefault();
        edit({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => sort.keyMove(event, group.id)}
      onPointerDown={(event) => sort.press(event, group.id)}
    >
      <button
        aria-current={active && group.collapsed ? "true" : undefined}
        aria-expanded={!group.collapsed}
        aria-label={`${name}, ${places.length} tabs`}
        className="side-tab__main side-tab-group__main"
        onClick={() =>
          void hostClient
            .updateBrowserTabGroup(group.id, { collapsed: !group.collapsed })
            .catch((error: unknown) => toast.error(actionErrorMessage(error)))
        }
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault();
            edit();
          }
        }}
        ref={setAnchor}
        type="button"
      >
        <span
          aria-hidden
          className={`side-tab-group__chevron${group.collapsed ? "" : " is-expanded"}`}
        >
          <Icon name="chevron-right" />
        </span>
        <span
          className={`side-tab-group__chip${group.title ? "" : " side-tab-group__chip--empty"}`}
        >
          {group.title}
        </span>
        {group.collapsed ? <span className="side-tab-group__count">{places.length}</span> : null}
      </button>
      {group.collapsed ? (
        <OccupantMarks
          directory={directory}
          fallbackFocus={() => anchor}
          onOpen={(threadId) => {
            const place = places.find((place) =>
              place.occupants.some((occupant) => occupant.threadId === threadId),
            );
            if (place) onOpenMark(place, threadId);
          }}
          occupants={occupants}
          placeTitle={name}
          size={16}
        />
      ) : null}
      <button
        aria-label={`Edit ${name}`}
        aria-haspopup="dialog"
        className="side-row-action"
        onClick={() => edit()}
        title="Edit group"
        type="button"
      >
        <Icon name="more" />
      </button>
      {editing && anchor ? (
        <TabGroupEditor
          anchor={anchor}
          at={at}
          group={group}
          hostClient={hostClient}
          onClose={() => onEdit(null)}
          tabIds={places.flatMap((place) =>
            place.destination.kind === "browser" && place.destination.tabId
              ? [place.destination.tabId]
              : [],
          )}
        />
      ) : null}
    </li>
  );
});

function TabGroupEditor({
  anchor,
  at,
  group,
  hostClient,
  onClose,
  tabIds,
}: {
  readonly anchor: HTMLElement;
  readonly at: { x: number; y: number } | undefined;
  readonly group: BrowserTabGroup;
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly tabIds: readonly string[];
}) {
  const [title, setTitle] = useState(group.title);
  const saved = useRef(group.title);
  const toast = useToast();
  const closeGroup = useTabGroupCloser();
  const failed = (error: unknown) => toast.error(actionErrorMessage(error));
  const save = () => {
    const trimmed = title.trim();
    if (trimmed === saved.current) return;
    saved.current = trimmed;
    void hostClient.updateBrowserTabGroup(group.id, { title: trimmed }).catch((error: unknown) => {
      saved.current = group.title;
      failed(error);
    });
  };
  return (
    <Popover
      anchor={anchor}
      at={at}
      className="popover--surface popover--tab-group"
      label="Edit tab group"
      onClose={() => {
        save();
        onClose();
      }}
      onEscape={onClose}
      role="dialog"
    >
      <div className="tab-group-editor__name">
        <input
          aria-label="Group title"
          data-autofocus
          maxLength={browserTabGroupTitleMaxLength}
          onBlur={save}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              save();
              onClose();
            }
          }}
          placeholder="Name this group"
          value={title}
        />
      </div>
      <div aria-label="Group colour" className="tab-group-editor__colors" role="group">
        {BrowserTabGroupColorSchema.options.map((color) => (
          <button
            aria-label={color}
            aria-pressed={color === group.color}
            className="tab-group-editor__swatch"
            key={color}
            onClick={() => void hostClient.updateBrowserTabGroup(group.id, { color }).catch(failed)}
            style={tabGroupStyle(color)}
            title={color}
            type="button"
          >
            {color === group.color ? <Icon name="check" /> : null}
          </button>
        ))}
      </div>
      <div className="picker__section">
        <SurfaceMenuRow
          item={{ icon: "browser", label: "Ungroup" }}
          onChoose={() => {
            onClose();
            void hostClient.ungroupBrowserTabs(group.tabIds).catch(failed);
          }}
        />
        <SurfaceMenuRow
          item={{ icon: "close", label: "Close group" }}
          onChoose={() => {
            onClose();
            closeGroup(tabIds);
          }}
        />
      </div>
    </Popover>
  );
}
