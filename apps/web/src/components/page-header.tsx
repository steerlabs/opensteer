import type { ReactNode } from "react";
import { Icon } from "./icon.js";
import { SidebarRestoreButton } from "./sidebar-chrome.js";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";

/**
 * Routed pages own their titlebar so desktop drag regions never overlay page
 * controls. A page with its own desktop header uses `mobileOnly` to avoid two
 * titlebars. In a web browser this bar only appears below the sidebar breakpoint.
 *
 * `trailing` keeps the title optically centred — pass a control, or nothing and
 * the slot holds its own width.
 */
export function PageTopbar({
  mobileOnly = false,
  onOpenNavigation,
  title,
  trailing,
}: {
  readonly mobileOnly?: boolean;
  readonly onOpenNavigation: () => void;
  readonly title: ReactNode;
  readonly trailing?: ReactNode;
}) {
  const attention = useOptionalWorkspace()?.attention ?? 0;
  return (
    <header className={mobileOnly ? "topbar topbar--mobile-only" : "topbar"}>
      <SidebarRestoreButton />
      <button
        aria-label={attention > 0 ? `Open navigation, ${attention} need you` : "Open navigation"}
        className="icon-btn topbar__navigation"
        onClick={onOpenNavigation}
        type="button"
      >
        <Icon name="panel" />
        {attention > 0 ? (
          <span aria-hidden className="side-needs side-needs--inline">
            <span className="side-needs__bang">!</span>
            {attention}
          </span>
        ) : null}
      </button>
      <span className="topbar__title">{title}</span>
      {trailing ?? <span aria-hidden className="icon-btn" />}
    </header>
  );
}

/**
 * The heading block at the top of a routed page: an optional way back, the
 * category this page belongs to, its name, and one sentence saying what it is
 * for.
 *
 * `eyebrow` names the category — "Messaging", "Automation",
 * "Connections" —
 * not the page and not a place. It is what tells a reader where in the product
 * they have landed, so it stays a short noun phrase.
 */
export function PageHeader({
  back,
  className,
  description,
  eyebrow,
  title,
}: {
  /** A link back to the parent surface, rendered above the eyebrow. */
  readonly back?: ReactNode;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
}) {
  return (
    <header className={className ? `page__header ${className}` : "page__header"}>
      {back}
      {eyebrow ? <p className="eyebrow eyebrow--accent">{eyebrow}</p> : null}
      <h1 className="page__title">{title}</h1>
      {description ? <p className="page__description">{description}</p> : null}
    </header>
  );
}
