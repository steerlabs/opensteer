import { useState } from "react";
import type { HostClient, PlaceItem } from "@opensteer/client/host";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { PlaceMark } from "./place-mark.js";

/** The places a message can carry, in the sidebar's order, filtered by what was typed. */
export function pickablePlaces(places: readonly PlaceItem[], query: string): readonly PlaceItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return places.filter(
    (place) =>
      place.availability !== "unavailable" &&
      (!needle ||
        place.title.toLocaleLowerCase().includes(needle) ||
        (place.site ?? "").toLocaleLowerCase().includes(needle) ||
        (place.device?.name ?? "").toLocaleLowerCase().includes(needle)),
  );
}

function PlaceRow({
  active = false,
  hostClient,
  onPick,
  place,
  role,
}: {
  readonly active?: boolean;
  readonly hostClient: HostClient;
  readonly onPick: (place: PlaceItem) => void;
  readonly place: PlaceItem;
  readonly role: "menuitem" | "option";
}) {
  return (
    <button
      aria-selected={role === "option" ? active : undefined}
      className={active ? "picker__row place-pick is-active" : "picker__row place-pick"}
      onClick={() => onPick(place)}
      onMouseDown={(event) => {
        // The textarea keeps the caret while a row is chosen with the pointer.
        if (role === "option") event.preventDefault();
      }}
      role={role}
      tabIndex={role === "option" ? -1 : undefined}
      type="button"
    >
      <PlaceMark hostClient={hostClient} icon={place.icon} />
      <span className="place-pick__title">{place.title}</span>
      {place.device && place.device.name !== place.title ? (
        <span className="place-pick__device">{place.device.name}</span>
      ) : null}
    </button>
  );
}

/**
 * `+`: a small field that filters the places as `@` does, the places in the
 * sidebar's order under it, and "Files…" pinned at the foot.
 */
export function AttachMenu({
  anchor,
  hostClient,
  onClose,
  onFiles,
  onPick,
  places,
}: {
  readonly anchor: HTMLElement;
  readonly hostClient: HostClient;
  readonly onClose: () => void;
  readonly onFiles: (() => void) | null;
  readonly onPick: (place: PlaceItem) => void;
  readonly places: readonly PlaceItem[];
}) {
  const [query, setQuery] = useState("");
  const shown = pickablePlaces(places, query);
  const pick = (place: PlaceItem) => {
    onClose();
    onPick(place);
  };
  const any = pickablePlaces(places, "").length > 0;
  return (
    <Popover
      anchor={anchor}
      className="popover--surface popover--attach"
      label="Attach"
      onClose={onClose}
    >
      {any ? (
        <div className="place-pick__search">
          <Icon name="search" />
          <input
            aria-label="Search tabs"
            data-autofocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && shown[0]) {
                event.preventDefault();
                pick(shown[0]);
              }
            }}
            placeholder="Search tabs…"
            type="text"
            value={query}
          />
        </div>
      ) : null}
      {any ? (
        <div className="picker__section place-pick__list">
          {shown.map((place) => (
            <PlaceRow
              hostClient={hostClient}
              key={place.key}
              onPick={pick}
              place={place}
              role="menuitem"
            />
          ))}
          {shown.length === 0 ? (
            <p className="picker__empty">No tabs match “{query.trim()}”.</p>
          ) : null}
        </div>
      ) : null}
      {onFiles ? (
        <div className="picker__section place-pick__files">
          <button
            className="picker__row"
            onClick={() => {
              onClose();
              onFiles();
            }}
            role="menuitem"
            type="button"
          >
            <span className="picker__check picker__check--icon">
              <Icon name="paperclip" />
            </span>
            <span className="picker__label">Files…</span>
          </button>
        </div>
      ) : null}
    </Popover>
  );
}

/** The tallest the `@` list grows, with the gap it keeps from the words (see `.mention-list`). */
export const mentionListHeight = 246;

/**
 * How much of the screen is free above and below the box the `@` list opens
 * from, inside every scrolling box around it.
 */
export function mentionRoom(frame: HTMLElement): {
  readonly above: number;
  readonly below: number;
} {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = frame.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "visible") continue;
    const box = node.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  const box = frame.getBoundingClientRect();
  return { above: box.top - top, below: bottom - box.bottom };
}
