import type { DisplayClientDiagnostic } from "@opensteer/protocol";
import { NativeBrowserOverlay } from "./native-browser-overlays.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HostClient } from "@opensteer/client/host";
import {
  canStreamComputerDisplay,
  canWatchComputer,
  computerUseStop,
  computerUseStops,
  computerReadiness,
  computerWatchStatus,
  type ComputerWatchStatus,
  type WatchableComputerSession,
} from "@opensteer/client/integrations";
import { useComputerUseStop } from "@opensteer/client/react";
import { computerAppIdentityKey } from "@opensteer/integration-core/computer-app";
import type { ComputerAppIdentity, MachineSummary } from "@opensteer/protocol";
import { AppMark } from "./computer-apps/computer-use-section.js";
import { handleModalKeyDown } from "./dialog.js";
import { Icon } from "./icon.js";
import {
  PhoneControlBar,
  PhoneControlButton,
  ComputerDisplayScreen,
  useComputerDisplay,
} from "./phone-display.js";
import { SurfaceMenu, type SurfaceMenuItem } from "./surface-menu.js";
import { useToastToolbar } from "./toast.js";

export function ComputerWatchView({
  app = null,
  appKey,
  compact = false,
  marks = null,
  hostClient,
  hostConnected,
  leading = null,
  machineId,
  machines,
  onPictureRatio,
  sessionId,
  trailing = null,
  visible,
  hiddenReason,
}: {
  app?: ComputerAppIdentity | null | undefined;
  appKey: string | null;
  /** A tile: the picture and what it is waiting for, with nothing to press. */
  compact?: boolean;
  /** Who is working in it, after its name. */
  marks?: ReactNode;
  hostClient: HostClient;
  hostConnected: boolean;
  /** Placed first in the row, before the app: the way back to every page and app. */
  leading?: ReactNode;
  /** The Mac the address names, when it names one. */
  machineId: string | null;
  machines: readonly MachineSummary[];
  /** Told the shape of each picture shown, so a tile can take that shape. */
  onPictureRatio?: ((ratio: string) => void) | undefined;
  sessionId: string;
  /** Last in the row: the conversation's button while it is put away. */
  trailing?: ReactNode;
  /**
   * The view is open: the stage shows it, or its tile is in view. Hiding the
   * page pauses the picture in the client, which keeps the last one.
   */
  visible: boolean;
  hiddenReason?: DisplayClientDiagnostic["reason"] | undefined;
}) {
  const toolbarRef = useToastToolbar();
  const live = useMemo(
    () => watchableSession(machines, { appKey, machineId, sessionId }),
    [appKey, machineId, machines, sessionId],
  );
  const known = useRef<WatchableComputerSession | null>(null);
  if (live) known.current = live;
  const source = live ?? (known.current?.session.sessionId === sessionId ? known.current : null);
  const machine =
    machines.find((candidate) => candidate.id === (source?.machine.id ?? machineId)) ??
    source?.machine ??
    null;
  const phone = appKey === null;
  const machineName = machine?.name ?? (phone ? "your phone" : "your Mac");
  const shownApp =
    source?.session.apps.find((candidate) => computerAppIdentityKey(candidate) === appKey) ?? app;
  const windowTitle = source?.session.windows?.find((window) => window.appKey === appKey)?.title;
  const shownName = shownApp
    ? [shownApp.displayName, windowTitle].filter(Boolean).join(" — ")
    : null;
  const readiness = machine
    ? computerReadiness({ machine, phone, supported: canStreamComputerDisplay(machine) })
    : null;
  const stop = useComputerUseStop(hostClient, sessionId);
  const stopping = stop?.phase === "stopping" || stop?.phase === "stopped";
  const reading = visible && readiness === null && live !== null && !stopping;
  const display = useComputerDisplay({
    macWindow: !phone,
    enabled: reading,
    disabledReason: !visible
      ? (hiddenReason ?? "not-in-view")
      : stopping
        ? "stopping"
        : "unavailable",
    hostClient,
    source: live
      ? {
          kind: "task-session",
          sessionId: live.session.sessionId,
          ...(appKey === null ? {} : { appKey }),
        }
      : null,
    streamable: machine !== null && canStreamComputerDisplay(machine),
  });
  const status = computerWatchStatus({
    appName: shownApp?.displayName ?? null,
    displayed: display.picture !== null,
    live: live !== null,
    machineName,
    phone,
    readiness,
    reason: display.reason,
    retrying: display.retrying,
    startingWords: display.startingWords,
    stop,
  });
  const showing = reading && status?.clear !== true && display.picture !== null;
  const label = phone ? machineName : `${shownName ?? "App"} on ${machineName}`;
  const ratio =
    showing && display.picture ? `${display.picture.width} / ${display.picture.height}` : null;
  const reportRatio = useRef(onPictureRatio);
  reportRatio.current = onPictureRatio;
  useEffect(() => {
    if (ratio !== null) reportRatio.current?.(ratio);
  }, [ratio]);
  const [enlarged, setEnlarged] = useState(false);
  useEffect(() => {
    if (!visible) setEnlarged(false);
  }, [visible]);
  const canStop = live !== null && hostConnected && stop?.phase !== "stopped";
  const sendStop = () => {
    if (live)
      computerUseStops(hostClient).stop({
        machineName,
        runId: live.session.runId,
        sessionId: live.session.sessionId,
      });
  };
  const idle = phone ? { ...idleStatus, words: "Not using a phone right now" } : idleStatus;
  const controlling = phone && !compact && display.snapshot.control.state === "held";
  const screen = (onEnlarge: (() => void) | null) =>
    display.media ? (
      <ComputerDisplayScreen
        dim={status !== null}
        display={display}
        interactive={controlling && (!enlarged || onEnlarge === null)}
        label={label}
        onEnlarge={onEnlarge}
        shown={showing}
      />
    ) : null;
  const reopen = !phone && live !== null && display.snapshot.connection === "closed";
  const stage = (
    <div className="computer-watch__stage">
      {screen(compact ? null : () => setEnlarged(true))}
      <WatchStatusLine
        mark={
          compact && !showing ? (
            phone ? (
              <Icon name="phone" />
            ) : shownApp ? (
              <AppMark identity={shownApp} machineId={machineId} />
            ) : null
          ) : null
        }
        over={showing}
        status={source ? status : idle}
      />
      {reopen ? (
        <button className="btn btn--small" onClick={() => display.reopen()} type="button">
          Open again
        </button>
      ) : null}
    </div>
  );
  if (compact) return <section className="computer-watch computer-watch--compact">{stage}</section>;
  const menu: SurfaceMenuItem[] = showing
    ? [{ icon: "expand", label: "Enlarge", onSelect: () => setEnlarged(true) }]
    : [];
  const failure =
    stop?.phase === "failed" && live ? (
      <p className="computer-watch__failure" role="alert">
        Couldn’t stop. {stop.message}
      </p>
    ) : null;
  const names = (
    <WatchNames
      title={shownName}
      app={shownApp}
      machineId={machineId}
      machineName={machineName}
      phone={phone}
    />
  );
  const takeover = phone ? <PhoneControlButton display={display} phoneName={machineName} /> : null;
  const control = phone ? <PhoneControlBar display={display} /> : null;
  return (
    <section aria-label={label} className="computer-watch">
      <header className="computer-watch__bar surface-row" ref={toolbarRef}>
        {leading}
        {names}
        {marks}
        {source && status !== null && showing ? (
          <span className="computer-watch__state">{status.words}</span>
        ) : null}
        <span className="computer-watch__spacer" />
        {takeover}
        {canStop ? (
          <button
            aria-label={`Stop the agent using ${phone ? machineName : (shownApp?.displayName ?? "this app")}`}
            className="btn btn--small computer-watch__stop"
            disabled={stopping}
            onClick={sendStop}
            type="button"
          >
            {stopping ? computerUseStop.busyLabel : "Stop"}
          </button>
        ) : null}
        {menu.length ? (
          <SurfaceMenu items={menu} label={phone ? "Phone options" : "App options"} />
        ) : null}
        {trailing}
      </header>
      {failure}
      {stage}
      {control}
      {enlarged ? (
        <WatchTheater
          header={
            <header className="computer-watch__bar surface-row">
              {names}
              {takeover}
            </header>
          }
          failure={failure}
          footer={control}
          onClose={() => setEnlarged(false)}
          title={label}
        >
          {screen(null)}
          <WatchStatusLine over={showing} status={source ? status : idle} />
        </WatchTheater>
      ) : null}
    </section>
  );
}

