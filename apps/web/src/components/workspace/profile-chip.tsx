import { useRef, useState } from "react";
import type { HostClient, PlaceItem } from "@opensteer/client/host";
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
  const whole = browserWords(presentation);
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
              <span className="chip-menu__where">
                <Icon name="laptop" />
                {presentation.computer}
              </span>
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
