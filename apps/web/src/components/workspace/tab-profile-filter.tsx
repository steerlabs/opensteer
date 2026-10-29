import { useRef, useState } from "react";
import type { PlaceBrowserIdentity, PlaceItem } from "@opensteer/client/host";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { ProfileAvatar } from "./identity.js";

export interface TabProfileChoice {
  readonly identity: PlaceBrowserIdentity;
  readonly count: number;
}

export function tabMatchesProfile(place: PlaceItem, profile: PlaceBrowserIdentity): boolean {
  return place.identity?.kind === "guest"
    ? profile.kind === "guest"
    : place.identity?.kind === "profile" &&
        profile.kind === "profile" &&
        place.identity.profileId === profile.profileId;
}

/** Count all tabs, including suspended tabs and collapsed groups, by identity rather than name. */
export function tabProfileChoices(places: readonly PlaceItem[]): TabProfileChoice[] {
  const profiles = new Map<string, TabProfileChoice>();
  for (const place of places) {
    const identity = place.identity;
    if (!identity) continue;
    const key = identity.kind === "guest" ? "guest" : identity.profileId;
    profiles.set(key, { identity, count: (profiles.get(key)?.count ?? 0) + 1 });
  }
  return [...profiles.values()];
}

export function TabProfileFilter({
  choices,
  onChange,
  value,
}: {
  readonly choices: readonly TabProfileChoice[];
  readonly onChange: (identity: PlaceBrowserIdentity | null) => void;
  readonly value: PlaceBrowserIdentity | null;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const same = (identity: PlaceBrowserIdentity) =>
    value?.kind === "guest"
      ? identity.kind === "guest"
      : value?.kind === "profile" &&
        identity.kind === "profile" &&
        identity.profileId === value.profileId;
  const selected = choices.find(({ identity }) => same(identity));
  // A profile with no tabs remains selected until the person clears it.
  const options = value && !selected ? [...choices, { identity: value, count: 0 }] : choices;
  const identity = selected?.identity ?? value;
  if (choices.length < 2 && !value) return null;
  const choose = (next: PlaceBrowserIdentity | null) => {
    const heading = anchor.current?.closest(".side-head")?.querySelector("h2");
    setOpen(false);
    onChange(next);
    requestAnimationFrame(() => {
      if (anchor.current?.isConnected) anchor.current.focus();
      else heading?.focus();
    });
  };
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          identity ? `Filter tabs by profile: ${identity.name}` : "Filter tabs by profile"
        }
        className={`icon-btn side-head__action side-profile-filter${identity ? " is-active" : ""}`}
        onClick={() => setOpen(!open)}
        ref={anchor}
        title={identity ? `Showing ${identity.name} tabs` : "Filter tabs by profile"}
        type="button"
      >
        {identity ? <ProfileAvatar identity={identity} size={14} /> : <Icon name="sliders" />}
        {identity ? <span>{identity.name}</span> : null}
      </button>
      {identity ? (
        <button
          aria-label="Clear profile filter"
          className="icon-btn side-head__action side-profile-clear"
          onClick={() => choose(null)}
          title="Show all profiles"
          type="button"
        >
          <Icon name="close" />
        </button>
      ) : null}
      {open && anchor.current ? (
        <Popover
          anchor={anchor.current}
          below
          className="popover--surface"
          label="Filter tabs by profile"
          onClose={() => setOpen(false)}
        >
          <div className="picker__section">
            <button
              aria-checked={!value}
              aria-label="All profiles"
              className="picker__row"
              onClick={() => choose(null)}
              role="menuitemradio"
              type="button"
            >
              <span className="picker__check">{!value ? <Icon name="check" /> : null}</span>
              <span className="picker__label">All profiles</span>
              <span className="side-profile-count">
                {choices.reduce((sum, item) => sum + item.count, 0)}
              </span>
            </button>
            {options.map(({ identity: option, count }) => (
              <button
                aria-checked={same(option)}
                aria-description={`${count} tabs`}
                aria-label={option.name}
                className="picker__row"
                key={option.kind === "guest" ? "guest" : option.profileId}
                onClick={() => choose(option)}
                role="menuitemradio"
                type="button"
              >
                <span className="picker__check">{same(option) ? <Icon name="check" /> : null}</span>
                <ProfileAvatar identity={option} size={16} />
                <span className="picker__label">{option.name}</span>
                <span className="side-profile-count">{count}</span>
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
