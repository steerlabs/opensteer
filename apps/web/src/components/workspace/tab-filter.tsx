import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  allTabs,
  placeHasAgents,
  sameIdentity,
  tabFilterActive,
  tabFilterWords,
  tabMatchesFilter,
  type PlaceBrowserIdentity,
  type PlaceItem,
  type TabFilter,
  type TabFilterDevice,
} from "@opensteer/client/host";
import { computerIcon } from "../computers/device-art.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { ProfileAvatar } from "./identity.js";

/**
 * Narrows the tab list to the tabs agents are in, one device's, one profile's,
 * or any mix. Each count is what choosing that row would list, given the other
 * choices. Shown while there is something to narrow: two devices, two
 * profiles, or an agent in a tab; and while it narrows, so the way back stays.
 */
export function TabFilterControl({
  devices,
  onChange,
  places,
  value,
}: {
  /** The devices to narrow to, from `tabDeviceChoice`; empty while there is only one. */
  readonly devices: readonly TabFilterDevice[];
  readonly onChange: (filter: TabFilter) => void;
  readonly places: readonly PlaceItem[];
  readonly value: TabFilter;
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
  if (profiles.length < 2 && devices.length === 0 && !places.some(placeHasAgents) && !active)
    return null;
  // A profile with no tabs remains selected until the person clears it.
  const listed = profiles.find(
    (identity) => value.profile && sameIdentity(identity, value.profile),
  );
  const profileOptions = value.profile && !listed ? [...profiles, value.profile] : profiles;
  const profile = listed ?? value.profile;
  const device = devices.find(({ id }) => id === value.device) ?? null;
  const count = (next: TabFilter) => places.filter((place) => tabMatchesFilter(place, next)).length;
  const choose = (next: TabFilter) => {
    const heading = anchor.current?.closest(".side-head")?.querySelector("h2");
    setOpen(false);
    onChange(next);
    requestAnimationFrame(() => {
      if (anchor.current?.isConnected) anchor.current.focus();
      else heading?.focus();
    });
  };
  const row = (
    key: string,
    label: string,
    checked: boolean,
    tabs: number,
    next: TabFilter,
    lead?: ReactNode,
    note?: string,
  ) => (
    <button
      aria-checked={checked}
      aria-description={`${tabs} tabs`}
      aria-label={note ? `${label}, ${note}` : label}
      className="picker__row"
      key={key}
      onClick={() => choose(next)}
      role="menuitemradio"
      type="button"
    >
      <span className="picker__check">{checked ? <Icon name="check" /> : null}</span>
      {lead}
      <span className="picker__label">
        {label}
        {note ? <span className="side-tab-filter__note"> · {note}</span> : null}
      </span>
      <span className="side-tab-filter__count">{tabs}</span>
    </button>
  );
  const words = tabFilterWords({ ...value, profile }, device?.name ?? null);
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={active ? `Filter tabs: ${words}` : "Filter tabs"}
        className={`icon-btn side-head__action side-tab-filter${active ? " is-active" : ""}`}
        onClick={() => setOpen(!open)}
        ref={anchor}
        title={active ? `Showing: ${words}` : "Filter tabs"}
        type="button"
      >
        {profile ? <ProfileAvatar identity={profile} size={14} /> : null}
        {device ? <Icon name={computerIcon(device.glyph)} /> : null}
        {active ? (
          <span>{value.agents ? "With agents" : (device?.name ?? profile?.name)}</span>
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
            {row("all", "All tabs", !value.agents, count({ ...value, agents: false }), {
              ...value,
              agents: false,
            })}
            {row("agents", "Tabs with agents", value.agents, count({ ...value, agents: true }), {
              ...value,
              agents: true,
            })}
          </div>
          {devices.length > 0 ? (
            <div aria-label="Device" className="picker__section" role="group">
              {row(
                "device:all",
                "All devices",
                value.device === null,
                count({ ...value, device: null }),
                { ...value, device: null },
              )}
              {devices.map((option) =>
                row(
                  `device:${option.id}`,
                  option.name,
                  option.id === value.device,
                  option.count,
                  { ...value, device: option.id },
                  <span className="picker__glyph">
                    <Icon name={computerIcon(option.glyph)} />
                  </span>,
                  option.online ? undefined : "Offline",
                ),
              )}
            </div>
          ) : null}
          {profileOptions.length > 1 || value.profile ? (
            <div aria-label="Profile" className="picker__section" role="group">
              {row(
                "profile:all",
                "All profiles",
                !value.profile,
                count({ ...value, profile: null }),
                { ...value, profile: null },
              )}
              {profileOptions.map((option) =>
                row(
                  `profile:${option.kind === "guest" ? "guest" : option.profileId}`,
                  option.name,
                  value.profile !== null && sameIdentity(option, value.profile),
                  count({ ...value, profile: option }),
                  { ...value, profile: option },
                  <ProfileAvatar identity={option} size={16} />,
                ),
              )}
            </div>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}
