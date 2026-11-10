import type { ProfileHomeChoice } from "@opensteer/client/host";
import { useRef, useState } from "react";
import { computerIcon } from "./computers/device-art.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";

/** The device a new profile keeps its sign-ins on, chosen inside its name field. */
export function ProfileHomeControl({
  disabled,
  home,
  homes,
  onChoose,
}: {
  readonly disabled: boolean;
  readonly home: string;
  readonly homes: ProfileHomeChoice;
  readonly onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const chosen = homes.options.find(({ id }) => id === home)!;
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Keep its sign-ins on ${chosen.name}. Change`}
        className={open ? "profile-name-field__home is-open" : "profile-name-field__home"}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        ref={buttonRef}
        title={chosen.name}
        type="button"
      >
        <Icon name={computerIcon(chosen.glyph)} />
        <span className="profile-name-field__home-name">{chosen.name}</span>
        <Icon className="profile-name-field__chevron" name="chevron-down" />
      </button>
      {open && buttonRef.current ? (
        <Popover
          align="end"
          anchor={buttonRef.current}
          below
          className="popover--surface popover--profile-home"
          label="Keep its sign-ins on"
          onClose={() => setOpen(false)}
          returnFocusTo={buttonRef.current}
        >
          <div className="picker__section">
            <span aria-hidden className="picker__heading">
              Keep its sign-ins on
            </span>
            {homes.options.map((option) => (
              <button
                aria-checked={option.id === home}
                className="picker__row"
                key={option.id}
                onClick={() => {
                  setOpen(false);
                  onChoose(option.id);
                }}
                role="menuitemradio"
                type="button"
              >
                <span className="picker__check">
                  {option.id === home ? <Icon name="check" /> : null}
                </span>
                <span className="picker__glyph">
                  <Icon name={computerIcon(option.glyph)} />
                </span>
                <span className="picker__label">{option.name}</span>
              </button>
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
