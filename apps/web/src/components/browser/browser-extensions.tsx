import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type {
  DesktopBrowserExtension,
  DesktopBrowserExtensionAction,
  DesktopBrowserExtensions,
  DesktopBrowserPresentationBridge,
  DesktopBrowserPresentationTarget,
} from "@opensteer/protocol/desktop";
import { Icon } from "../icon.js";
import { Popover } from "../popover.js";
import { SurfaceMenuRow } from "../surface-menu.js";

export const chromeWebStoreUrl = "https://chromewebstore.google.com/";

/** Toolbar buttons beside the Extensions menu; the rest are a click away in it. */
export const maxInlineActions = 4;

type ActivationEvent = "click" | "contextmenu";

function sameAction(
  left: DesktopBrowserExtensionAction | null,
  right: DesktopBrowserExtensionAction | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.title === right.title &&
    left.badgeText === right.badgeText &&
    left.badgeColor === right.badgeColor &&
    left.icon === right.icon &&
    left.hasPopup === right.hasPopup
  );
}

/** Equal replies keep the rendered list, so a burst of `extensions` events re-renders nothing. */
export function sameExtensions(
  left: DesktopBrowserExtensions | null,
  right: DesktopBrowserExtensions | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.extensions.length !== right.extensions.length) return false;
  return left.extensions.every((extension, index) => {
    const other = right.extensions[index];
    return (
      other !== undefined &&
      extension.id === other.id &&
      extension.name === other.name &&
      extension.version === other.version &&
      extension.icon === other.icon &&
      extension.optionsUrl === other.optionsUrl &&
      extension.unpacked === other.unpacked &&
      sameAction(extension.action, other.action)
    );
  });
}

/** The button's box in window DIPs, which is what main anchors the popup to. */
function anchorRect(element: HTMLElement, appZoomFactor: number) {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x * appZoomFactor,
    y: rect.y * appZoomFactor,
    width: rect.width * appZoomFactor,
    height: rect.height * appZoomFactor,
  };
}

function monogram(name: string): string {
  const letter = [...name.trim()][0];
  return letter ? letter.toLocaleUpperCase() : "";
}

/** The extension's mark at 16px: its page-specific action icon, its own, or its initial. */
function ExtensionIcon({
  className,
  extension,
}: {
  readonly className: string;
  readonly extension: DesktopBrowserExtension;
}) {
  const src = extension.action?.icon ?? extension.icon;
  if (src) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className={className}
        draggable={false}
        height={16}
        src={src}
        width={16}
      />
    );
  }
  const letter = monogram(extension.name);
  return (
    <span
      aria-hidden="true"
      className={`${className} browser-extension-mark${letter ? "" : " browser-extension-mark--blank"}`}
    >
      {letter || <Icon name="puzzle" />}
    </span>
  );
}

/**
 * Toolbar buttons and the Extensions menu for a native desktop browser page.
 * Renders nothing where the page's profile keeps no extensions (Guest).
 */
