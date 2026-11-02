import { observeResize } from "@opensteer/shared/resizeObserver";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, useLocation } from "react-router";
import { useOptionalWorkspace } from "./workspace/workspace-context.js";
import type {
  BrowserSessionSummary,
  RunPage,
  SurfaceDestination,
  TurnApp,
  TurnPhone,
} from "@opensteer/client/host";
import type { ComputerAppIdentity } from "@opensteer/protocol";
import { AppMark } from "./computer-apps/computer-use-section.js";
import { Icon } from "./icon.js";
import { Popover } from "./popover.js";
import { SiteMark } from "./site-mark.js";

/** One page, Mac app or phone a message names, and exactly where it opens. */
export interface ChipSurface {
  readonly key: string;
  readonly title: string;
  /** The page's site; null for an app. */
  readonly site: string | null;
  /** The open page's site icon, when its browser has one. */
  readonly favicon?: string | null;
  /** Present for a Mac app. */
  readonly app?: ComputerAppIdentity;
  /** A phone's whole screen. */
  readonly phone?: true;
  /** Null once nothing is left to open: an app or phone the agent finished with. */
  readonly destination: SurfaceDestination | null;
  /** The browser closed, or the agent finished with the app or phone. */
  readonly ended: boolean;
  /** Ended because the browser stopped working, not because it was closed. */
  readonly failed?: boolean;
  readonly acting: boolean;
}

/** A Run's page as a chip, told apart by whether its browser closed or stopped working. */
export function pageChip(page: RunPage, sessions: readonly BrowserSessionSummary[]): ChipSurface {
  return {
    acting: page.acting,
    destination: page.destination,
    ended: page.ended,
    failed:
      page.ended &&
      sessions.some(
        (session) => session.id === page.destination.sessionId && session.state === "failed",
      ),
    favicon: page.favicon,
    key: page.key,
    site: page.site,
    title: page.title,
  };
}

/** A Mac app a reply's steps worked in, as a chip. */
export function appChip(app: TurnApp): ChipSurface {
  return {
    acting: app.acting,
    app: app.app,
    destination: app.destination,
    ended: app.ended,
    key: app.key,
    site: null,
    title: app.title,
  };
}

/** A phone a reply's steps worked on, as a chip. */
export function phoneChip(phone: TurnPhone): ChipSurface {
  return {
    acting: phone.acting,
    destination: phone.destination,
    ended: phone.ended,
    key: phone.key,
    phone: true,
    site: null,
    title: phone.title,
  };
}

/**
 * One page, app or phone as a chip that opens exactly it in the stage. A green dot
 * says an agent is acting there now. A closed one stays, muted, and opens
 * nothing; nothing else is put in its place.
 */
export function SurfaceChip({
  surface,
  withSite = false,
}: {
  readonly surface: ChipSurface;
  /** Says the site after the title, where the chip stands alone. */
  readonly withSite?: boolean;
}) {
  const chipRef = useRef<HTMLElement | null>(null);
  const endedNote = surface.app
    ? "The agent finished with this app"
    : surface.phone
      ? "The agent finished with this phone"
      : surface.failed
        ? "This browser stopped working"
        : "This page was closed";
  const site = withSite && surface.site && surface.site !== surface.title ? surface.site : null;
  const siteFits = useSiteFits(chipRef, site, surface.title);
  const acting = surface.acting && !surface.ended;
  const tooltip = surface.ended
    ? endedNote
    : [surface.title, surface.site].filter(Boolean).join(" · ");
  const className = [
    "surface-chip",
    site ? "surface-chip--with-site" : "",
    surface.ended ? "surface-chip--ended" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      {surface.app ? (
        <AppMark
          identity={surface.app}
          machineId={
            surface.destination?.kind === "app"
              ? surface.destination.machineId
              : (surface.key.split(":")[1] ?? null)
          }
        />
      ) : surface.phone ? (
        <Icon name="phone" />
      ) : (
        <SiteMark favicon={surface.favicon ?? null} />
      )}
      <span className="surface-chip__title">{surface.title}</span>
      {acting ? <span aria-hidden className="live-dot" /> : null}
      {site ? (
        <span
          aria-hidden={!siteFits}
          className={
            siteFits ? "surface-chip__site" : "surface-chip__site surface-chip__site--dropped"
          }
        >
          {site}
        </span>
      ) : null}
    </>
  );
  const label = [
    surface.title,
    surface.site,
    surface.ended
      ? surface.app || surface.phone
        ? "finished"
        : surface.failed
          ? "stopped working"
          : "closed"
      : acting
        ? "agent working"
        : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <SurfaceLink
      className={className}
      destination={surface.ended ? null : surface.destination}
      elementRef={(node) => {
        chipRef.current = node;
      }}
      label={label}
      title={tooltip}
    >
      {body}
    </SurfaceLink>
  );
}