/** The exact session and app named, while its Mac can show it. */
function watchableSession(
  machines: readonly MachineSummary[],
  target: {
    readonly appKey: string | null;
    readonly machineId: string | null;
    readonly sessionId: string;
  },
): WatchableComputerSession | null {
  for (const machine of machines) {
    if (target.machineId && machine.id !== target.machineId) continue;
    if (target.appKey === null ? machine.status !== "online" : !canWatchComputer(machine)) continue;
    const session = machine.computerUse?.sessions.find(
      (candidate) =>
        candidate.sessionId === target.sessionId &&
        (target.appKey === null
          ? candidate.display
          : !candidate.display &&
            candidate.apps.some(
              (candidateApp) => computerAppIdentityKey(candidateApp) === target.appKey,
            )),
    );
    if (session) return { machine, session };
  }
  return null;
}

/** Nothing this Thread has done on a Mac is left to show. */
const idleStatus: ComputerWatchStatus = {
  busy: false,
  clear: true,
  words: "Not using a Mac right now",
};

/** The app, then the Mac it is on, muted. Who is working there is the marks beside it. */
function WatchNames({
  title,
  app,
  machineId,
  machineName,
  phone,
}: {
  phone: boolean;
  title?: string | null;
  app: ComputerAppIdentity | null;
  machineId: string | null;
  machineName: string;
}) {
  return (
    <span className="computer-watch__source">
      {app ? (
        <AppMark identity={app} machineId={machineId} />
      ) : (
        <span aria-hidden className="computer-watch__glyph">
          <Icon name={phone ? "phone" : "laptop"} />
        </span>
      )}
      <span className="computer-watch__app">{title ?? app?.displayName ?? machineName}</span>
      {app ? <span className="computer-watch__place">{machineName}</span> : null}
    </span>
  );
}

