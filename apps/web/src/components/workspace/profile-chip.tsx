import { useRef, useState } from "react";
import { deviceElsewhere } from "@opensteer/client/computers";
import type { HostClient, HostSnapshot, PlaceItem } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import { DeviceLabel } from "../computers/device-label.js";
import { useHereId } from "../computers/here.js";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { ProfileAvatar, browserWords, type BrowserPresentation } from "./identity.js";
import { OpenInRow } from "./open-in.js";

/**
 * The omnibox's first word: who this page browses as. Its menu names the
 * computer and offers the page to another identity.
 */
export function ProfileChip({
  disabled,
  hostClient,
  onManageProfiles,
  place,
  presentation,
}: {
  readonly disabled: boolean;
  readonly hostClient: HostClient;
  readonly onManageProfiles: () => void;
  readonly place: PlaceItem | null;
  readonly presentation: BrowserPresentation;
}) {
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const hereId = useHereId();
  const machines = useHostSelector(hostClient, selectMachines);
  const device = deviceElsewhere(machines, presentation.computerId, hereId);
  const whole = browserWords(presentation, hereId);
  const guest = presentation.identity.kind === "guest";
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Using ${presentation.identity.name}. Profile options`}
        className={open ? "profile-chip is-open" : "profile-chip"}
        onClick={() => setOpen((value) => !value)}
        ref={chipRef}
        title={presentation.identity.name}
        type="button"
      >
        <ProfileAvatar identity={presentation.identity} size={16} />
        <span className="profile-chip__name" title={presentation.identity.name}>
          {presentation.identity.name}
        </span>
      </button>
      {open && chipRef.current ? (
        <Popover
          anchor={chipRef.current}
          className="popover--surface popover--chip"
          label={`Using ${whole}`}
          onClose={() => setOpen(false)}
        >
          <div className="chip-menu__head">
            <ProfileAvatar identity={presentation.identity} size={26} />
            <span className="chip-menu__words">
              <span className="chip-menu__using" title={presentation.identity.name}>
                Using {presentation.identity.name}
              </span>
              {device ? <DeviceLabel className="chip-menu__where" device={device} /> : null}
            </span>
          </div>
          {guest ? (
            <p className="chip-menu__note">
              Started without saved sign-ins. Sign-ins aren’t saved when this browser closes.
            </p>
          ) : null}
          <div className="picker__section">
            {place ? (
              <OpenInRow
                disabled={disabled}
                hostClient={hostClient}
                onDone={() => setOpen(false)}
                place={place}
                presentation={presentation}
              />
            ) : null}
            <button
              className="picker__row"
              onClick={() => {
                setOpen(false);
                onManageProfiles();
              }}
              role="menuitem"
              type="button"
            >
              <span className="picker__check picker__check--icon">
                <Icon name="settings" />
              </span>
              <span className="picker__label">Manage profiles…</span>
            </button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;
