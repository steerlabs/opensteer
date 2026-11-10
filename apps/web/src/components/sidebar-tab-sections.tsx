import { memo, useCallback, useMemo, useState } from "react";
import {
  readFoldedTabSections,
  writeFoldedTabSections,
  type PlaceItem,
  type PlaceOccupant,
  type TabSection,
} from "@opensteer/client/host";
import { computerIcon } from "./computers/device-art.js";
import { Icon } from "./icon.js";
import { OccupantMarks } from "./workspace/occupant-marks.js";
import type { TaskDirectory } from "./workspace/task-directory.js";
import type { SortRow } from "./workspace/tab-sort.js";

const storage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};

/** The devices this person folded here, on this Deployment; a section is open until folded. */
export function useFoldedTabSections(
  deploymentId: string | null,
  userId: string | null,
): readonly [ReadonlySet<string>, (key: string) => void] {
  const scope = useMemo(() => ({ deploymentId, userId }), [deploymentId, userId]);
  const [held, setHeld] = useState(() => ({
    scope,
    folded: readFoldedTabSections(storage, scope),
  }));
  const folded = held.scope === scope ? held.folded : readFoldedTabSections(storage, scope);
  const toggle = useCallback(
    (key: string) => {
      const next = new Set(folded);
      if (!next.delete(key)) next.add(key);
      writeFoldedTabSections(storage, scope, next);
      setHeld({ scope, folded: next });
    },
    [folded, scope],
  );
  return [folded, toggle];
}

/** A section's places, as the list draws them when it is open. */
export function sectionPlaces(section: TabSection): readonly PlaceItem[] {
  return [
    ...section.web.flatMap((row) => (row.kind === "place" ? [row.place] : row.places)),
    ...section.native,
  ];
}

/**
 * Groups standing under more than one device: each of their headers needs a
 * key of its own. A group under one device keeps its id as its key.
 */
export function splitGroups(sections: readonly TabSection[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const split = new Set<string>();
  for (const section of sections)
    for (const row of section.web)
      if (row.kind === "group") {
        if (seen.has(row.group.id)) split.add(row.group.id);
        seen.add(row.group.id);
      }
  return split;
}

export function groupRowKey(groupId: string, section: string, split: ReadonlySet<string>): string {
  return split.has(groupId) ? `${groupId}@${section}` : groupId;
}

/**
 * The open sections' saved web tabs and group headers, as drag-and-drop sees
 * them. Each row carries its device: a tab runs where it runs, so a move
 * stays inside its own section.
 */
export function sortRowsOfSections(
  sections: readonly TabSection[],
  folded: ReadonlySet<string>,
): SortRow[] {
  const split = splitGroups(sections);
  return sections.flatMap((section): SortRow[] => {
    if (folded.has(section.key)) return [];
    const tab = (place: PlaceItem, group: (SortRow & { kind: "group" }) | null): SortRow[] =>
      place.workspaceTab && place.destination.kind === "browser" && place.destination.tabId
        ? [
            {
              kind: "tab",
              key: place.key,
              section: section.key,
              tabId: place.destination.tabId,
              group: group ? { id: group.groupId, color: group.color } : null,
            },
          ]
        : [];
    return section.web.flatMap((row): SortRow[] => {
      if (row.kind === "place") return tab(row.place, null);
      const header = {
        kind: "group",
        key: groupRowKey(row.group.id, section.key, split),
        section: section.key,
        groupId: row.group.id,
        color: row.group.color,
        collapsed: row.group.collapsed,
      } as const;
      return [
        header,
        ...(row.group.collapsed ? [] : row.places.flatMap((place) => tab(place, header))),
      ];
    });
  });
}

/**
 * A device's heading over its tabs and apps: its shape and its name, and
 * Offline when it is away. It folds what it heads; folded, it keeps the marks
 * of the tasks there, so an agent at work or a task that needs you is never
 * hidden by a fold.
 */
export const TabSectionHead = memo(function TabSectionHead({
  active,
  directory,
  folded,
  onOpenMark,
  onToggle,
  places,
  section,
}: {
  /** A folded section holds the place in the middle. */
  readonly active: boolean;
  readonly directory: TaskDirectory;
  readonly folded: boolean;
  readonly onOpenMark: (place: PlaceItem, threadId: string) => void;
  readonly onToggle: (key: string) => void;
  readonly places: readonly PlaceItem[];
  readonly section: TabSection;
}) {
  const { device } = section;
  const name = device?.name ?? "Apps";
  const offline = device !== null && !device.online;
  const occupants = useMemo(() => {
    if (!folded) return [];
    const members = new Map<string, PlaceOccupant>();
    for (const place of places)
      for (const occupant of place.occupants) {
        const held = members.get(occupant.threadId);
        if (!held || occupant.lastActiveAt > held.lastActiveAt)
          members.set(occupant.threadId, occupant);
      }
    return [...members.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }, [folded, places]);
  const count = places.length + section.pending.length;
  const classes = ["side-device", folded ? "is-folded" : "", folded && active ? "holds-open" : ""];
  return (
    <li
      className={classes.filter(Boolean).join(" ")}
      data-device-section={section.key}
      data-motion-key={`device:${section.key}`}
    >
      <button
        aria-expanded={!folded}
        aria-label={[name, offline ? "offline" : null, folded ? `${count} hidden` : null]
          .filter(Boolean)
          .join(", ")}
        className="side-device__main"
        onClick={() => onToggle(section.key)}
        title={offline ? `${name} · Offline` : name}
        type="button"
      >
        <span aria-hidden className="side-device__glyph">
          <Icon name={device ? computerIcon(device.glyph) : "app"} />
        </span>
        <span className="side-device__name">{name}</span>
        {offline ? <span className="side-device__away">· Offline</span> : null}
        {folded && occupants.length === 0 ? (
          <span aria-hidden className="side-device__count">
            {count}
          </span>
        ) : null}
      </button>
      {occupants.length > 0 ? (
        <OccupantMarks
          className="side-device__marks"
          directory={directory}
          fallbackFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-device-section="${CSS.escape(section.key)}"] .side-device__main`,
            )
          }
          onOpen={(threadId) => {
            const place = places.find((value) =>
              value.occupants.some((occupant) => occupant.threadId === threadId),
            );
            if (place) onOpenMark(place, threadId);
          }}
          occupants={occupants}
          placeTitle={name}
          size={16}
        />
      ) : null}
      <span aria-hidden className="side-device__chevron">
        <Icon name={folded ? "chevron-right" : "chevron-down"} />
      </span>
    </li>
  );
});
