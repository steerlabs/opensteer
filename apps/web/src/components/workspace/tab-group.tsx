import { memo, useMemo, useRef, useState, type CSSProperties } from "react";
import { TabGroupColorSchema, type TabGroup, type TabId } from "@opensteer/core";
import type { HostClient, PlaceItem, PlaceOccupant } from "@opensteer/client/host";
import { usePlaces } from "@opensteer/client/react";
import { act, toastFailure } from "../use-action.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { SurfaceMenuRow } from "../surface-menu.js";
import { useToast } from "../toast.js";
import { OccupantMarks } from "./occupant-marks.js";
import { useTabGroupCloser } from "./tab-closer.js";
import type { TaskDirectory } from "./task-directory.js";
import type { TabSortHandle } from "./use-tab-sort.js";

/** The Host's group name limit. */
const groupNameMaxLength = 80;

export function tabGroupStyle(color: TabGroup["color"]): CSSProperties {
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
  tabIds,
  sort,
}: {
  readonly active: boolean;
  readonly directory: TaskDirectory;
  readonly editing: boolean;
  readonly group: TabGroup;
  readonly hostClient: HostClient;
  readonly onEdit: (id: string | null) => void;
  readonly onOpenMark: (place: PlaceItem, threadId: string) => void;
  /** Its members this device lists, in order. */
  readonly tabIds: readonly TabId[];
  /** Drag-and-drop and ⌘↑/⌘↓ for the whole group. */
  readonly sort: TabSortHandle;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const toast = useToast();
  const [at, setAt] = useState<{ x: number; y: number } | undefined>();
  // Collapsed, it wears its members' marks: only then does it read them live.
  const keys = useMemo(() => (group.collapsed ? tabIds : []), [group.collapsed, tabIds]);
  const places = usePlaces(hostClient, keys);
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
    onEdit(group.groupId);
  };
  const name = group.name;
  return (
    <li
      className={`side-tab side-tab-group${active && group.collapsed ? " is-active" : ""}`}
      data-motion-key={group.groupId}
      data-tab-group-id={group.groupId}
      style={tabGroupStyle(group.color)}
      onContextMenu={(event) => {
        event.preventDefault();
        edit({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => sort.keyMove(event, group.groupId)}
      onPointerDown={(event) => sort.press(event, group.groupId)}
    >
      <button
        aria-current={active && group.collapsed ? "true" : undefined}
        aria-expanded={!group.collapsed}
        aria-label={`${name}, ${tabIds.length} tabs`}
        className="side-tab__main side-tab-group__main"
        onClick={() =>
          void act(
            hostClient,
            { label: "change this group", done: "changed", happened: "this group changed" },
            () =>
              hostClient.updateTabGroup({ groupId: group.groupId, collapsed: !group.collapsed }),
          ).catch(toastFailure(toast))
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
        <span className="side-tab-group__chip">{group.name}</span>
        {group.collapsed ? <span className="side-tab-group__count">{tabIds.length}</span> : null}
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
          tabIds={tabIds}
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
  readonly group: TabGroup;
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly tabIds: readonly TabId[];
}) {
  const [title, setTitle] = useState(group.name);
  const saved = useRef(group.name);
  const toast = useToast();
  const closeGroup = useTabGroupCloser();
  const failed = toastFailure(toast);
  const save = () => {
    const trimmed = title.trim();
    // A group always has a name; clearing it keeps the one it had.
    if (!trimmed || trimmed === saved.current) return;
    saved.current = trimmed;
    void act(
      hostClient,
      { label: "rename this group", done: "renamed", happened: "this group was renamed" },
      () => hostClient.updateTabGroup({ groupId: group.groupId, name: trimmed }),
    ).catch((error: unknown) => {
      saved.current = group.name;
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
          maxLength={groupNameMaxLength}
          onBlur={save}
          onChange={(event) => setTitle(event.target.value)}
          // A new group arrives named "New group": the name a person types replaces it.
          onFocus={(event) => event.currentTarget.select()}
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
        {TabGroupColorSchema.options.map((color) => (
          <button
            aria-label={color}
            aria-pressed={color === group.color}
            className="tab-group-editor__swatch"
            key={color}
            onClick={() =>
              void act(
                hostClient,
                { label: "change this group", done: "changed", happened: "this group changed" },
                () => hostClient.updateTabGroup({ groupId: group.groupId, color }),
              ).catch(failed)
            }
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
            void act(
              hostClient,
              {
                label: "ungroup these tabs",
                done: "ungrouped",
                happened: "these tabs were ungrouped",
              },
              () => hostClient.deleteTabGroup(group.groupId),
            ).catch(failed);
          }}
        />
        <SurfaceMenuRow
          item={{ icon: "close", label: "Close group" }}
          onChoose={() => {
            onClose();
            // The store keeps a group its tabs left; closing the group itself takes it away too.
            closeGroup(
              tabIds,
              () =>
                void act(
                  hostClient,
                  { label: "close this group", done: "closed", happened: "this group closed" },
                  () => hostClient.deleteTabGroup(group.groupId),
                ).catch(failed),
            );
          }}
        />
      </div>
    </Popover>
  );
}
