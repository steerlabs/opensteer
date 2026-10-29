import { useEffect, useRef } from "react";
import "./streamed-context-menu.css";
export type StreamedMenuAction =
  "cut" | "copy" | "paste" | "select-all" | "copy-link" | "open-link";
export function StreamedContextMenu({
  left,
  top,
  editable,
  selection,
  canCut = true,
  linkUrl,
  onAction,
  onDismiss,
}: {
  readonly left: number;
  readonly top: number;
  readonly editable: boolean;
  readonly selection: boolean;
  readonly canCut?: boolean;
  readonly linkUrl?: string | undefined;
  readonly onAction: (action: StreamedMenuAction) => void;
  readonly onDismiss: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onDismiss();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [onDismiss]);
  const items: readonly { label: string; action: StreamedMenuAction; disabled?: boolean }[] = [
    { label: "Cut", action: "cut", disabled: !canCut || !editable || !selection },
    { label: "Copy", action: "copy", disabled: !selection },
    { label: "Paste", action: "paste", disabled: !editable },
    { label: "Select All", action: "select-all" },
    ...(linkUrl
      ? [
          { label: "Copy Link Address", action: "copy-link" as const },
          { label: "Open Link in New Tab", action: "open-link" as const },
        ]
      : []),
  ];
  return (
    <div
      aria-label="Page actions"
      className="streamed-context-menu"
      ref={menu}
      role="menu"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
          return;
        }
        if (
          event.key !== "ArrowDown" &&
          event.key !== "ArrowUp" &&
          event.key !== "Home" &&
          event.key !== "End"
        )
          return;
        event.preventDefault();
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        ];
        const index = buttons.findIndex((button) => button === document.activeElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}
    >
      {items.map((item) => (
        <button
          disabled={item.disabled}
          key={item.action}
          onClick={() => onAction(item.action)}
          role="menuitem"
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