function WatchStatusLine({
  mark = null,
  over,
  status,
}: {
  mark?: ReactNode;
  over: boolean;
  status: ComputerWatchStatus | null;
}) {
  return (
    <div
      aria-atomic="true"
      className={
        status === null
          ? "visually-hidden"
          : over
            ? "computer-watch__status computer-watch__status--over"
            : "computer-watch__status"
      }
      role="status"
    >
      {status ? (
        <>
          {mark ? (
            <span aria-hidden className="computer-watch__mark">
              {mark}
            </span>
          ) : null}
          {status.busy ? <span aria-hidden className="browser-waiting__spinner" /> : null}
          <span className="computer-watch__words">{status.words}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * The picture at the size of the window, for reading what the agent reads:
 * the same header and picture as the panel, over everything else. Escape or
 * the scrim puts it away, and focus returns to where it was.
 */
interface WatchTheaterProps {
  children: ReactNode;
  /** Why a Stop pressed here or in the panel did not happen. */
  failure: ReactNode;
  /** Under the picture: who controls a phone, and its navigation. */
  footer: ReactNode;
  header: ReactNode;
  onClose: () => void;
  title: string;
}
function WatchTheater(props: WatchTheaterProps) {
  return (
    <NativeBrowserOverlay>
      <WatchTheaterContent {...props} />
    </NativeBrowserOverlay>
  );
}
function WatchTheaterContent({
  children,
  failure,
  footer,
  header,
  onClose,
  title,
}: WatchTheaterProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    const opener = openerRef.current;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);
  return createPortal(
    <div
      className="watch-theater"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => handleModalKeyDown(event, panelRef.current, onClose)}
      role="presentation"
    >
      <div
        aria-label={title}
        aria-modal="true"
        className="watch-theater__panel"
        ref={panelRef}
        role="dialog"
      >
        <div className="watch-theater__head">
          {header}
          <button
            aria-label="Close enlarged picture"
            className="icon-btn"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>
        {failure}
        <div className="watch-theater__stage">{children}</div>
        {footer}
      </div>
    </div>,
    document.body,
  );
}
