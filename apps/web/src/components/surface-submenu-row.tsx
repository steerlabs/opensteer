import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icon.js";
import { Popover } from "./popover.js";

export function SurfaceSubmenuRow({
  children,
  disabled = false,
  icon,
  label,
  menuLabel = label,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly icon: IconName;
  readonly label: string;
  readonly menuLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const parent = rowRef.current?.closest<HTMLElement>(".popover") ?? null;
  // Moving to another row dismisses the flyout without closing its parent menu.
  useEffect(() => {
    if (!open || !parent) return;
    const away = (event: PointerEvent) => {
      const row = event.target instanceof Element ? event.target.closest(".picker__row") : null;
      if (row && row !== rowRef.current && parent.contains(row)) setOpen(false);
    };
    parent.addEventListener("pointerover", away);
    return () => parent.removeEventListener("pointerover", away);
  }, [open, parent]);
  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={open ? "picker__row is-open" : "picker__row"}
        data-submenu=""
        disabled={disabled}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        onPointerEnter={() => setOpen(true)}
        ref={rowRef}
        role="menuitem"
        type="button"
      >
        <span className="picker__check picker__check--icon">
          <Icon name={icon} />
        </span>
        <span className="picker__label">{label}</span>
        <Icon className="picker__submenu-mark" name="chevron-right" />
      </button>
      {open && rowRef.current && parent ? (
        <Popover
          anchor={rowRef.current}
          className="popover--surface popover--submenu"
          label={menuLabel}
          onClose={() => setOpen(false)}
          parent={parent}
        >
          <div
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }}
          >
            {children}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