export function BrowserExtensions({
  appZoomFactor,
  bridge,
  onOpenTab,
  onReportError,
  target,
}: {
  readonly appZoomFactor: number;
  readonly bridge: DesktopBrowserPresentationBridge;
  readonly onOpenTab: (url: string) => void;
  readonly onReportError?: ((error: unknown) => void) | undefined;
  readonly target: DesktopBrowserPresentationTarget | null;
}) {
  const presentationId = target?.presentationId ?? null;
  const revision = target?.revision ?? null;
  const [loaded, setLoaded] = useState<{
    readonly presentationId: string;
    readonly data: DesktopBrowserExtensions | null;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [submenuId, setSubmenuId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!presentationId || revision === null || !bridge.extensions) return;
    const read = bridge.extensions;
    let active = true;
    let sequence = 0;
    const load = () => {
      const request = ++sequence;
      read({ presentationId, revision }).then(
        (next) => {
          // A reply for an older read, revision or page never replaces a newer one.
          if (!active || request !== sequence) return;
          setLoaded((current) =>
            current?.presentationId === presentationId && sameExtensions(current.data, next)
              ? current
              : { presentationId, data: next },
          );
        },
        () => undefined,
      );
    };
    load();
    const unsubscribe = bridge.onEvent((event) => {
      if (event.type === "extensions" && event.presentationId === presentationId) load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, presentationId, revision]);

  // Another page's menu never stays open over this one.
  useEffect(() => {
    setOpen(false);
    setSubmenuId(null);
  }, [presentationId]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setSubmenuId(null);
  }, []);

  // Only the presented page's own list shows; another page's waits for its read.
  const data = loaded && loaded.presentationId === presentationId ? loaded.data : null;
  if (!data || !presentationId || revision === null) return null;

  const activateExtension = bridge.activateExtension?.bind(bridge);
  const removeExtension = bridge.removeExtension?.bind(bridge);
  const inline = data.extensions
    .filter((extension) => extension.action !== null)
    .slice(0, maxInlineActions);

  const activate = (extensionId: string, eventType: ActivationEvent, anchor: HTMLElement) => {
    if (!activateExtension) return;
    activateExtension({
      presentationId,
      revision,
      extensionId,
      eventType,
      anchorRect: anchorRect(anchor, appZoomFactor),
    }).catch((error: unknown) => onReportError?.(error));
  };

  const openTab = (url: string) => {
    closeMenu();
    onOpenTab(url);
  };

  const remove = (extensionId: string) => {
    closeMenu();
    removeExtension?.({ presentationId, revision, extensionId }).catch((error: unknown) =>
      onReportError?.(error),
    );
  };

  return (
    <div className="browser-extensions">
      {activateExtension
        ? inline.map((extension) => {
            const action = extension.action!;
            const label = action.title || extension.name;
            return (
              <button
                aria-label={label}
                className="icon-btn surface-menu browser-extension-btn"
                key={extension.id}
                onClick={(event: MouseEvent<HTMLButtonElement>) =>
                  activate(extension.id, "click", event.currentTarget)
                }
                onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  activate(extension.id, "contextmenu", event.currentTarget);
                }}
                title={label}
                type="button"
              >
                <ExtensionIcon className="browser-extension-btn__icon" extension={extension} />
                {action.badgeText ? (
                  <span
                    aria-hidden="true"
                    className={`browser-extension-btn__badge${action.badgeColor ? " has-color" : ""}`}
                    style={action.badgeColor ? { backgroundColor: action.badgeColor } : undefined}
                  >
                    {action.badgeText}
                  </span>
                ) : null}
              </button>
            );
          })
        : null}
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Extensions"
        className={`icon-btn surface-menu browser-extensions-trigger${open ? " is-open" : ""}`}
        onClick={() => {
          if (open) closeMenu();
          else setOpen(true);
        }}
        ref={triggerRef}
        title="Extensions"
        type="button"
      >
        <Icon name="puzzle" />
      </button>
      {open && triggerRef.current ? (
        <Popover
          align="end"
          anchor={triggerRef.current}
          below
          className="popover--surface popover--extensions"
          id={menuId}
          label="Extensions"
          onClose={closeMenu}
          role="menu"
        >
          {data.extensions.length === 0 ? (
            <div className="browser-extensions__empty">
              <span aria-hidden="true" className="browser-extensions__empty-mark">
                <Icon name="puzzle" />
              </span>
              <span className="browser-extensions__empty-title">No extensions yet</span>
              <span className="browser-extensions__empty-detail">
                Add tools to this profile from the Chrome Web Store.
              </span>
            </div>
          ) : (
            <div className="picker__section browser-extensions__list">
              {data.extensions.map((extension) => (
                <ExtensionMenuRow
                  extension={extension}
                  key={extension.id}
                  onActivate={
                    activateExtension && extension.action
                      ? () => {
                          const anchor = triggerRef.current;
                          closeMenu();
                          if (anchor) activate(extension.id, "click", anchor);
                        }
                      : undefined
                  }
                  onOpenOptions={openTab}
                  onRemove={removeExtension ? () => remove(extension.id) : undefined}
                  onSubmenuChange={(next) => setSubmenuId(next ? extension.id : null)}
                  submenuOpen={submenuId === extension.id}
                />
              ))}
            </div>
          )}
          <div className="picker__section">
            <SurfaceMenuRow
              item={{ icon: "external-link", label: "Chrome Web Store" }}
              onChoose={() => {
                if (bridge.openExtensionStore) {
                  closeMenu();
                  bridge
                    .openExtensionStore({ presentationId, revision })
                    .catch((error: unknown) => onReportError?.(error));
                } else {
                  openTab(chromeWebStoreUrl);
                }
              }}
            />
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

function ExtensionMenuRow({
  extension,
  onActivate,
  onOpenOptions,
  onRemove,
  onSubmenuChange,
  submenuOpen,
}: {
  readonly extension: DesktopBrowserExtension;
  readonly onActivate: (() => void) | undefined;
  readonly onOpenOptions: (url: string) => void;
  readonly onRemove: (() => void) | undefined;
  readonly onSubmenuChange: (open: boolean) => void;
  readonly submenuOpen: boolean;
}) {
  const mainRef = useRef<HTMLElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const submenuId = useId();
  const { optionsUrl } = extension;
  const hasActions = optionsUrl !== null || onRemove !== undefined;
  const parent = moreRef.current?.closest<HTMLElement>(".popover") ?? null;

  const openSubmenu = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowRight" || !hasActions) return;
    event.preventDefault();
    event.stopPropagation();
    onSubmenuChange(true);
  };

  const content = (
    <>
      <ExtensionIcon className="browser-extension-row__icon" extension={extension} />
      <span className="picker__label-stack">
        <span className="picker__label" title={extension.name}>
          {extension.name}
        </span>
        {extension.unpacked ? (
          <span className="picker__detail browser-extension-row__source">
            Not from Chrome Web Store
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <div className={`browser-extension-row${submenuOpen ? " is-open" : ""}`}>
      {onActivate ? (
        <button
          className="picker__row browser-extension-row__main"
          onClick={onActivate}
          onKeyDown={openSubmenu}
          ref={(element) => {
            mainRef.current = element;
          }}
          role="menuitem"
          type="button"
        >
          {content}
        </button>
      ) : (
        <div
          className="picker__row browser-extension-row__main browser-extension-row__main--static"
          ref={(element) => {
            mainRef.current = element;
          }}
        >
          {content}
        </div>
      )}
      {hasActions ? (
        <button
          aria-controls={submenuOpen ? submenuId : undefined}
          aria-expanded={submenuOpen}
          aria-haspopup="menu"
          aria-label={`More actions for ${extension.name}`}
          className={`icon-btn icon-btn--small browser-extension-row__more${submenuOpen ? " is-open" : ""}`}
          onClick={() => onSubmenuChange(!submenuOpen)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" && mainRef.current instanceof HTMLButtonElement) {
              event.preventDefault();
              event.stopPropagation();
              mainRef.current.focus();
              return;
            }
            openSubmenu(event);
          }}
          ref={moreRef}
          role="menuitem"
          title="More actions"
          type="button"
        >
          <Icon name="more" />
        </button>
      ) : null}
      {submenuOpen && moreRef.current && parent ? (
        <Popover
          anchor={moreRef.current}
          className="popover--surface popover--submenu popover--extension-actions"
          id={submenuId}
          label={`${extension.name} actions`}
          onClose={() => onSubmenuChange(false)}
          parent={parent}
          role="menu"
        >
          <div
            className="picker__section"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft") return;
              event.preventDefault();
              event.stopPropagation();
              onSubmenuChange(false);
            }}
          >
            {optionsUrl ? (
              <SurfaceMenuRow
                item={{ icon: "settings", label: "Options" }}
                onChoose={() => onOpenOptions(optionsUrl)}
              />
            ) : null}
            {onRemove ? (
              <SurfaceMenuRow
                item={{ danger: true, icon: "trash", label: "Remove" }}
                onChoose={onRemove}
              />
            ) : null}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
