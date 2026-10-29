import { useCallback, useRef, useState } from "react";
import { Icon, type IconName } from "./icon.js";
import { Popover } from "./popover.js";

export interface SurfaceMenuItem {
  readonly danger?: boolean;
  readonly detail?: string | undefined;
  readonly disabled?: boolean;
  readonly icon: IconName;
  readonly label: string;
  readonly onSelect?: (() => void) | undefined;
}

/**
 * A page's or an app's own actions, behind one ⋯ so its row keeps to the
 * controls used every minute. Switching to another page is the grid's job,
 * never this menu's.
 */
export function SurfaceMenu({
  buttonRef,
  items,
  label,
  onOpen,
}: {
  /** Given the menu's button, for what an item opens to hang from it in turn. */
  readonly buttonRef?: ((button: HTMLButtonElement | null) => void) | undefined;
  readonly items: readonly SurfaceMenuItem[];
  readonly label: string;
  readonly onOpen?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const setButton = useCallback(
    (button: HTMLButtonElement | null) => {
      anchorRef.current = button;
      buttonRef?.(button);
    },
    [buttonRef],
  );
  const close = () => setOpen(false);
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={open ? "icon-btn surface-menu is-open" : "icon-btn surface-menu"}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        ref={setButton}
        title={label}
        type="button"
      >
        <Icon name="more" />
      </button>
      {open && anchorRef.current ? (
        <Popover
          anchor={anchorRef.current}
          className="popover--surface"
          label={label}
          onClose={close}
        >
          <div className="picker__section">
            {items.map((item) => (
              <SurfaceMenuRow
                item={item}
                key={item.label}
                onChoose={() => {
                  close();
                  item.onSelect?.();
                }}
              />
            ))}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

/** One action in a page's, an app's or a tab's menu. */
export function SurfaceMenuRow({
  item,
  onChoose,
}: {
  readonly item: SurfaceMenuItem;
  readonly onChoose: () => void;
}) {
  return (
    <button
      className={item.danger ? "picker__row picker__row--danger" : "picker__row"}
      disabled={item.disabled}
      onClick={onChoose}
      role="menuitem"
      type="button"
    >
      <span className="picker__check picker__check--icon">
        <Icon name={item.icon} />
      </span>
      <span className="picker__label-stack">
        <span className="picker__label">{item.label}</span>
        {item.detail ? <span className="picker__detail">{item.detail}</span> : null}
      </span>
    </button>
  );
}
