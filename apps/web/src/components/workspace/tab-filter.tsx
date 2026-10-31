import { useMemo, useRef, useState } from "react";
import { placeHasAgents, type PlaceBrowserIdentity, type PlaceItem } from "@opensteer/client/host";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { ProfileAvatar } from "./identity.js";

/** Which tabs the sidebar lists: those with agents in them, those in one profile, or both. */
export interface TabFilterValue {
  readonly agents: boolean;
  readonly profile: PlaceBrowserIdentity | null;
}

export const allTabs: TabFilterValue = { agents: false, profile: null };

export function tabFilterActive(filter: TabFilterValue): boolean {
  return filter.agents || filter.profile !== null;
}

function sameIdentity(a: PlaceBrowserIdentity, b: PlaceBrowserIdentity): boolean {
  return a.kind === "guest"
    ? b.kind === "guest"
    : b.kind === "profile" && a.profileId === b.profileId;
}

function inProfile(place: PlaceItem, profile: PlaceBrowserIdentity | null): boolean {
  return !profile || (place.identity !== null && sameIdentity(place.identity, profile));
}

function withAgents(place: PlaceItem, agents: boolean): boolean {
  return !agents || placeHasAgents(place);
}

export function tabMatchesFilter(place: PlaceItem, filter: TabFilterValue): boolean {
  return withAgents(place, filter.agents) && inProfile(place, filter.profile);
}

/** What the list says when the filter leaves no tab in it. */
export function tabFilterEmptyWords(filter: TabFilterValue): string {
  if (filter.agents)
    return filter.profile ? "No tasks are using tabs in this profile." : "No tasks are using tabs.";
  return "No tabs in this profile.";
}

function filterWords(filter: TabFilterValue): string {
  const tabs = filter.profile ? `${filter.profile.name} tabs` : "Tabs";
  return filter.agents ? `${tabs} with agents` : tabs;
}

/**
 * Narrows the tab list to the tabs agents are in, to one profile's, or both.
 * Each count is what choosing that row would list, given the other choice.
 * Shown while there is something to narrow: two profiles, or an agent in a tab.
 */
export function TabFilter({
  onChange,
  places,
  value,
}: {
  readonly onChange: (filter: TabFilterValue) => void;
  readonly places: readonly PlaceItem[];
  readonly value: TabFilterValue;
}) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const profiles = useMemo(() => {
    const found = new Map<string, PlaceBrowserIdentity>();
    for (const { identity } of places)
      if (identity) found.set(identity.kind === "guest" ? "guest" : identity.profileId, identity);
    return [...found.values()];
  }, [places]);
  const active = tabFilterActive(value);
  if (profiles.length < 2 && !places.some(placeHasAgents) && !active) return null;
  // A profile with no tabs remains selected until the person clears it.
  const listed = profiles.find(
    (identity) => value.profile && sameIdentity(identity, value.profile),
  );
  const profileOptions = value.profile && !listed ? [...profiles, value.profile] : profiles;
  const profile = listed ?? value.profile;
  const count = (agents: boolean, of: PlaceBrowserIdentity | null) =>
    places.filter((place) => withAgents(place, agents) && inProfile(place, of)).length;
  const choose = (next: TabFilterValue) => {
    const heading = anchor.current?.closest(".side-head")?.querySelector("h2");
    setOpen(false);
    onChange(next);
    requestAnimationFrame(() => {
      if (anchor.current?.isConnected) anchor.current.focus();
      else heading?.focus();
    });
  };
  const row = (
    label: string,
    checked: boolean,
    tabs: number,
    next: TabFilterValue,
    identity?: PlaceBrowserIdentity,
  ) => (
    <button
      aria-checked={checked}
      aria-description={`${tabs} tabs`}
      aria-label={label}
      className="picker__row"
      key={identity ? (identity.kind === "guest" ? "guest" : identity.profileId) : label}
      onClick={() => choose(next)}
      role="menuitemradio"
      type="button"
    >
      <span className="picker__check">{checked ? <Icon name="check" /> : null}</span>
      {identity ? <ProfileAvatar identity={identity} size={16} /> : null}
      <span className="picker__label">{identity ? identity.name : label}</span>
      <span className="side-tab-filter__count">{tabs}</span>
    </button>
  );
  const words = filterWords({ agents: value.agents, profile });
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={active ? `Filter tabs: ${words}` : "Filter tabs"}
        className={`icon-btn side-head__action side-tab-filter${active ? " is-active" : ""}`}
        onClick={() => setOpen(!open)}
        ref={anchor}
        title={active ? `Showing ${words.toLocaleLowerCase()}` : "Filter tabs"}
        type="button"
      >
        {profile ? <ProfileAvatar identity={profile} size={14} /> : null}
        {active ? (
          <span>{value.agents ? "With agents" : profile?.name}</span>
        ) : (
          <Icon name="sliders" />
        )}
      </button>
      {active ? (
        <button
          aria-label="Clear tab filter"
          className="icon-btn side-head__action side-tab-filter__clear"
          onClick={() => choose(allTabs)}
          title="Show all tabs"
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
          label="Filter tabs"
          onClose={() => setOpen(false)}
        >
          <div aria-label="Agents" className="picker__section" role="group">
            {row("All tabs", !value.agents, count(false, value.profile), {
              ...value,
              agents: false,
            })}
            {row("Tabs with agents", value.agents, count(true, value.profile), {
              ...value,
              agents: true,
            })}
          </div>
          {profileOptions.length > 1 || value.profile ? (
            <div aria-label="Profile" className="picker__section" role="group">
              {row("All profiles", !value.profile, count(value.agents, null), {
                ...value,
                profile: null,
              })}
              {profileOptions.map((option) =>
                row(
                  option.name,
                  value.profile !== null && sameIdentity(option, value.profile),
                  count(value.agents, option),
                  { ...value, profile: option },
                  option,
                ),
              )}
            </div>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}