/**
 * Opens exactly this page, app or phone in the stage. With nowhere to go, an
 * ended place or a screen outside a Workspace, the same content stands as a
 * labelled image that opens nothing.
 */
export function SurfaceLink({
  children,
  className,
  destination,
  elementRef,
  label,
  title,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly destination: SurfaceDestination | null;
  readonly elementRef?: (node: HTMLElement | null) => void;
  readonly label: string;
  readonly title: string;
}) {
  const location = useLocation();
  const workspace = useOptionalWorkspace();
  if (!destination || !workspace) {
    return (
      <span aria-label={label} className={className} ref={elementRef} role="img" title={title}>
        {children}
      </span>
    );
  }
  return (
    <Link
      aria-label={`Open ${label}`}
      className={className}
      ref={elementRef}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        workspace.nav.showPlace(destination);
      }}
      title={title}
      to={{ pathname: location.pathname, search: workspace.nav.placeSearch(destination) }}
    >
      {children}
    </Link>
  );
}

const droppedSite = "surface-chip__site--dropped";

/**
 * Whether a chip's site fits beside its whole title. Where it does not, the
 * site goes, whole, rather than both being cut. Asked again whenever the room
 * changes, with the site put back for the measurement and taken out again
 * before anything is painted.
 */
function useSiteFits(
  chipRef: RefObject<HTMLElement | null>,
  site: string | null,
  title: string,
): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const chip = chipRef.current;
    const room = chip?.parentElement;
    if (!chip || !room || site === null) return;
    const measure = () => {
      const titleNode = chip.querySelector<HTMLElement>(".surface-chip__title");
      const siteNode = chip.querySelector<HTMLElement>(".surface-chip__site");
      if (!titleNode || !siteNode) return;
      const dropped = siteNode.classList.contains(droppedSite);
      if (dropped) siteNode.classList.remove(droppedSite);
      const next = titleNode.scrollWidth - titleNode.clientWidth <= 1;
      if (dropped) siteNode.classList.add(droppedSite);
      setFits(next);
    };
    measure();
    const stopResize = observeResize([room, chip], measure);
    return stopResize;
  }, [chipRef, site, title]);
  return fits;
}

/**
 * A reply's pages and apps in the order its Run first used them: the first
 * three, then how many more, listed on request. An agent acting in a hidden
 * one lights "+N"'s dot.
 */
export function SurfaceChips({
  label,
  surfaces,
}: {
  readonly label: string;
  readonly surfaces: readonly ChipSurface[];
}) {
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  if (surfaces.length === 0) return null;
  const shown = surfaces.slice(0, 3);
  const rest = surfaces.slice(3);
  const restActing = rest.some((surface) => surface.acting && !surface.ended);
  return (
    <div aria-label={label} className="surface-chips" role="group">
      {shown.map((surface) => (
        <SurfaceChip key={surface.key} surface={surface} />
      ))}
      {rest.length > 0 ? (
        <>
          <button
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={`${rest.length} more${restActing ? ", agent working" : ""}`}
            className="surface-chip surface-chip--more"
            onClick={() => setOpen((value) => !value)}
            ref={moreRef}
            type="button"
          >
            +{rest.length}
            {restActing ? <span aria-hidden className="live-dot" /> : null}
          </button>
          {open && moreRef.current ? (
            <Popover
              anchor={moreRef.current}
              className="popover--surfaces"
              label={label}
              onClose={() => setOpen(false)}
              role="dialog"
            >
              {/* Following a chip leaves the list behind it. */}
              <div className="surface-chips__list" onClick={() => setOpen(false)}>
                {rest.map((surface) => (
                  <SurfaceChip key={surface.key} surface={surface} withSite />
                ))}
              </div>
            </Popover>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
