import { useCallback } from "react";
import { useLocation } from "react-router";
import type { ReactNode } from "react";
import {
  threadMark,
  type HostClient,
  type HostSnapshot,
  type PlaceItem,
} from "@opensteer/client/host";
import { useAppView, useHostSelector } from "@opensteer/client/react";
import { AppFrame, AppLoadFailure, AppLoading, useAppTheme } from "../apps/app-frame.js";
import { Icon } from "../icon.js";
import { useToastToolbar } from "../toast.js";
import { placeEnded } from "./place-succession.js";
import { useTabCloser } from "./tab-closer.js";
import { conversationAt, type TaskDirectory } from "./task-directory.js";
import { TaskMark } from "./task-mark.js";
import { useWorkspace } from "./workspace-context.js";

export function AppTab({
  directory,
  hostClient,
  leading,
  place,
  selected,
  trailing,
}: {
  readonly directory: TaskDirectory;
  readonly hostClient: HostClient;
  readonly leading: ReactNode;
  readonly place: PlaceItem;
  readonly selected: boolean;
  readonly trailing: ReactNode;
}) {
  const appId = place.opensteerApp?.appId ?? "";
  const theme = useAppTheme();
  const { view, failed, retry } = useAppView(hostClient, appId, theme);
  return (
    <section
      aria-label={place.title}
      className="place place--opensteer-app"
      data-place-key={place.key}
      hidden={!selected}
    >
      {selected ? (
        <AppTabBar directory={directory} leading={leading} place={place} trailing={trailing} />
      ) : null}
      {view ? (
        <AppFrame
          fill
          key={view.url}
          retry={retry}
          theme={theme}
          title={place.title}
          url={view.url}
        />
      ) : failed ? (
        <AppLoadFailure fill retry={retry} />
      ) : (
        <AppLoading fill />
      )}
    </section>
  );
}

function AppTabBar({
  directory,
  leading,
  place,
  trailing,
}: {
  readonly directory: TaskDirectory;
  readonly leading: ReactNode;
  readonly place: PlaceItem;
  readonly trailing: ReactNode;
}) {
  const toolbarRef = useToastToolbar();
  const requestClose = useTabCloser();
  return (
    <header className="computer-watch__bar surface-row" ref={toolbarRef}>
      {leading}
      <span className="computer-watch__source">
        <span aria-hidden className="computer-watch__glyph">
          <Icon name="app" />
        </span>
        <span className="computer-watch__app">{place.title}</span>
      </span>
      <AppOrigin directory={directory} place={place} />
      <span className="computer-watch__spacer" />
      <button
        aria-label="Close tab"
        className="icon-btn"
        onClick={() => requestClose(place)}
        title="Close tab"
        type="button"
      >
        <Icon name="close" />
      </button>
      {trailing}
    </header>
  );
}

/** Only while another task is open: the bar's toggle already reaches the current one. */
function AppOrigin({
  directory,
  place,
}: {
  readonly directory: TaskDirectory;
  readonly place: PlaceItem;
}) {
  const { dock, nav, phone } = useWorkspace();
  const { pathname } = useLocation();
  const threadId = place.opensteerApp?.threadId;
  if (!threadId || conversationAt(pathname) === threadId) return null;
  const title =
    directory.rows.get(threadId)?.title ??
    directory.snapshot.threads.find((thread) => thread.id === threadId)?.title ??
    "Task";
  return (
    <button
      aria-label={`Go to the conversation that made this app: ${title}`}
      className="app-tab__origin"
      onClick={() => {
        nav.showPlaceWithConversation(place.destination, nav.threadPath(threadId));
        dock.show();
        if (!phone)
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>("[data-composer-input]")?.focus(),
          );
      }}
      title="Go to the conversation that made this app"
      type="button"
    >
      <TaskMark size={16} mark={threadMark(threadId, directory.snapshot)} />
      <span>{title}</span>
    </button>
  );
}

/** An address naming an app that is not open: a typed or old link, or Back to a closed tab. */
export function AppTabGone({
  destination,
  hostClient,
  leading,
  trailing,
}: {
  readonly destination: PlaceItem["destination"];
  readonly hostClient: HostClient;
  readonly leading: ReactNode;
  readonly trailing: ReactNode;
}) {
  const toolbarRef = useToastToolbar();
  const ended = useHostSelector(
    hostClient,
    useCallback((snapshot: HostSnapshot) => placeEnded(snapshot, destination), [destination]),
  );
  return (
    <>
      <div className="surface-row" ref={toolbarRef}>
        {leading}
        <span className="launcher__spacer" />
        {trailing}
      </div>
      {ended ? (
        <div className="place-state" role="status">
          <p className="place-state__title">This app isn’t open</p>
          <p className="place-state__detail">Open it from the conversation that made it.</p>
        </div>
      ) : (
        <AppLoading fill />
      )}
    </>
  );
}
